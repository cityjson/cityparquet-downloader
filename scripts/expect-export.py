"""Writes tests/browser/export.expected.json: for each download case, the ids a download of
the case's selection must hold, computed in native DuckDB with SQL written here by hand,
so the browser test checks the app's export against an answer it did not produce.

Timestamps are compared as microseconds since the epoch, dates and other
non-numbers as text.

A case starts from the ids a selection holds (tests/browser/selection.expected.json, the
rows the map draws). A download completes them to whole features: every row of the same
table with the same feature_id. Each case also records, read straight from the fixture,
the chosen attributes of the selected row that has the most of them set.

Run from the repository root: python3 -I scripts/expect-export.py (needs duckdb 2.0).
"""

import json
import pathlib

import duckdb

ROOT = pathlib.Path(__file__).resolve().parent.parent
SELECTION = json.loads((ROOT / "tests" / "browser" / "selection.expected.json").read_text())
OUT = ROOT / "tests" / "browser" / "export.expected.json"

con = duckdb.connect()

# name: (fixture directory, {table: (selection case, chosen attributes)})
CASES = {
    "delft area horizontal": (
        "delft",
        {
            "building": (
                "delft area horizontal",
                ["b3_h_dak_max", "oorspronkelijkbouwjaar", "b3_dak_type", "tijdstipregistratie"],
            )
        },
    ),
    "chuo-ku area, two tables": (
        "chuo-ku",
        {
            "building": ("chuo building area", ["measuredHeight", "usage", "大字・町コード", "storeysAboveGround"]),
            "bridge": ("chuo bridge area", ["class", "function", "creationDate"]),
        },
    ),
}


def quote(values):
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


def comparable(column, type):
    """A value both sides read the same way: timestamps as microseconds, other non-numbers as text."""
    if type.startswith("TIMESTAMP"):
        return f'epoch_us("{column}")'
    if type in ("BIGINT", "INTEGER", "DOUBLE", "FLOAT", "BOOLEAN", "VARCHAR"):
        return f'"{column}"'
    return f'CAST("{column}" AS VARCHAR)'


def plain(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


out = {}
# Chuo-ku's buildings are features of one row; its bridge and Delft's buildings have parts.
for name, (fixture, tables) in CASES.items():
    case = {"fixture": f"/fixtures/{fixture}/", "tables": {}}
    for table, (selection, attributes) in tables.items():
        path = str(ROOT / "fixtures" / fixture / f"{table}.parquet")
        seeds = SELECTION["cases"][selection]
        rows = con.execute(
            f"""SELECT id FROM read_parquet('{path}')
            WHERE id IN ({quote(seeds)})
               OR feature_id IN (SELECT feature_id FROM read_parquet('{path}') WHERE id IN ({quote(seeds)}))
            ORDER BY id"""
        ).fetchall()
        ids = [r[0] for r in rows]
        types = dict(con.execute(f"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet('{path}'))").fetchall())
        cols = ", ".join(comparable(a, types[a]) for a in attributes)
        # The selected row with the most of the chosen attributes set, so the sample proves something.
        filled = " + ".join(f'("{a}" IS NOT NULL)::INTEGER' for a in attributes)
        sample_id, *values = con.execute(
            f"SELECT id, {cols} FROM read_parquet('{path}') WHERE id IN ({quote(seeds)}) ORDER BY {filled} DESC, id LIMIT 1"
        ).fetchall()[0]
        # An OBJ holds one LoD, so only the objects with geometry there.
        lods = sorted(
            c[len("geometry_lod") :].replace("_", ".") for c in types if c.startswith("geometry_lod")
        )
        lod_ids = {
            lod: [
                r[0]
                for r in con.execute(
                    f"""SELECT id FROM read_parquet('{path}') WHERE id IN ({quote(ids)})
                    AND "geometry_lod{lod.replace('.', '_')}" IS NOT NULL ORDER BY id"""
                ).fetchall()
            ]
            for lod in lods
        }
        case["tables"][table] = {
            "seeds": seeds,
            "ids": ids,
            "lodIds": lod_ids,
            "attributes": attributes,
            "sample": {"id": sample_id, "values": {a: plain(v) for a, v in zip(attributes, values)}},
        }
        print(f"{name} / {table}: {len(seeds)} selected, {len(ids)} in whole features")
    out[name] = case

OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(f"wrote {OUT.relative_to(ROOT)}")
