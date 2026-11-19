# Commands for the CityParquet downloader. `just` lists them.

control := "node .claude/skills/verify-cityparquet-downloader/scripts/control.mjs"

default:
    @just --list

# Install the dependencies (pnpm, as pinned in package.json).
install:
    pnpm install --frozen-lockfile

# Dev server on http://localhost:5173/. Set VITE_CITYPARQUET_URL to open another package.
dev:
    pnpm exec vite

# Type check, then the production build into dist/.
build:
    pnpm exec tsc --noEmit
    pnpm exec vite build

# The build Cloudflare serves: the engine's wasm from jsDelivr, every file under 25 MiB.
build-deploy:
    pnpm exec tsc --noEmit
    VITE_DUCKDB_CDN=1 pnpm exec vite build
    node scripts/check-asset-sizes.mjs dist

# Deploy to Cloudflare Workers (wrangler.jsonc). Needs `wrangler login` or CLOUDFLARE_API_TOKEN.
deploy: build-deploy
    pnpm dlx wrangler@4.157.0 deploy

# Format check, lint and type check. Changes nothing.
check:
    pnpm exec biome ci .
    pnpm exec tsc --noEmit

# Format and apply safe lint fixes in place.
fmt:
    pnpm exec biome check --write .

# Unit tests of src/core, in Node.
test:
    pnpm exec vitest run --project unit

# Browser tests: real duckdb-wasm in Chromium, against fixtures/ served by Vite.
test-browser:
    pnpm exec vitest run --project browser

# Opt-in browser tests against the public packages on cityparquet.open3d.city.
test-remote:
    CITYPARQUET_REMOTE=1 pnpm exec vitest run --project remote

# Regenerate fixtures/ from the public packages (needs Python duckdb 2.0 and the network).
fixture:
    python3 -I scripts/make-fixture.py

# The verification helper: `just verify launch`, `just verify browser goto`, ….
verify *args:
    {{control}} {{args}}
