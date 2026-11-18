# cityparquet-downloader

A web application for downloading any area of a
[CityParquet](https://github.com/cityjson/cityparquet) package as CityParquet. It runs
entirely in the browser: DuckDB (through duckdb-wasm) reads the package in place over HTTP
and writes the selected part, so no server is needed.

It is not tied to one dataset. Any CityParquet package can be the source.

## Stack

- TypeScript and React, built with Vite. Node 26.
- `@duckdb/duckdb-wasm` embedding DuckDB 2.0, single-threaded bundle, so the app can be
  served from any static host.
- The [`cityjson`](https://github.com/cityjson/duckdb-cityjson) and
  [`three_d`](https://github.com/cityjson/duckdb-3d) DuckDB extensions, as the signed
  community builds for the embedded DuckDB version.

The `@duckdb/duckdb-wasm` version is pinned exactly: the extensions are built per DuckDB
version, so the pin decides which extension builds are loaded.

## Commands

```sh
pnpm install
pnpm dev          # dev server → http://localhost:5173/
pnpm typecheck
pnpm test         # browser tests; they need the network
pnpm build
```

The tests run in Chromium through Playwright. Install it once with
`pnpm exec playwright install chromium`, or set `CHROMIUM_PATH` to an installed Chromium.

## Layout

```
src/engine/duckdb.ts   boots duckdb-wasm and loads the extensions; the only DuckDB code
src/App.tsx            the application
tests/browser/         tests that run the engine in a real browser
```
