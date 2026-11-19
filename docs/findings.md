# Findings

Measured facts about duckdb-wasm `1.33.1-dev118.0` (DuckDB v2.0.0) in Chromium, which
the design depends on. Each entry says how it was measured, so it can be measured again.

## Opening the 14.4 GB 3DBAG file

**Works, footers only: 5.7 MB read in 9 range requests, 11 to 12 s from page load to the
summary, no memory that stands out from the app's baseline.** It needs the engine's
filesystem flags (below); without them the tab runs out of memory.

Measured with `node scripts/measure-open.mjs` (the real app, default source), three runs:

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Page load to summary | 11.0 s | 11.5 s | 11.9 s |
| Bytes received for `building.parquet` and `metadata.json` | 5,700,940 | 5,700,926 | 5,700,950 |
| Peak memory, browser and Node together | 1,376 MiB | 1,400 MiB | 1,444 MiB |

The same script on `fixtures/delft/` (1.3 MB) peaks at 1,376 MiB, so the 5.7 MB footer
adds nothing that stands out from run-to-run noise.

The requests, in order:

1. `GET metadata.json` (1.8 kB): the STAC Item names `building.parquet`.
2. `HEAD building.parquet` without a Range header: duckdb-wasm's existence check.
3. `HEAD building.parquet` with `Range: bytes=0-`: answered 206 with the size, so range
   reads are on.
4. Eight range GETs at the end of the file, each about 0.35 s: 16 kB, 64 kB and 181 kB,
   then 16 kB, 64 kB, 256 kB, 1 MB and 3.85 MB (the 5.68 MB footer, read with a
   doubling read-ahead).
5. Two more `HEAD` requests, for the later statements; the footer is not fetched again.

The DuckDB engine starts in about 4 s (33.7 MB of wasm, then the four extensions), so the
footer requests begin about 4.7 s after page load. Footer statements in the browser
(`CITYPARQUET_REMOTE=1 pnpm exec vp test run --project remote --silent=false`), one run:

| Statement | Time | What it reads |
| --- | --- | --- |
| `parquet_kv_metadata` (`city`, `geo`) | 5.3 s | the footer, over the network |
| `DESCRIBE SELECT * FROM read_parquet(…)` | 0.64 s | cached footer |
| `parquet_metadata`, aggregated per row group | 1.32 s | cached footer: 329 row groups × 229 leaf columns |
| all of it again, plus `ST_Transform` of the extent | 2.5 s | cached footer |

Results: 21,555,522 rows, 329 row groups, 88 columns of which 62 attributes, LoDs 0.0,
1.2, 1.3 and 2.2, WGS 84 extent 3.2572, 50.7347 to 7.2391, 53.5000 (lon, lat).

### Whole-file reads are the default

With `db.open({})` duckdb-wasm sends a `HEAD` without Range and then a `GET` without
Range: it downloads the whole file. For 3DBAG that is 14.4 GB into the tab, which is
what got the earlier probe killed. Seen through a logging reverse proxy in front of the
host, so the headers are the ones on the wire.

The engine opens with

```ts
filesystem: { forceFullHTTPReads: false, reliableHeadRequests: true, allowFullHTTPReads: false }
```

All three are needed: leaving out `forceFullHTTPReads: false` brings the whole-file read
back. With `allowFullHTTPReads: false` a server without range support is an error
(`Failed to open file`) rather than a download.

A test that reads a small remote file passes either way, since the whole file is small.
Only a large file, or the request log, shows the difference.

## `ST_Transform` in the wasm `spatial` build

**Works, from an EPSG code and from PROJJSON.** One point, 84500 447500 in RD New, gives
`POINT (4.360299313498277 52.01137928416956)` from `'EPSG:28992'`, from `'EPSG:7415'`
and from the horizontal component of the 3DBAG PROJJSON as text. Native DuckDB 2.0 gives
the same to 1e-14. The first call takes about 90 ms (PROJ starting), later ones about
40 ms.

- Neither the 3DBAG nor the Chuo-ku PROJJSON gives its horizontal component an `id`;
  only the compound CRS has one (EPSG:7415, EPSG:6697). The app passes the horizontal
  component as PROJJSON text, which needs no code lookup.
- Without `always_xy := true` DuckDB 2.0 refuses the call: `'ST_Transform' is sensitive to
  the coordinate axis order … In DuckDB v2.0, the 'geometry_always_xy' setting must be set
  explicitly`. With it, input and output are easting (longitude) first.
- That is also right for Chuo-ku: EPSG:6697 defines latitude first, but the files store x
  as longitude (139.78…) and y as latitude (35.68…). With `always_xy := true` the
  transform keeps them as they are.
- The extent the app computes for both fixtures matches the one native DuckDB computed
  when the fixtures were cut, to 1e-6 degrees (`tests/browser/package.test.ts`).
- `geometry_lod0_0` reads as `GEOMETRY('EPSG:7415')`: the Parquet GEOMETRY logical type
  is honoured. `ST_Force2D` and `ST_Transform` take it directly.

## `ST_AsMVT` and `ST_AsMVTGeom` in wasm

**Both exist and work** (`ST_AsMVT`: 5 overloads, aggregate; `ST_AsMVTGeom`: 4,
scalar). On `fixtures/delft/` in Chromium, one run:

| Step | Time | Result |
| --- | --- | --- |
| Local table: `id`, `object_type`, LoD0 footprint to EPSG:3857, from the fixture over HTTP | 210 ms | 373 footprints (`Building` rows; `BuildingPart` rows have no LoD0) |
| Tile z15 | 46 ms | 121 features, 9,055 bytes |
| Tile z16 | 25 ms | 121 features, 9,468 bytes |
| Tile z17 | 20 ms | 76 features, 6,176 bytes |

The app's tile (`tileSql`) is `ST_AsMVT` over `ST_AsMVTGeom(geom, envelope, 4096, 64)`,
with the rows chosen by their stored bounding box padded by the 64-unit buffer, in one
layer `features`. Over zero rows `ST_AsMVT` returns a small blob (a layer with no
features), not NULL. `tests/browser/map.test.ts` keeps this working.

## The map on 3DBAG

Measured with the verification skill, whose recorder logs every request the page and its
workers make, in headless Chromium (WebGL 2 through SwiftShader) in a 1440 by 900 window,
so the map is 1120 by 757 pixels.

### Zooming into Delft

From the fitted view (zoom 6.7), double-clicks at 4.357, 52.011 take the status through
329, 274, 138, 60, 28, 15 and 7 row groups in view, then to footprints at zoom 13.7, where
the view touches row groups 69, 70, 71 and 96: 131,009 features.

| | One run |
| --- | --- |
| Requests to the host | 12 range GETs, 21.06 MB |
| Per row group | 230 kB from `id` on, then 1 MB and 4 MB from the start of `geometry_lod0_0` |
| Chunk loads (read, transform to EPSG:3857, insert) | 3.7, 3.4, 2.7 and 4.5 s, one after another |
| First footprints | 4 to 5 s after the status switches |
| All footprints | 15.6 s after it (13.7 s in another run) |
| Zoom-13 tiles | 0.7 to 1.8 MB each, cut in 0.7 to 1.25 s, waiting up to 4.8 s behind a load |
| Tiles at 14, 15 and 16 (remote test) | 430 ms (550 kB), 209 ms, 60 to 73 ms |
| Local table | 42 MB for 131,009 rows, 17 MB of it geometry |
| Renderer process | 870 to 940 MB resident |
| Zooming out and back | no request, the same count at once (the cache) |

The loads run one after another: duckdb-wasm reads over HTTP with synchronous requests from
its one worker, so a second request never starts before the first ends. A tile waits for
the load that is running, even though tiles go before loads in the engine's queue.

Re-cutting the tiles in view after every load took the four loads to 21 s, since each
refresh costs about what a load does. The tiles are refreshed when the first row group in
view is ready and when the last is.

### Choosing rows by `file_row_number`

A row group is read with `read_parquet(…, file_row_number := true)` and
`WHERE file_row_number >= start AND file_row_number < start + rows`, which DuckDB prunes to
that row group alone. A predicate on `bbox` built from the row group's own statistics
matches its neighbours too: in native DuckDB it read 25 MB and 94,473 rows for row group
70, against 2.64 MB by row number.

`WHERE id = '…'` is worse still. In wasm DuckDB reads the `id` column of every row group to
find one row: 170 GETs, 37.8 MB, 77 s. The popup reads its row by row number, 4 GETs,
15.2 MB, 4.0 s, and checks the id it gets back.

### Read-ahead

duckdb-wasm reads a remote file through a buffer that doubles, 16 kB to 4 MB. A row group's
`geometry_lod0_0` is about 2 MB, so the second of its reads runs about 3 MB into
`geometry_lod1_2`: 5.3 MB on the wire for 2.3 MB of footprint columns. A popup's last read
(8.4 MB for row 4625167) runs 6.9 MB into the next row group, and fetches the geometry
bytes that lie between the attribute columns. Every read still starts inside the row
group it is for, and nothing near the whole file is fetched.

`SET disable_parquet_prefetching = true` makes it worse: 49 GETs, 24.2 MB and 33 s for
the Delft zoom. `prefetch_all_parquet_files` changes nothing. Both are left at their
defaults.

### Basemap

`basemaps.cartocdn.com` answers every request without an API key with a tile reading
"API key required"; `tile.openstreetmap.org` answers 403 from here. The default basemap is
therefore OpenFreeMap's `positron` and `dark` vector styles (no key; the two share sprite
and glyphs, so a theme switch is a style diff). With `VITE_CARTO_KEY` set at build time,
the basemap is CARTO's `light_all` and `dark_all` rasters with the key; that path has not
been seen working, for want of a key.

### MapLibre in this app

- MapLibre's stylesheet gives `.maplibregl-map` `position: relative`, which beats
  Tailwind's `absolute inset-0` on the same element: the container stays 0 pixels high.
  It is `h-full w-full` inside a positioned parent.
- Vite does not rewrite the worker's URL inside MapLibre; `setWorkerUrl` takes it from a
  `?url` import.
- MapLibre gives its canvas the role `region` named `Map`. A label on the container too
  would make two.
- Headless Chromium has WebGL 2 only through SwiftShader, with
  `--enable-unsafe-swiftshader`.
- `setStyle(style, { diff: true, transformStyle })` swaps the basemap and keeps the
  package's sources, their data and their layers.
- A double-click delivers two `click` events before `dblclick`. The popup waits 250 ms
  for a second click, so a zoom reads no attributes.
- Chuo-ku's one `Bridge` object has a bounding box spanning almost the whole package.
  Bbox rectangles are filled at a quarter of a footprint's opacity, and a click means a
  footprint before a rectangle and the smaller of two rectangles.

## Selection on 3DBAG

Measured with the verification skill (page timings from a `MutationObserver` on the
summary, bytes from its recorder) and with `tests/browser/remote/selection.test.ts`. The
area is the fixture tests' pentagon, about 250 by 250 metres of central Delft; its box
overlaps row groups 70, 71 and 96.

### The polygon test

The exact test runs on the footprints the map already holds: `ST_Intersects` of each
EPSG:3857 footprint with the drawn ring, which is straight in Web Mercator as drawn. The
alternative is the same test in the package CRS, on the footprint geometry read again.

| Over 3 row groups, 98,253 footprints | Time | Read |
| --- | --- | --- |
| Exact test in EPSG:3857 on the loaded footprints (count and `selection_rows`) | 146 ms (remote test); about 250 ms from Enter to the count on the page, after the 100 ms debounce | nothing |
| The same test in the package CRS, geometry read again (remote test) | 2.3 s | 3 row groups of `geometry_lod0_0` |
| An earlier probe, a 1.5 km pentagon over the same row groups | 82 ms against 2.8 to 4.7 s per row group read again | |

Threshold applied: keep the polygon if, once the footprints are loaded, the exact test
costs under one second and reads no extra geometry. It costs 0.15 s and reads nothing, so
the polygon stays; rectangles are not a fallback. Both tests select 198 footprints, and
native DuckDB on the fixture (`scripts/expect-selection.py`) selects the same 198.

### Filters

A filter's columns are read for the scope's row groups only, by `file_row_number`, into
one local table per row group, and kept while the map keeps the row group.

| Step | Time | Read |
| --- | --- | --- |
| `oorspronkelijkbouwjaar` for 3 row groups | 1.0 to 1.2 s each (remote test) | 3 GETs, 64 kB in all |
| `b3_pw_bron` for 3 row groups | 2.3 s on the page | 3 GETs, 23 kB |
| A column the grid had already read (`b3_dak_type`) | 250 ms from Apply to the count | nothing |
| Count after the columns are local | 66 to 180 ms | nothing |

Within the area, `oorspronkelijkbouwjaar < 1950` selects 123, and with
`OR b3_pw_bron contains hn4` 124; native DuckDB on the fixture gives the same.

### Limits

- An area's scope has no row limit. Each row group's footprints cost 2.4 to 3.0 s and
  about 5 MB to load, one after another, and stay in memory while selected: six take about
  20 s, and all 329 of 3DBAG (21.6 million rows, about 790 MB) would not fit the wasm heap.
- Without an area the scope is the row groups in view, whole: zoomed to central Delft
  that is 4 row groups, 131,009 features, although the view shows far fewer.
- A value box with a `list` attribute (the datalist of a text column's values) has the
  role `combobox`, not `textbox`.

## Downloads on 3DBAG

Measured with the verification skill: `control browser download` saves the file and
samples the resident memory of the run's Chromium every 250 ms, and the recorder counts
the bytes. Every file is then checked outside the browser by
`.claude/skills/verify-cityparquet-downloader/scripts/check-download.py`, which
recomputes the selection's whole features from the source package with native DuckDB
and compares ids, CRS, LoDs and attributes.

### Small selections

The fixture tests' pentagon in central Delft, over row groups 70, 71 and 96:

| Selection | Format, LoDs, attributes | Objects | File | Time | Read from the host |
| --- | --- | --- | --- | --- | --- |
| 196 buildings | CityJSON, LoD 2.2, all 62 | 392 | 1.1 MB | 11.4 s | 33.2 MB in 7 GETs |
| the same, next | FlatCityBuf, every LoD, all 62 | 392 | 1.0 MB | 7.6 s | 21.2 MB in 3 GETs |
| 122 buildings (`oorspronkelijkbouwjaar < 1950`) | CityJSONSeq, LoD 2.2, 3 | 244 | 542 kB | 7.8 s | 29.3 MB in 6 GETs |
| the same, next | CityParquet, LoD 2.2, 3 | 244 | 343 kB | 4.6 s | 2.7 kB, no GET |

Every file holds exactly the expected objects: each selected building with its
`BuildingPart` rows, in EPSG:7415. A download right after another reads only the columns
the first did not, which suggests duckdb-wasm keeps the ranges it read (inferred from the
requests, not from its code).

Cancelling while features are completed stops after the running row group (14 requests
and 1.6 MB after the click), and the next download runs normally.

### Memory and the size limit

Written at once from a table in memory, a download costs what the table shows. Views of
Delft taken as the area, every LoD and attribute, one fresh page each:

| Selected (objects) | Kept | Format | File | Time | Read | Largest process, before and peak |
| --- | --- | --- | --- | --- | --- | --- |
| 306 (616) | 394 kB | CityJSONSeq | 2.5 MB | 8.8 s | 54 MB | 1,235 and 1,492 MiB |
| 5,464 (10,934) | 6.8 MB | CityJSONSeq | 32.7 MB | 28.4 s | 83 MB | 1,283 and 1,744 MiB |
| 15,430 (30,886) | 19.3 MB | CityJSONSeq | 83.7 MB | 50.6 s | 133 MB | 1,383 and 2,402 MiB |
| 15,430 (30,886) | 19.3 MB | CityParquet | 38.1 MB | 46.0 s | 133 MB | 1,326 and 2,174 MiB |
| 15,430 (30,886) | 19.3 MB | CityJSON | 94.6 MB | 46.9 s | 133 MB | 1,485 and 3,019 MiB |

The largest process is the renderer, which holds the page and DuckDB's worker. A download
adds 45 (CityParquet) to 85 (CityJSON) times what it keeps, so at 19.3 MB CityJSON
reaches 3.0 GiB, and DuckDB's wasm heap cannot grow past 4 GiB.

So the rows are staged as Parquet files and written once from them. Staged in DuckDB's
memory file system, the four row groups in view at footprint zoom on Delft (131,009
buildings, 262,144 objects, 164 MB kept) end in `Out of Memory Error: Allocation
failure`. Staged on OPFS, with every LoD and attribute, one fresh page each:

| Kept | Format | Result |
| --- | --- | --- |
| 164 MB | CityJSONSeq | one 640 MB file of 131,010 lines in 244 s; largest process 4,894 MiB at its peak |
| 164 MB | CityParquet | a 258 MB package in 316 s; largest process 3,365 MiB at its peak |
| 164 MB | FlatCityBuf | `Out of Memory Error: Allocation failure` |
| 241 MB (425,691 buildings in scope, 13 row groups) | CityParquet | `cityparquet_write`: `failed to pin block … (1.3 GiB/1.3 GiB used)` |
| 241 MB, the same area | CityJSONSeq | `Out of Memory Error: Allocation failure` while writing, after 2 minutes of staging |
| 688 MB (24 row groups) | CityJSONSeq | `Out of Memory Error: Allocation failure` |

The guard (`exportSizeLimit`) therefore allows 170 MB kept for CityJSONSeq and CityParquet
on disk and 20 MB for everything else.

The CityJSONSeq writer's peak is above the wasm heap's 4 GiB, so part of it is outside
the heap; whether the writer or duckdb-wasm's file layer holds the output until the file
is closed is not known.

### OPFS in duckdb-wasm

- `opfs: { fileHandling: "auto" }` opens the `opfs://` files a statement names, for that
  statement. `COPY … TO`, `read_parquet`, `glob`, the `cityjson` writers and
  `cityparquet_write` to a directory all work on such paths; the files lie under
  `duckdb/fs/` in the origin private file system.
- A file is opened only when the statement names it. `cityparquet_read` of an `opfs://`
  directory fails (`the file exists but was not prepared before it`), and so does a later
  statement that needs a temp file an earlier one wrote: with `temp_directory` on OPFS, a
  table in memory that was evicted cannot be read back (seen at 688 MB as CityParquet).
  A sort that spills and reads back within one statement works.
- A path with a space is not opened for reading. Writing to one works.
- The defaults are `temp_directory = 'js_buffer://tmp'`, in the wasm heap, and
  `memory_limit = '3.1 GiB'` of a heap of 4 GiB. With them CityParquet at 164 MB kept
  ends in `Allocation failure`; with the temp directory on OPFS and 1.5 GB it is written.
- A database file on OPFS can be attached and written (`ATTACH 'opfs://…/x.db'`).

## What the writers need from the extension

Each of these is a gap in the `cityjson` extension (community build v0.5.0 for DuckDB
2.0.0), found in the browser and reproduced with native DuckDB. The app passes the
options that avoid it; the fix belongs upstream.

### `metadata_from` on a Parquet file writes no metadata

`COPY … TO 'out.city.json' (FORMAT cityjson, metadata_from 'building.parquet')` writes a
document with no `metadata` at all, so no `referenceSystem`. The CityJSON family is
written with `crs` instead (cjconv-core's `crsToUri` of the PROJJSON `id`), and its
`metadata` holds the reference system and nothing else from the source.

### `cityparquet_write` misreads a carried PROJJSON CRS

`PRAGMA cityparquet_read('fixtures/chuo-ku', 'p')` and then `cityparquet_write('p',
'out/')` write Chuo-ku's EPSG:6697 (JGD2011 + JGD2011 height) as EPSG:2011, NAD27(CGQ77) /
SCoPQ zone 5. With `crs => 'EPSG:6697'` the footer is right. The app always passes `crs
=> AUTH:CODE` to `cityparquet_write`.

### The vertex transform

The CityJSON writers default to scale 0.001 and translate 0. In degrees that is about
100 m: 50 Chuo-ku buildings, 328 vertices, come out with 4 distinct x values. Chuo-ku's
footer carries its source's transform (`city.other.transform`), scale `1e-9, 1e-9, 0.001`
with a translate whose first value is a latitude (35.51), while x is a longitude (139.78).
Used as is, x quantises to integers near 1.04e11. A CityJSON file still reads back; a
FlatCityBuf file is written without an error and reads back with `xmin` 36.71 instead of
139.78. The app passes the footer's scale and the data's minimum corner as
`transform_translate`.

### Writers that hold the whole output

`cityparquet_write` orders the whole table by a Hilbert key in one statement, and takes
only a schema of the default catalog whose tables are base tables: a view over staged
Parquet files is refused (`has no CityParquet object table`), and a schema of an attached
database is not found unless that database is the default. So a package is limited by
what one sort can pin (164 MB kept is written, 241 MB is not). The FlatCityBuf and
CityJSON writers build their output in memory. Each would go further if it wrote as it
read.

### Whole features

The extension has no read by feature. The rows of a feature are contiguous in its table,
but a row group of fixed size can cut one. The app reads `feature_id` for the scope's row
groups by `file_row_number`, keeps every row sharing one with a selected row, and reads
the row group beside one whose first or last row is wanted. `tests/browser/export.test.ts`
proves it on the fixture rewritten into 102 row groups, where 16 features cross a
boundary.

## Other facts later phases need

- `Engine.query` returns plain JSON. A BLOB (an MVT tile, a WKB geometry) comes back as an
  object with numeric keys, not a `Uint8Array`. `BrowserEngine.queryBytes` takes the first
  value of the Arrow result as bytes; use `octet_length` when only the size matters.
- In 3DBAG only `Building` rows carry `geometry_lod0_0`; `BuildingPart` rows do not.
  Chuo-ku's `bridge` table has no LoD0 column at all, so it falls back to `bbox`.
- `copyFileToBuffer` (`readFile`) on a path that does not exist returns one byte instead
  of throwing. Check `glob(…)` before reading a file back.
- The Vite dev server answers `Range: bytes=0-0` with the whole file (status 206). Byte
  counts measured against the fixtures through Vite say nothing about a real host.
- Playwright request interception (`page.route`, `context.route`) drops the Range
  header, so a routed duckdb-wasm read becomes a whole-file read. Observe with events.
- The footer extent is the union of row-group `bbox` statistics, transformed with the box
  edges densified. For 3DBAG it is slightly wider than the STAC Item's (north 53.5000
  against 53.4870), as a box around projected boxes is.
