# cityparquet-downloader

A browser app that opens a CityParquet package by URL and downloads a chosen subset.
Spec and measured facts: [docs/design.md](docs/design.md). Browser findings:
[docs/findings.md](docs/findings.md).

## The one rule

This repository contains no format readers or writers. The app inspects, generates SQL
and moves bytes. Parsing and serialisation belong to the `cityjson` DuckDB extension
(reference: `docs/FUNCTIONS.md` in cityjson/duckdb-cityjson); export SQL comes from
`@cityjson/cjconv-core`. If something needs the extension to do more, record it in
`docs/findings.md`. Do not work around it here.

## Commands

```sh
just install        # pnpm install --frozen-lockfile
just dev            # dev server; VITE_CITYPARQUET_URL=… opens another package
just check          # Biome format + lint, tsc. Changes nothing
just fmt            # Biome, writing
just test           # unit tests (src/core, Node)
just test-browser   # real duckdb-wasm in Chromium, against fixtures/ served by Vite
just test-remote    # opt-in: the public packages on cityparquet.open3d.city
just build          # tsc, then vite build into dist/
just build-deploy   # the Cloudflare build: wasm from jsDelivr, every file under 25 MiB
just deploy         # build-deploy, then wrangler deploy (needs Cloudflare credentials)
just fixture        # regenerate fixtures/ (Python duckdb 2.0, network)
node scripts/measure-open.mjs [url]   # requests, bytes, time and memory of opening a package
```

Browser tests and verification need Chromium: set `CHROMIUM_PATH` to an installed one, or
run `pnpm exec playwright install chromium`. Run `just check && just test && just
test-browser && just build` before calling work done.

## Structure

```
src/core/       pure TypeScript: source, footer, crs, plan, package; chunk, cache, tile,
                features (map SQL), colour; filter, selection; export. Unit tested
src/engine/     duckdb-wasm: boot, extensions, file I/O; session.ts is the app's one engine
                and its priority queue (`withEngine`)
src/features/   React features: source (opening a package), map (map, footprints, legend,
                popup), selection (area, store, summary), table (drawer, grid, filter bar),
                download (panel, store: format, LoDs, attributes, run, size guard)
src/components/ shadcn/ui
tests/unit      src/core          tests/browser   SQL against real duckdb-wasm
fixtures/       small packages cut by scripts/make-fixture.py; never edit by hand
```

## Invariants

- `src/core` imports nothing from React, DuckDB, `src/engine`, `src/features` or browser
  globals (`window`, `fetch`, …). Biome enforces it. It takes an `Engine` and a `Fetch`.
- `src/engine/duckdb.ts` is the only code that imports `@duckdb/duckdb-wasm`.
- `@duckdb/duckdb-wasm` is pinned exactly (`1.33.1-dev118.0`): the extension builds
  follow its DuckDB version. Never a caret range.
- Dev and tests bundle `duckdb-base.wasm`; the deploy build (`VITE_DUCKDB_CDN=1`) takes it
  from jsDelivr at the installed version, because Cloudflare serves no file over 25 MiB.
  The worker is always bundled. Never load the wasm of another version.
- Never load `httpfs`: in wasm it breaks range reads. duckdb-wasm's own HTTP reads files.
- The engine opens with `forceFullHTTPReads: false, reliableHeadRequests: true,
  allowFullHTTPReads: false`. Without all three, remote files are read whole.
- Opening a package reads footers only. Never `SELECT *` or a full-column scan on a remote
  table; the national file is 14.4 GB.
- `ST_Transform` always passes `always_xy := true`.
- Values reach SQL only through `src/core/sql.ts` (`lit`, `ident`, `num`, `sql`).
- Read a remote row group, or one row, by `file_row_number`, never by `id` or a `bbox`
  predicate: in wasm `id = …` reads the `id` column of every row group (findings.md).
- Every engine call from the app goes through `withEngine`; long reads are `background`,
  so tiles and clicks are not stuck behind them.
- Write tests first for `src/core`. Keep only tests that prove something a user or a
  later phase relies on. Remote-host tests go in `tests/browser/remote/`.

## Verification

The `verify-cityparquet-downloader` skill (`.claude/skills/`) drives the real page. Each
user-facing feature has a file in its `features/` map, added in the same change as the
feature, and the skill is run for it before the work is called done.

## Conventions

- British English in prose. Document the present, never history.
- `AGENTS.md` is byte-identical to this file: edit one, copy it to the other.
- Branches: `develop` integrates; `main` releases.
