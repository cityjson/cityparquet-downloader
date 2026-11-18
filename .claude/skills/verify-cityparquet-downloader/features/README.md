# CityParquet downloader verification map

The maintained list of what a user can do in the app and how to prove each thing works.
Read this index, then the file of the feature you are verifying. `control` is
`node .claude/skills/verify-cityparquet-downloader/scripts/control.mjs`.

## Baseline preconditions

- `pnpm install` has been run and the network is reachable.
- `control launch` succeeded and `control doctor` passes. Without `--source` the page
  opens `fixtures/delft/`.
- `control browser goto` followed by `control browser wait --text "is ready" --timeout 90000`
  has returned: DuckDB is started.
- Never drive an instance this run did not launch.

## Driving conventions

- Start each recipe from a fresh `control browser goto`, unless it says otherwise. A
  reload is the only reset there is.
- Target by role and visible text, not by CSS or position.
- Commands are literal. Keep quoted names unchanged.
- Wait for the element that shows the result, never for a fixed time.

## Proof and skip reporting

- Capture the action and the resulting state.
- UI proof is an ARIA snapshot and a screenshot with the heading visible.
- Put each artifact under `<feature>/<step>` and name the feature id in the report.
- If a step cannot be reached, report the command tried and the unmet precondition.
- A path that was skipped is not verified by proving a different one.

## Feature entry contract

Each feature file has an H1 and one paragraph on the user-visible behaviour, then
exactly these H2 sections in this order: `Sub-features`, `How to get to it (user POV)`,
`Driving it with control`, `Gotchas`. No implementation details: only user paths, stable
handles, required state, commands and observable proof.

## Features

- [Start the app](./startup.md) covers the page loading and DuckDB starting with its extensions.
- [Open a package](./open-package.md) covers opening the configured package and its summary.

Each new user-facing feature adds a file here in the same change that adds the feature.
