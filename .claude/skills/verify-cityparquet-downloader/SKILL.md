---
name: verify-cityparquet-downloader
description: Drive the CityParquet downloader web app (React + duckdb-wasm, in the browser) the way a user does and capture proof. Use to prove a change works in the real app, to reproduce a UI bug, or whenever tests pass but you have not seen the page do it.
---

# Verify the CityParquet downloader

The app is one web page: a full-window map with a side panel. A user opens it, DuckDB
starts in the browser and loads its extensions, the app opens one CityParquet package
(fixed at build time by `VITE_CITYPARQUET_URL`), summarises its tables in the panel and
fits the map to it. Zoomed in far enough, the map reads and draws footprints; clicking
one shows its attributes. There is no backend, no login and no stored data: all state is
in the browser tab.

Everything here goes through one helper, run from the repository root:

```sh
node .claude/skills/verify-cityparquet-downloader/scripts/control.mjs <command>
```

Below it is written as `control`. It needs `pnpm install` to have been run, Node 26, and
the network (the page fetches the DuckDB extensions; with `--source` a remote package
too).
If Playwright's own Chromium is not installed, set `CHROMIUM_PATH` to a Chromium binary
before `launch` (in Claude Code cloud sessions: `/opt/pw-browsers/chromium`).

Read [features/README.md](features/README.md) before driving: it is the map of what
there is to verify and the exact steps for each feature.

## Launch

```sh
control launch                                   # opens fixtures/delft/, served by Vite
control launch --source https://cityparquet.open3d.city/data/3dbag/   # the national file
```

`--source` is the package the page opens, passed to the dev server as
`VITE_CITYPARQUET_URL`. It defaults to `/fixtures/delft/`, the fixture in the repository,
so verification needs neither the 14 GB national file nor its host. Any directory,
`.parquet` file or wildcard URL works; a relative one resolves against the page.

`launch` starts three things and records their pids and the source in
`.verify/runs/default/state.json`:

- the Vite dev server on a free port of `127.0.0.1` (log: `.verify/runs/default/vite.log`),
- a headless Chromium with its own empty profile (log: `chromium.log`), 1440 by 900, with
  `--enable-unsafe-swiftshader`: there is no GPU, and the map needs WebGL 2, which
  SwiftShader provides,
- a network recorder connected to that Chromium, which logs every request the page and
  its workers make to `network.jsonl` (log: `recorder.log`).

It prints the URL and returns once all three answer. That is not yet "usable": the page is
usable when DuckDB has started and the package is open. Wait for it on the page itself:

```sh
control browser goto
control browser wait --text "is ready" --timeout 90000
control browser wait --role table --name Tables --timeout 120000
```

The first start downloads about 34 MB of wasm plus the extensions, so allow a minute.
If the text `DuckDB did not start` appears instead (role `alert`), the app is broken or
the network is blocked; read it with `control browser text --role alert`. If `Could not
open the package` appears (role `alert`), the source is wrong or unreachable.

`launch` refuses to start a second copy of the same run. For a second instance side by
side, name it: add `--run other` to every command. Runs do not share ports, profiles or
evidence.

## Doctor

```sh
control doctor
```

Read-only. It prints the package the run opens, and checks that the three processes this
run started are alive, that the port serves this app (by its title), that Chromium answers,
and that the checkout is still on the ref it was launched from. Run it first whenever something looks off. Exit code 1
means do not trust what you see: `control cleanup`, then `control launch`.

## Drive

Each `control browser` call connects to the running Chromium, does one thing on the
page, and disconnects. The page keeps its state between calls.

| Command | Does |
| --- | --- |
| `control browser goto [--path /]` | Loads the app (a reload resets all state) |
| `control browser click --role button --name "…"` | Clicks |
| `control browser click --x 750 --y 391 [--count 2]` | Clicks a page pixel, such as a footprint on the map; `--count 2` double-clicks, which zooms the map in one level around it |
| `control browser hover --x … --y …` | Moves the mouse there |
| `control browser wheel --x … --y … --dy -300` | Scrolls there: negative zooms the map in |
| `control browser map-view` | Prints the map's zoom, centre and bounds |
| `control browser map-at --lon 4.357 --lat 52.011` | Prints the page pixel of a point, for `click`, `hover` and `wheel` |
| `control browser map-feature --id <id>` | Prints a page pixel inside that feature's drawn footprint |
| `control browser drag --x … --y … --to-x … --to-y … [--steps 10]` | Presses, moves and releases the mouse, such as a rectangle on the map |
| `control browser select --role combobox --name "…" --value …` | Chooses an option of a select by its value |
| `control browser fill --role textbox --name "…" --value "…"` | Types into a field |
| `control browser press --key Enter` | Presses a key |
| `control browser wait --text "…" [--timeout ms]` | Waits until it is visible |
| `control browser text --role status` | Prints the element's text |
| `control browser eval --js "document.title"` | Runs read-only JavaScript, prints JSON |
| `control browser snapshot [--path name.aria.txt]` | Saves the URL, title and ARIA tree |
| `control browser screenshot [--path name.png]` | Saves a screenshot |
| `control browser download --role button --name Download --exact true [--path folder]` | Clicks, saves the file the page downloads into the evidence directory, prints its size, the seconds and the peak resident memory of the run's Chromium |
| `control browser memory` | Prints the resident memory of the run's Chromium now |

Targets are `--role` with an optional `--name`, `--label`, `--text` or `--testid`.
Prefer roles and visible text. The page's stable handles today:

- heading `CityParquet downloader`, in the region `Side panel`, with the button
  `Dark theme` (or `Light theme`); the button `Hide panel` (or `Show panel`) over the map,
- role `status`: `Starting DuckDB…`, then `DuckDB v… is ready.`, whose title lists the
  loaded extensions (`Extensions: …`),
- role `status`: `Opening <package URL>…` while the package opens,
- heading `Package`, the source URL and `Extent (WGS 84 longitude, latitude): …` (test id
  `package-extent`), then role `table` named `Tables`, one row per object table,
- role `alert`: `DuckDB did not start: …` or `Could not open the package`,
- region `Map` (MapLibre's canvas), with the buttons `Zoom in` and `Zoom out` and an
  unnamed group holding the basemap's credit links,
- heading `View` and the status line with test id `map-status`: `Overview: N row groups,
  M features in view` or `Footprints: N features`, with `, loading k of n row groups`
  while reads run,
- heading `Legend`, a checkbox `<table> table` per table and `<Type> in <table>` per
  object type,
- role `dialog` named `Feature attributes` with the table `Attributes` and the button
  `Close`.
- toolbar `Area` over the map: `Draw polygon`, `Draw rectangle` (both `aria-pressed`), `Use
  current view`, `Clear area`; while drawing, a `status` hint with `Finish` and `Cancel`,
- heading `Selection`: test id `selection-area` (`Area: drawn, N corners.` or `Area: none.
  …`) and per table a `status` with test id `selection-<table>`: `N of M features
  selected.`,
- region `Download`: combobox `Format`, checkboxes `LoD <l>` (for OBJ the radio group
  `Level of detail`), per table the button `Attributes of <table>` (a popup with `Search
  attributes`, `Select all`, `Select none` and checkboxes `Download <attribute>`) and test
  id `download-<table>`, the textbox `File name`, test ids `download-estimate` and
  `download-problem` (role `alert`), the button `Download` (or `Cancel download`), then
  test id `download-progress` while it runs and `download-result` after,
- region `Feature table` below the map: heading `Features`, the separator `Resize the
  table`, the tab list `Tables` with one tab per table, `Hide table` (or `Show table`);
  per tab the test id `table-scope`, the button `Columns` (`Columns N of M`), the region
  `Filter <table>` and the grid: header buttons `Sort by <column>`, one `row` per feature
  named from its id, and the navigation `Pages` with `Rows per page`, test id
  `page-range` (`1–20 of N`), `Previous page` and `Next page`,
- in the filter bar: `Add condition`, per row `Column of condition N` (a popup with the
  textbox `Search columns` and the listbox `Columns`), `Operator of condition N`, `Value
  of condition N`, `Second value of condition N`, `Remove condition N`; then `Match`,
  `Apply filter`, `Clear filter`, `SQL` and, under it, test id `filter-sql` and `Copy SQL`.

`map-view` and `map-at` read `window.__map`, and `eval --js "window.__mapLogs"` reads
how long each tile query and footprint read took; both exist in the dev server only.

A `status` or `alert` element has no accessible name, so wait for its text with
`--text`, not with `--role status --name`.

Use `eval` only to read. Changing the page through it is not a user action and proves
nothing.

## Network

```sh
control network mark                       # start counting from now
control network summary [--host <name>]    # requests, GETs and bytes per host since the mark
```

`summary` also lists every `.parquet` GET with its `Range` header, status and bytes, so a
step's reads can be checked against the row groups it should touch. Byte counts against
the fixtures say little: the dev server is local. Measure against the real host.

## Evidence

Everything lands in `.verify/evidence/<run>/` (git-ignored). A proof contains:

- the action and the resulting state, not only the last screen: snapshot or screenshot
  before and after the step that matters;
- an ARIA snapshot and a screenshot in which the app heading is visible;
- for anything the page claims about data (a count, an extent, a version), a second
  reading that does not come from the same element, for example another view of the
  page or the file the app produced;
- for a download, the downloaded file itself, opened and checked, not the "done" message.

Drive the real path: click and type as a user would. Do not call application functions
through `eval`, and do not replace the DuckDB engine or the network with a mock. The
extensions are fetched from their real hosts; the data from the fixture or the
`--source` host.

Name files after the feature and step, for example `--path startup/ready.png`.

## Cleanup

```sh
control cleanup
```

Stops exactly the three process groups this run started (by the recorded pids, never by
name) and removes `.verify/runs/<run>/`, including the browser profile. It keeps
`.verify/evidence/<run>/`. Run it after every attempt, failed ones included.

## Helpers

- `scripts/control.mjs` drives the page. Its commands are the ones above; all take
  `--run <name>`. `control launch --preview` serves the production build in `dist/`
  (`just build` first) instead of the dev server; its package is the one fixed at build
  time, and `window.__map` does not exist there.
- `scripts/check-download.py` checks a downloaded file outside the browser, with native
  DuckDB (Python `duckdb` 2.0 and the network): see [features/download.md](features/download.md).
