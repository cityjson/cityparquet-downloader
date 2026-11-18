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
(`CITYPARQUET_REMOTE=1 pnpm exec vitest run --project remote --silent=false`), one run:

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
