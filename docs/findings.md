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

Each tile is
`ST_AsMVT({id, object_type, geom: ST_AsMVTGeom(g, ST_Extent(ST_TileEnvelope(z, x, y)))}, 'building')`
over the rows that `ST_Intersects` the tile envelope. `tests/browser/spatial.test.ts`
keeps this working.

## Other facts later phases need

- `Engine.query` returns plain JSON. A BLOB (an MVT tile, a WKB geometry) comes back as an
  object with numeric keys, not a `Uint8Array`. Tiles need a binary path from the Arrow
  result, or `octet_length` when only the size matters.
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
