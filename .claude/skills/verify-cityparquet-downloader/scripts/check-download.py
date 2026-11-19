"""Checks a downloaded file outside the browser, with native DuckDB and the community
cityjson extension: the objects it holds are exactly the selection's features, whole; the
CRS is kept; only the chosen LoDs and attributes are there.

  python3 -I check-download.py --file <download> --source <package URL> --table building \
      --ring '[[lon, lat], ...]' [--where "<SQL on the table's columns>"] \
      --lods 2.2 --attributes a,b,c

The expectation is computed here, from the source package, with SQL written by hand: the
rows the map draws (a LoD 0 footprint) whose footprint intersects the ring in EPSG:3857
(where the drawn edges are straight) and that pass --where, and every row sharing a
feature_id with one of them. Only the row groups whose footer extent overlaps the ring's
box are read, by file_row_number, so a national file is not scanned. A .zip is a
CityParquet package; .city.jsonl, .city.json and .fcb are read with the extension's readers.
Prints a JSON report and exits 1 when a check fails.
"""

import argparse
import json
import pathlib
import sys
import tempfile
import zipfile

import duckdb

p = argparse.ArgumentParser()
p.add_argument("--file", required=True)
p.add_argument("--source", required=True, help="the package directory URL")
p.add_argument("--table", default="building")
p.add_argument("--ring", required=True)
p.add_argument("--where", default="TRUE")
p.add_argument("--lods", required=True)
p.add_argument("--attributes", required=True)
args = p.parse_args()

ring = json.loads(args.ring)
lods = sorted(args.lods.split(","))
attributes = sorted(a for a in args.attributes.split(",") if a)
url = args.source.rstrip("/") + f"/{args.table}.parquet"

con = duckdb.connect()
for ext in ("httpfs", "spatial"):
    con.execute(f"INSTALL {ext}; LOAD {ext}")
con.execute("INSTALL cityjson FROM community; LOAD cityjson")

city = json.loads(
    con.execute(f"SELECT decode(value) FROM parquet_kv_metadata('{url}') WHERE decode(key) = 'city'").fetchone()[0]
)
crs_id = city["crs"]["id"]
code = str(crs_id["code"])
crs = f"{crs_id['authority']}:{code}"

closed = ring + ring[:1]
wkt = "POLYGON((" + ", ".join(f"{x} {y}" for x, y in closed) + "))"
area_3857 = f"ST_Transform(ST_GeomFromText('{wkt}'), 'EPSG:4326', 'EPSG:3857', always_xy := true)"
# The ring's box in the package CRS, widened by a tenth on each side (edges curve once
# transformed), for row-group pruning by footer statistics.
x0, y0, x1, y1 = con.execute(
    f"""SELECT ST_XMin(g), ST_YMin(g), ST_XMax(g), ST_YMax(g) FROM (
      SELECT ST_Transform(ST_GeomFromText('{wkt}'), 'EPSG:4326', '{crs}', always_xy := true) AS g)"""
).fetchone()
dx, dy = (x1 - x0) / 10, (y1 - y0) / 10
box = (x0 - dx, y0 - dy, x1 + dx, y1 + dy)
groups = con.execute(
    f"""SELECT row_group_id, any_value(row_group_num_rows),
      max(TRY_CAST(stats_min_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, xmin'),
      max(TRY_CAST(stats_min_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, ymin'),
      max(TRY_CAST(stats_max_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, xmax'),
      max(TRY_CAST(stats_max_value AS DOUBLE)) FILTER (path_in_schema = 'bbox, ymax')
    FROM parquet_metadata('{url}') GROUP BY 1 ORDER BY 1"""
).fetchall()
ranges, start = [], 0
for gid, rows, xmin, ymin, xmax, ymax in groups:
    if xmin <= box[2] and xmax >= box[0] and ymin <= box[3] and ymax >= box[1]:
        ranges.append((gid, start, start + rows))
    start += rows
# The row groups beside them too, so that a feature crossing a boundary is complete.
read = sorted({(lo, hi) for _, lo, hi in ranges} | {
    (s, s + n) for i, (_, n, *_) in enumerate(groups)
    for s in [sum(g[1] for g in groups[:i])]
    if any(abs(i - gid) == 1 for gid, _, _ in ranges)
})
in_range = " OR ".join(f"(file_row_number >= {lo} AND file_row_number < {hi})" for lo, hi in read)
con.execute(
    f"""CREATE TABLE rows AS SELECT * EXCLUDE (geometry_lod0_0), geometry_lod0_0 IS NOT NULL AS drawn,
      CASE WHEN geometry_lod0_0 IS NOT NULL THEN ST_Intersects(ST_Transform(ST_Force2D(geometry_lod0_0), '{crs}', 'EPSG:3857', always_xy := true), {area_3857}) END AS hit
    FROM read_parquet('{url}', file_row_number := true) WHERE {in_range}"""
)
seeds = {r[0] for r in con.execute(f"SELECT id FROM rows WHERE drawn AND hit AND ({args.where})").fetchall()}
expected = {
    r[0]
    for r in con.execute(
        f"""SELECT id FROM rows WHERE feature_id IN (
          SELECT feature_id FROM rows WHERE drawn AND hit AND ({args.where}))"""
    ).fetchall()
}

file = pathlib.Path(args.file)
report = {
    "file": str(file),
    "bytes": file.stat().st_size,
    "rowGroupsRead": [g for g, _, _ in ranges],
    "selected": len(seeds),
    "expected": len(expected),
}
if file.suffix == ".zip":
    tmp = tempfile.mkdtemp()
    zipfile.ZipFile(file).extractall(tmp)
    [folder] = list(pathlib.Path(tmp).iterdir())
    con.execute(f"PRAGMA cityparquet_read('{folder}', 'got')")
    relation = f"got.{args.table}"
    con.execute("PRAGMA cityparquet_validate('got')")
    report["validationErrors"] = con.execute(
        "SELECT count(*) FROM cityparquet_validation WHERE severity = 'error'"
    ).fetchone()[0]
    out_city = json.loads(
        con.execute(
            f"SELECT decode(value) FROM parquet_kv_metadata('{folder}/{args.table}.parquet') WHERE decode(key) = 'city'"
        ).fetchone()[0]
    )
    report["crs"] = f"{out_city['crs']['id']['authority']}:{out_city['crs']['id']['code']}"
    report["files"] = sorted(p.name for p in folder.iterdir())
else:
    reader, meta = {
        ".jsonl": ("read_cityjsonseq", "cityjsonseq_metadata"),
        ".json": ("read_cityjson", "cityjson_metadata"),
        ".fcb": ("read_flatcitybuf", "flatcitybuf_metadata"),
    }[file.suffix]
    relation = f"{reader}('{file}')"
    rs = con.execute(f"SELECT reference_system FROM {meta}('{file}')").fetchone()[0]
    report["crs"] = f"{rs['authority']}:{rs['code']}" if rs else None
got = {r[0] for r in con.execute(f"SELECT id FROM {relation}").fetchall()}
columns = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()]
source_attributes = {a for a in city.get("attributes", [])}
report["got"] = len(got)
report["missing"] = sorted(expected - got)[:5]
report["extra"] = sorted(got - expected)[:5]
report["lods"] = sorted(c[len("geometry_lod") :].replace("_", ".") for c in columns if c.startswith("geometry_lod"))
report["attributes"] = sorted(c for c in columns if c in source_attributes)
# CityJSON leaves out a null attribute, and its readers type the columns from the values
# present, so an attribute null in every downloaded object has no column there.
if file.suffix in (".json", ".jsonl"):
    attributes = [
        a
        for a in attributes
        if con.execute(
            f"""SELECT count("{a}") FROM rows WHERE feature_id IN (
              SELECT feature_id FROM rows WHERE drawn AND hit AND ({args.where}))"""
        ).fetchone()[0]
        > 0
    ]
checks = {
    "ids": got == expected,
    "featuresAddParts": len(expected) > len(seeds),
    "crs": report["crs"] in (crs, f"EPSG:{code}"),
    "lods": report["lods"] == lods,
    "attributes": report["attributes"] == attributes,
    "valid": report.get("validationErrors", 0) == 0,
}
report["checks"] = checks
print(json.dumps(report, indent=2))
sys.exit(0 if all(checks.values()) else 1)
