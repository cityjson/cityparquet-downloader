# Start the app

Opening the page starts DuckDB in the browser and loads the extensions the app works
with. The user sees a short starting message, then a line stating the DuckDB version and
the loaded extensions, or an error that says why it did not start.

## Sub-features

- `startup-progress` shows that DuckDB is starting.
- `startup-ready` reports the DuckDB version and the loaded extensions.
- `startup-extensions` includes `cityjson`, `three_d` and `parquet` among them.
- `startup-reload` reaches the ready state again after a reload.

## How to get to it (user POV)

- Open the app's URL in a browser.
- Reload the page.

## Driving it with control

Preconditions:

- `control doctor` passes.

- **Open.** Load the page. Run `control browser goto`. The heading `CityParquet downloader` is present.
- **Ready.** Wait for DuckDB. Run `control browser wait --text "is ready" --timeout 90000`. It prints `visible`.
- **Version and extensions.** Read the status line. Run `control browser text --role status`. It reads `DuckDB v2.… is ready, with …` and the list contains `cityjson`, `three_d` and `parquet`.
- **Proof.** Run `control browser snapshot --path startup/ready.aria.txt` and `control browser screenshot --path startup/ready.png`. Both show the heading and the status line.
- **Reload.** Run `control browser goto` again, then the Ready step. The same status line returns.

## Gotchas

- The first start downloads about 34 MB of wasm and the extensions. Ten seconds is normal, a minute is possible. Use the timeout, not a retry loop.
- `Starting DuckDB…` can be gone before a command sees it. Its absence in a snapshot is not a failure of `startup-progress`; prove that one with a snapshot taken right after `goto`.
- The status line has role `status` but no accessible name. `--role status --name "…"` never matches; use `--text`.
- With the network blocked the page shows `DuckDB did not start: …` with role `alert`. That is the app working as designed, and the startup feature failing.
- The extension list also holds DuckDB's built-in ones (`core_functions` and others). Check for the three named above, not for an exact list.
