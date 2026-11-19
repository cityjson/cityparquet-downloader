#!/usr/bin/env python3
"""Cut the test fixtures in fixtures/ from public CityParquet packages.

    python3 scripts/make-fixture.py            # writes fixtures/delft and fixtures/chuo-ku

Needs the Python `duckdb` package at the DuckDB version the app embeds (2.0) and the
network. Each fixture is a valid CityParquet package: the source schema unchanged
(the Parquet GEOMETRY logical type included), the source `city` and `geo` footer keys
carried over, rows in source (Hilbert) order, small row groups so that row-group pruning
can be tested, whole features only, and a STAC Item `metadata.json` naming the files.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys

import duckdb

ROOT = pathlib.Path(__file__).resolve().parent.parent / "fixtures"
ROW_GROUP_ROWS = 100

# name -> (source package, tables, box in the package CRS as xmin, ymin, xmax, ymax)
FIXTURES = {
    # Delft, the old town around the Markt, in Amersfoort / RD New.
    "delft": (
        "https://cityparquet.open3d.city/data/3dbag/",
        ["building"],
        (84400.0, 447200.0, 84700.0, 447500.0),
    ),
    # Chuo-ku, Tokyo, around Nihonbashi: buildings and bridges, in JGD2011 (lon, lat).
    "chuo-ku": (
        "https://cityparquet.open3d.city/data/plateau/chuo-ku/",
        ["building", "bridge"],
        (139.7845, 35.6795, 139.7895, 35.6845),
    ),
}


def lit(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def overlaps(box: tuple[float, float, float, float]) -> str:
    x0, y0, x1, y1 = box
    return f"bbox.xmin <= {x1} AND bbox.xmax >= {x0} AND bbox.ymin <= {y1} AND bbox.ymax >= {y0}"


def footer(con: duckdb.DuckDBPyConnection, url: str) -> dict[str, str]:
    rows = con.execute(
        f"SELECT decode(key), decode(value) FROM parquet_kv_metadata({lit(url)})"
    ).fetchall()
    return {k: v for k, v in rows if k in ("city", "geo")}


def cut_table(con: duckdb.DuckDBPyConnection, url: str, out: pathlib.Path, box) -> int:
    # Whole features: a feature is taken when its root object overlaps the box, and then
    # with every object that shares its feature_id. Parts sit next to their root in a
    # Hilbert-ordered file, so the second read is bounded by a widened box, which keeps
    # row-group pruning on the remote file.
    x0, y0, x1, y1 = box
    pad = max(x1 - x0, y1 - y0)
    wide = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
    con.execute(
        f"""CREATE OR REPLACE TEMP TABLE cut AS
        SELECT * EXCLUDE (file_row_number) FROM (
          SELECT * FROM read_parquet({lit(url)}, file_row_number := true)
          WHERE {overlaps(wide)}
            AND feature_id IN (
              SELECT feature_id FROM read_parquet({lit(url)})
              WHERE {overlaps(box)} AND (parents IS NULL OR len(parents) = 0))
          ORDER BY file_row_number)"""
    )
    missing = con.execute(
        """SELECT count(*) FROM (
             SELECT unnest(children) AS ref FROM cut
             UNION ALL SELECT unnest(parents) FROM cut)
           WHERE ref NOT IN (SELECT id FROM cut)"""
    ).fetchone()[0]
    if missing:
        sys.exit(f"{url}: {missing} parent/child references point outside the cut")

    kv = footer(con, url)
    for key, value in kv.items():
        con.execute(f"SET VARIABLE {key} = {lit(value)}")
    pairs = ", ".join(f"{key}: getvariable('{key}')" for key in kv)
    # GEOPARQUET_VERSION 'NONE': the source's own `geo` key is the one written, not one
    # DuckDB would derive from the GEOMETRY column (Parquet allows duplicate keys).
    # ROW_GROUP_SIZE rounds up to DuckDB's 2,048-row vectors, so the row-group size is
    # steered by ROW_GROUP_SIZE_BYTES instead, rescaled until a group holds about
    # ROW_GROUP_ROWS rows.
    budget = 1 << 20
    for _ in range(6):
        con.execute(
            f"""COPY cut TO {lit(str(out))} (FORMAT PARQUET, ROW_GROUP_SIZE_BYTES {budget},
            COMPRESSION ZSTD, GEOPARQUET_VERSION 'NONE', KV_METADATA {{{pairs}}})"""
        )
        median = con.execute(
            "SELECT median(n) FROM (SELECT DISTINCT row_group_id, row_group_num_rows n "
            f"FROM parquet_metadata({lit(str(out))}))"
        ).fetchone()[0]
        if abs(median - ROW_GROUP_ROWS) <= ROW_GROUP_ROWS // 4:
            break
        budget = int(budget * ROW_GROUP_ROWS / median)
    check(con, url, out)
    return con.execute("SELECT count(*) FROM cut").fetchone()[0]


def check(con: duckdb.DuckDBPyConnection, src: str, out: pathlib.Path) -> None:
    # The schema as DuckDB reads it: names, order and types, GEOMETRY included. The
    # physical encoding differs by writer (parquet-rs names list elements `item`).
    schema = "SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet({}))"
    a = con.execute(schema.format(lit(src))).fetchall()
    b = con.execute(schema.format(lit(str(out)))).fetchall()
    if a != b:
        sys.exit(f"{out}: the schema differs from {src}")
    keys = con.execute(
        f"SELECT decode(key) k, count(*) FROM parquet_kv_metadata({lit(str(out))}) "
        "WHERE decode(key) IN ('city', 'geo') GROUP BY k ORDER BY k"
    ).fetchall()
    if [k for k, n in keys if n != 1] or footer(con, str(out)) != footer(con, src):
        sys.exit(f"{out}: the city/geo footer keys are not the source's, exactly once each")


def extent_wgs84(con: duckdb.DuckDBPyConnection, files: list[pathlib.Path], crs: str):
    paths = "[" + ", ".join(lit(str(f)) for f in files) + "]"
    x0, y0, x1, y1 = con.execute(
        f"SELECT min(bbox.xmin), min(bbox.ymin), max(bbox.xmax), max(bbox.ymax) "
        f"FROM read_parquet({paths})"
    ).fetchone()
    lon0, lat0, lon1, lat1 = con.execute(
        f"""WITH b AS (SELECT ST_Transform(ST_MakeEnvelope({x0}, {y0}, {x1}, {y1}),
                   {lit(crs)}, 'EPSG:4326', always_xy := true) AS g)
        SELECT ST_XMin(g), ST_YMin(g), ST_XMax(g), ST_YMax(g) FROM b"""
    ).fetchone()
    return [round(v, 7) for v in (lon0, lat0, lon1, lat1)]


def stac_item(name: str, src: str, when: str, files: list[pathlib.Path], bbox) -> dict:
    lon0, lat0, lon1, lat1 = bbox
    ring = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
    assets = {}
    for f in files:
        data = f.read_bytes()
        assets[f.name] = {
            "href": f"./{f.name}",
            "type": "application/vnd.apache.parquet",
            "roles": ["data", "cityparquet-objects"],
            "file:size": len(data),
            # A multihash: 0x12 (sha2-256), 0x20 (32 bytes), then the digest.
            "file:checksum": "1220" + hashlib.sha256(data).hexdigest(),
        }
    return {
        "type": "Feature",
        "stac_version": "1.1.0",
        "stac_extensions": ["https://stac-extensions.github.io/file/v2.1.0/schema.json"],
        "id": f"{name}-fixture",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "bbox": bbox,
        "properties": {
            "datetime": when,
            "title": f"{name} test fixture, cut from {src}",
        },
        "links": [{"rel": "derived_from", "href": src}],
        "assets": assets,
    }


def main() -> None:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial")
    con.execute("SET memory_limit = '1500MB'; SET threads = 2")
    for name, (src, tables, box) in FIXTURES.items():
        out_dir = ROOT / name
        out_dir.mkdir(parents=True, exist_ok=True)
        files, rows = [], 0
        for table in tables:
            out = out_dir / f"{table}.parquet"
            n = cut_table(con, f"{src}{table}.parquet", out, box)
            print(f"{out.relative_to(ROOT.parent)}: {n} rows, {out.stat().st_size} bytes")
            files.append(out)
            rows += n
        city = json.loads(footer(con, str(files[0]))["city"])
        crs_id = city["crs"]["id"]
        bbox = extent_wgs84(con, files, f"{crs_id['authority']}:{crs_id['code']}")
        source_item = con.execute(f"SELECT content FROM read_text({lit(src + 'metadata.json')})")
        when = json.loads(source_item.fetchone()[0])["properties"]["datetime"]
        item = stac_item(name, src, when, files, bbox)
        (out_dir / "metadata.json").write_text(json.dumps(item, indent=2) + "\n")


if __name__ == "__main__":
    main()
