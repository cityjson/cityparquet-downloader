# Design

What the app is, how it works, and the facts the design rests on.

## Goal

A browser application that opens any CityParquet package by URL, shows its footprints on
a map, lets the user choose a subset by drawing an extent, by attribute filters, or both,
and downloads only that subset in the format, levels of detail and attributes the user
chooses.

- General: 3DBAG is the default and the test dataset, and nothing 3DBAG-specific is in
  the code. Column names, LoDs, attributes and the CRS are read from the package.
- Serverless: DuckDB (wasm) reads the package in place with HTTP range requests. The app
  is static files.
- Experimental: pre-release dependencies are fine.

## The one rule

This repository contains no format readers or writers. The app inspects, generates SQL
and moves bytes. Parsing and serialisation belong to the `cityjson` DuckDB extension
(function reference: `docs/FUNCTIONS.md` in cityjson/duckdb-cityjson). Export SQL comes
from `@cityjson/cjconv-core`. If a download needs something the extension cannot do,
record it in `docs/findings.md`; do not work around it here.

## Measured facts

| Fact | Value |
| --- | --- |
| duckdb-wasm | `1.33.1-dev118.0` embeds DuckDB v2.0.0. Bundles are `duckdb-base.wasm` (33.7 MB) and `duckdb-browser-base.worker.js`. Extension platform `wasm_eh` |
| Extensions with v2.0.0 wasm builds | `cityjson` and `three_d` (community), `spatial` and `parquet` (core) |
| `httpfs` in wasm | Must not be loaded: range reads then fail with an ETag error. The built-in HTTP of duckdb-wasm works |
| `cityparquet_read` | Refuses an HTTP URL. Use `read_parquet`, `parquet_kv_metadata` and `parquet_metadata` |
| 3DBAG `building.parquet` | 14.4 GB, 21.6 million rows, 329 row groups of 65,536 rows, 88 columns, 5.7 MB footer |
| Row groups | Hilbert ordered, median extent 9 by 12 km. A 1 km box touches 3 of 329 |
| Column sizes | `geometry_lod0_0` is 713 MB in total, about 2.2 MB per row group. All columns: about 43 MB per row group |
| Extents | `bbox` is a struct of `xmin, ymin, zmin, xmax, ymax, zmax`. Its footer statistics (`path_in_schema` `bbox, xmin` and so on in `parquet_metadata`) give the extent of each row group with no data read |
| CRS | PROJJSON under `crs` in the `city` footer key. 3DBAG: Amersfoort / RD New + NAP height, a compound CRS |
| Chuo-ku `building.parquet` | 72 MB, one row group, WGS 84 based. A second public package for testing |

## Specification

### Source

- The package location is the build-time variable `VITE_CITYPARQUET_URL`. Default:
  `https://cityparquet.open3d.city/data/3dbag/`.
- Three forms resolve to a set of object tables, each of one or more files:
  - a directory URL: read `metadata.json` (STAC Item; its assets name the files), else
    probe the file names the specification fixes (`building`, `bridge`, `tunnel`,
    `construction`, `transportation`, `vegetation`, `relief`, `water_body`, `land_use`,
    `city_furniture`, `generics`, each `.parquet`);
  - a single `.parquet` URL: a package of one table;
  - a wildcard such as `…/**/building.parquet` (Hive partitioning): the files of one
    table are read together. Over plain HTTP a wildcard cannot be listed, so the files
    come from `metadata.json` when it names them; otherwise the app says it cannot
    expand the pattern.
- Each object table stays its own table.
- On open, only footers are read. Per table: CRS, LoDs (`geometry_lod*` columns),
  attribute columns with types, row count, extents per file and row group.
- The package extent is the union of all bounding boxes. It is transformed to WGS 84
  and the camera flies to it.

### Map

- MapLibre GL JS, full window beside a side panel that folds away. Basemap: OpenFreeMap's
  `positron` for the light theme and `dark` for the dark one, vector tiles on OSM data.
  With `VITE_CARTO_KEY` at build time it is CARTO's `light_all` and `dark_all` rasters
  instead, which need the key. The theme follows the system until the user switches it.
- The camera fits the package's WGS 84 extent once it opens.
- Footprints come from the lowest LoD0 geometry column. A table without one falls back
  to `bbox` rectangles, filled faintly.
- Two regimes, chosen by the row groups the view touches:
  1. overview, while the view touches more than 4 row groups and more than 20,000 rows:
     row-group outlines from footer statistics, shaded by rows per square degree;
  2. footprints otherwise: each touched row group's `id`, `feature_id`, `object_type` and
     footprint are read into the local table `map_features`, in EPSG:3857, once, chosen
     by `file_row_number`. A bounded cache (600,000 rows) evicts the least recently used
     row group out of view. MapLibre asks for vector tiles through `addProtocol`; each
     tile is an `ST_AsMVT` query on the local table.
- One DuckDB connection serves everything through a priority queue: interactive reads
  first, then tiles, then row-group loads. A tile or load for a view the map has left is
  called off before it starts.
- Clicking a footprint opens a panel with its attributes, read for that one row by its
  row number; geometry, appearance and `bbox` columns are left out.
- A legend lists every table, and under each the city object types its loaded
  footprints have, each with a colour and a toggle. Hidden types are left out of the
  selection too (`hiddenIn`).

Measurements on 3DBAG are in [findings.md](findings.md).

### Selection

One predicate, with two parts joined by AND. It drives the map highlight, the table and
the download.

- Extent: the user draws a polygon. It is densified, transformed to the package CRS,
  and applied as a `bbox` overlap test on its bounding box (so statistics prune row
  groups), then an exact intersection with the footprint. If the exact test is too slow
  in wasm, selection falls back to rectangles.
- Attribute filter: a filter bar over the table. Column, an operator that suits the
  column type, a value; conditions joined by AND or OR. It compiles to a SQL `WHERE`
  clause, which is shown. A filter belongs to one table.
- The app shows the number of selected features and an estimate of the bytes to read.

### Table

A paginated grid of the features in view or selected, one tab per object table, with
column show and hide and sorting.

### Download

- Formats: CityParquet (zip), CityJSON, CityJSONSeq, FlatCityBuf, OBJ (zip).
- LoDs: any subset the package has. Attributes: any subset; reserved columns are kept.
- Selected rows and chosen columns are read from the remote files into a local schema,
  the footer metadata is restored, and the `cityjson` extension writes the output.
- Whole features: children and parents of selected objects are included by `feature_id`.
- Sidecars (`materials`, `textures`, `implicit_geometries`) are filtered to referenced rows.
- A guard refuses a selection whose estimated size will not fit in browser memory.

### Coordinate systems

- The CRS comes from the `city` footer. For a compound CRS the horizontal part is used.
- Display: package CRS to WGS 84 and Web Mercator with `ST_Transform` (`spatial`).
- Selection: the drawn WGS 84 polygon is densified before it is transformed.
- No CRS, or an unknown one: the app asks for an EPSG code. It never guesses.

### Out of scope

3D rendering, editing, local file upload, private buckets, saved sessions.

## Structure

```
src/core/        pure TypeScript: no React, no DuckDB, no browser API. Unit tested.
src/engine/      duckdb-wasm: boot, extensions, file I/O
src/features/    source, map, table, filter, download (React)
src/components/  shadcn/ui
tests/unit       core
tests/browser    generated SQL against real duckdb-wasm and the fixture
fixtures/        a small Delft subset of 3DBAG as a CityParquet package
```

`features` use `core` and `engine`. `core` imports from neither.

## Verification

- Unit tests for `src/core`, written first.
- Browser tests run the generated SQL in real duckdb-wasm against `fixtures/`.
- A downloaded subset is read back: same ids as the selection, complete features, CRS kept.
- The `verify-cityparquet-downloader` skill drives the real page. Each user-facing
  feature has a file in its feature map, added in the same change as the feature.
