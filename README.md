# cityparquet-downloader

A web page that opens a [CityParquet](https://github.com/cityjson/cityparquet) package
and downloads a part of it. It runs in the browser. DuckDB, through duckdb-wasm, reads the
package in place over HTTP and writes the selected part, so no server is needed.

Any CityParquet package can be the source. The user selects features by drawing an area
on the map, by filtering attributes, or both. The selection downloads as a CityParquet
package, CityJSON, CityJSONSeq, FlatCityBuf or OBJ, with the chosen levels of detail and
attributes. A selected building comes with all its parts. The `cityjson` extension writes
every format.

## Stack

- TypeScript and React, built with Vite; Tailwind 4 with shadcn/ui, Zustand. Node 26,
  pnpm, Biome.
- `@duckdb/duckdb-wasm` embedding DuckDB 2.0, single-threaded bundle, so the app can be
  served from any static host.
- The [`cityjson`](https://github.com/cityjson/duckdb-cityjson) and
  [`three_d`](https://github.com/cityjson/duckdb-3d) DuckDB extensions, as the signed
  community builds for the embedded DuckDB version, with the core `parquet` and
  `spatial` extensions.

The `@duckdb/duckdb-wasm` version is pinned exactly. The extensions are built per DuckDB
version, so the pin decides which extension builds are loaded.

## Source

The package is the build-time variable `VITE_CITYPARQUET_URL`, by default
`https://cityparquet.open3d.city/data/3dbag/`. It can be one of three things:

- a package directory, whose `metadata.json` names the files; without one, the app tries
  the file names the specification fixes,
- a single `.parquet` file,
- a wildcard such as `…/**/building.parquet`, which `metadata.json` expands.

A relative URL resolves against the page, so
`VITE_CITYPARQUET_URL=/fixtures/delft/ just dev` opens the bundled fixture.

The basemap is OpenFreeMap's, which needs no key. With `VITE_CARTO_KEY` set at build time
it is CARTO's Positron and Dark Matter instead.

## Commands

[`just`](https://just.systems) runs everything; `just` alone lists the recipes.

```sh
just install        # dependencies
just dev            # dev server on http://localhost:5173/
just check          # format, lint, type check
just test           # unit tests
just test-browser   # browser tests against fixtures/
just build          # production build into dist/
just build-deploy   # the build Cloudflare serves, checked against its size limit
```

The browser tests run in Chromium through Playwright. Install it once with
`pnpm exec playwright install chromium`, or set `CHROMIUM_PATH` to an installed Chromium.
They fetch the DuckDB extensions from their hosts; the data comes from `fixtures/`.

## Deploy

The app is static files, served by Cloudflare Workers as static assets (`wrangler.jsonc`,
worker `cityparquet-downloader`). Workers serve at most 25 MiB per file and the engine's
`duckdb-base.wasm` is 33.7 MB, so `just build-deploy` builds with `VITE_DUCKDB_CDN=1`.
That build fetches the wasm from jsDelivr at the installed duckdb-wasm version, and
`scripts/check-asset-sizes.mjs` fails the build if any file in `dist/` is over 25 MiB.
The engine is single-threaded, so the site needs no COOP or COEP headers.

`.github/workflows/deploy.yml` deploys on every push to `main`, and by hand. It needs the
repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; without them it
builds, checks and skips the deploy with a notice. `VITE_CITYPARQUET_URL` and
`VITE_CARTO_KEY` are build-time variables, read from the repository variables of the
same names; unset, the defaults apply. With credentials of your own, `just deploy` does
the same from a checkout.

## Layout

```
src/core/       pure TypeScript: package source, footers, CRS, row-group plans, selection,
                export
src/engine/     duckdb-wasm: boots it, loads the extensions; the only DuckDB code
src/features/   the application, one folder per feature: source, map, selection, table,
                download
tests/unit/     src/core
tests/browser/  real duckdb-wasm against fixtures/; remote/ is opt-in
fixtures/       small CityParquet packages, cut by scripts/make-fixture.py
docs/           design and measured findings
```
