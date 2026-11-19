"""Writes tests/browser/selection.expected.json: the ids each selection case selects in the
fixtures, computed in native DuckDB with SQL written here by hand, so the browser test
checks the app's generated SQL against an answer it did not produce.

Run from the repository root: python3 -I scripts/expect-selection.py (needs duckdb 2.0).

A selection holds the rows the map draws: those with a LoD 0 footprint, or, in a table
without one, a bbox. The area test is ST_Intersects in EPSG:3857, where the drawn edges
are straight. As a cross-check, each area case is also run in the package CRS with the
area's edges densified, and the script fails if the two answers differ.
"""

import json
import pathlib

import duckdb

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "browser" / "selection.expected.json"

DELFT = str(ROOT / "fixtures" / "delft" / "building.parquet")
CHUO_BUILDING = str(ROOT / "fixtures" / "chuo-ku" / "building.parquet")
CHUO_BRIDGE = str(ROOT / "fixtures" / "chuo-ku" / "bridge.parquet")

DELFT_AREA = [(4.3595, 52.0092), (4.3620, 52.0089), (4.3627, 52.0103), (4.3610, 52.0111), (4.3593, 52.0104)]
CHUO_AREA = [(139.7850, 35.6800), (139.7880, 35.6802), (139.7862, 35.6830)]

con = duckdb.connect()
con.sql("INSTALL spatial; LOAD spatial")


def ring_wkt(ring):
    closed = ring + ring[:1]
    return "POLYGON((" + ", ".join(f"{x} {y}" for x, y in closed) + "))"


def densified_wkt(ring, steps=64):
    closed = ring + ring[:1]
    points = []
    for (x0, y0), (x1, y1) in zip(closed, closed[1:]):
        points += [(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps) for i in range(steps)]
    return ring_wkt(points)


def mercator_area(ring):
    return (
        f"ST_Transform(ST_GeomFromText('{ring_wkt(ring)}'), 'EPSG:4326', 'EPSG:3857', always_xy := true)"
    )


def ids(path, where, footprint):
    rows = con.sql(f"SELECT id FROM read_parquet('{path}') WHERE {footprint} IS NOT NULL AND ({where}) ORDER BY id").fetchall()
    return [r[0] for r in rows]


def area_in_mercator(footprint, crs, ring):
    return (
        f"ST_Intersects(ST_Transform({footprint}, '{crs}', 'EPSG:3857', always_xy := true), "
        f"{mercator_area(ring)})"
    )


def area_in_package_crs(footprint, crs, ring):
    # Edges densified in Web Mercator, then taken to the package CRS.
    merc = con.sql(
        f"SELECT ST_AsText({mercator_area(ring)}) AS w"
    ).fetchall()[0][0]
    coords = [tuple(map(float, p.split())) for p in merc[merc.index("((") + 2 : -2].split(", ")][:-1]
    dense = densified_wkt(coords)
    return (
        f"ST_Intersects({footprint}, ST_Transform(ST_GeomFromText('{dense}'), 'EPSG:3857', '{crs}', always_xy := true))"
    )


LOD0 = "geometry_lod0_0"
BOX = "ST_MakeEnvelope(bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax)"

cases = {}

# Attribute filters on Delft.
cases["delft slanted before 1950"] = ids(DELFT, "b3_dak_type = 'slanted' AND oorspronkelijkbouwjaar < 1950", LOD0)
cases["delft horizontal or taller than 20 m"] = ids(DELFT, "b3_dak_type = 'horizontal' OR b3_h_dak_max > 20", LOD0)
cases["delft storeys not 3"] = ids(DELFT, "b3_bouwlagen IS DISTINCT FROM 3", LOD0)
cases["delft storeys below 3"] = ids(DELFT, "b3_bouwlagen < 3", LOD0)
cases["delft pw source contains HN4"] = ids(DELFT, "b3_pw_bron ILIKE '%hn4%'", LOD0)

# An area on Delft, alone and with a filter.
delft_area = area_in_mercator(LOD0, "EPSG:28992", DELFT_AREA)
cases["delft area"] = ids(DELFT, delft_area, LOD0)
cases["delft area horizontal"] = ids(DELFT, f"{delft_area} AND b3_dak_type = 'horizontal'", LOD0)
assert cases["delft area"] == ids(DELFT, area_in_package_crs(LOD0, "EPSG:28992", DELFT_AREA), LOD0)

# Two tables on Chuo-ku: a filter on buildings, an area on bridges (bbox rectangles).
cases["chuo building usage 401 or 402"] = ids(CHUO_BUILDING, "usage IN ('401', '402')", LOD0)
chuo_bridge_area = area_in_mercator(BOX, "EPSG:6668", CHUO_AREA)
cases["chuo bridge area"] = ids(CHUO_BRIDGE, chuo_bridge_area, "bbox")
cases["chuo bridge area without Bridge"] = ids(CHUO_BRIDGE, f"{chuo_bridge_area} AND object_type <> 'Bridge'", "bbox")
assert cases["chuo bridge area"] == ids(CHUO_BRIDGE, area_in_package_crs(BOX, "EPSG:6668", CHUO_AREA), "bbox")
cases["chuo building area"] = ids(CHUO_BUILDING, area_in_mercator(LOD0, "EPSG:6668", CHUO_AREA), LOD0)

for name, found in cases.items():
    assert found, f"{name} selects nothing: the case proves nothing"
    print(f"{name}: {len(found)}")

OUT.write_text(
    json.dumps({"areas": {"delft": DELFT_AREA, "chuo-ku": CHUO_AREA}, "cases": cases}, indent=1) + "\n"
)
print(f"wrote {OUT.relative_to(ROOT)}")
