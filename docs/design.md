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
| Hosting | Cloudflare Workers static assets, at most 25 MiB a file. The deploy build fetches `duckdb-base.wasm` from jsDelivr at the installed version (identical bytes, served with CORS, 7.4 MB compressed); the worker stays bundled. Single-threaded, so no COOP or COEP headers |
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

A table's selection is a scope and a predicate (`compileSelection`). It drives the map
highlight, the table and the download. Its rows are the rows the map draws: those with a
LoD 0 footprint, or, in a table without one, a `bbox`.

- Scope: the row groups the selection can hold. With an area, those whose WGS 84 outline
  overlaps the area's box, however many. Without one, the whole table when it has at most
  400,000 rows (`WHOLE_TABLE_ROWS`), else the row groups in view, and nothing while the
  map shows only row-group outlines. The scope's row groups stay loaded in the map's cache
  while it is selected, and the drawer counts them as they load.
- Area: a polygon (click the corners; double-click or Enter finishes, Escape cancels), a
  rectangle dragged on the map, or the current view. Its edges are straight in Web
  Mercator, as drawn, so the exact test is `ST_Intersects` with the footprints the map
  holds in EPSG:3857, and its vertices bound its box in WGS 84. No geometry is read again.
- Attribute filter: a filter bar over each table. A column, an operator its type allows
  (`kindOf`, `operatorsFor`), a value; conditions joined by AND or OR. A draft is edited
  and applied with Apply; the applied filter is shown as the SQL `WHERE` clause it
  compiles to. Text comparisons that match part of a value ignore case (`ILIKE`, with
  `%`, `_` and `\` escaped); "not equal" keeps nulls (`IS DISTINCT FROM`). A filter's
  columns are read for the scope's row groups by `file_row_number` into a local table per
  row group (`scope_attrs_<id>`), joined to the footprints on `__row`.
- Object types hidden in the legend are left out.
- Evaluated, the selection is written to `selection_rows (tbl, file, row)`: `file` is the
  position in the table's `files`, `row` the `file_row_number`. Tiles carry `sel` from a
  join on it, and the map dims what is not selected. The side panel shows, per table, the
  count; what a download reads and keeps is in the Download section.

### Table

A drawer below the map, with a handle to resize it, one tab per object table. Each tab
has the table's filter bar and a grid of its selection a page at a time (20, 50 or 100
rows), with the total. The grid reads only the columns shown (chosen in a columns panel,
by default `id`, `object_type` and the first eight attributes), and sorts on the engine,
nulls last. Each header shows the column's type. A row click marks its footprint and
brings it into view; a footprint click marks its row when it is on the page.

### Download

A Download section in the side panel writes the selection (`src/core/export.ts`,
`src/features/download/`).

- Formats: CityParquet (a package directory, zipped), CityJSON, CityJSONSeq, FlatCityBuf,
  and OBJ with its `.mtl` (zipped). An OBJ holds one LoD; a table without it is left out.
- LoDs: any subset the package has. Attributes: any subset per table, with search and
  select all or none. Reserved columns are kept (cjconv-core's column selection).
- Whole features: every row sharing a `feature_id` with a selected row is written, so a
  selected building brings its parts. A feature's rows are contiguous, so the `feature_id`
  column is read for the scope's row groups only, plus the row group beside one whose
  first or last row is wanted.
- Steps (`runExport`): snapshot `selection_rows`; complete the features; stage the chosen
  columns of those rows, one row group at a time by `file_row_number`; write with the
  `cityjson` extension: one `COPY … (FORMAT …)` over the staged files of every table,
  built with cjconv-core, or for a package the staged files as tables of a local schema
  named like a package, `cityparquet_init`, each table's source `city` footer restored
  (so CRS, transform and source metadata carry over) and `cityparquet_write`. The local
  schema and the files are dropped afterwards, whatever happened.
- Writer options the extension needs stated (findings.md): `crs => AUTH:CODE` for a
  package, `crs` for the file formats, the footer's transform scale with the data's
  minimum corner as translate for the CityJSON family.
- A run shows a progress bar, its step, the percentage (`exportFraction`) and the seconds
  it has taken, and can be cancelled between units of work. The panel shows what
  it reads (the chosen columns of the scope's row groups) and keeps (their selected
  share).
- A download is one file: the format's own file, or a zip of a package directory or of an
  OBJ with its `.mtl`. The wanted rows are staged one row group at a time as Parquet files
  (`stageSql`) and written once from them (`writeSql`). With the origin private file
  system (OPFS) the staged files, the output and what DuckDB spills
  (`temp_directory`, `memory_limit` 1.5 GB) are on disk, under
  `opfs://cityparquet-downloader`, emptied before each download and at start-up; the saved
  file is handed to the browser as it lies on disk. Without OPFS everything is in memory.
- A download that keeps more than its format's limit is refused, with its numbers
  (`exportSizeLimit`): 150 MB of compressed columns for CityJSONSeq and CityParquet on
  disk, 20 MB otherwise. The CityJSON, FlatCityBuf and OBJ writers hold the whole output
  in the wasm heap, which ends at 4 GiB; the refusal names the two formats that go
  further.
- Sidecars (`materials`, `textures`, `implicit_geometries`) are not written. Neither
  public package (3DBAG, Chuo-ku) has one.

### Coordinate systems

- The CRS comes from the `city` footer. For a compound CRS the horizontal part is used.
- Display: package CRS to WGS 84 and Web Mercator with `ST_Transform` (`spatial`).
- Selection: the drawn area is tested in Web Mercator, where its edges are straight.
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
