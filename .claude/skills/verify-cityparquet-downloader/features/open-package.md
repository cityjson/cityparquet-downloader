# Open a package

Once DuckDB has started, the page opens the package it was built for and reads only the
footers of its files. The user sees `Opening <URL>…`, then a `Package` section in the side
panel, open by default and folded by clicking its heading: the source URL, how its files
were found, the package extent in WGS 84, its CRS, and a table with one row per object
table giving its rows, row groups, LoDs and number of attributes. A source that cannot be
opened shows an error that says why.

## Sub-features

- `open-progress` shows `Opening <URL>…` while the footers are read.
- `open-summary` lists every object table with its row count, row-group count, LoDs and attribute count, and the CRS the tables are in.
- `open-extent` gives the package extent in WGS 84, longitude first.
- `open-multi-table` lists each table of a package with several (`fixtures/chuo-ku/`).
- `open-remote` opens the national 3DBAG file (14.4 GB) from its host, footers only.
- `open-error` shows `Could not open the package` with the reason for a source with no CityParquet files.

## How to get to it (user POV)

- Open the app's URL. The package opens by itself after DuckDB starts; there is no control to choose another one (it is fixed when the app is built).

## Driving it with control

Preconditions:

- `control doctor` passes, and its `package:` line names the source you mean to verify.

- **Open.** Run `control browser goto`, then `control browser wait --text "is ready" --timeout 90000`.
- **Progress.** Run `control browser snapshot --path open-package/opening.aria.txt` straight after the wait. It may hold `Opening …` (see Gotchas).
- **Summary.** Run `control browser wait --role table --name Tables --timeout 120000`. It prints `visible`. Then `control browser text --role table --name Tables` prints a header row and one row per table.
- **Extent.** Run `control browser text --testid package-extent`. It prints `west, south – east, north` in degrees.
- **Proof.** Run `control browser snapshot --path open-package/<source>/summary.aria.txt` and `control browser screenshot --path open-package/<source>/summary.png`, with `<source>` naming the package (`delft`, `chuo-ku`, `3dbag`).
- **CRS.** Run `control browser text --text "CRS:"`. It prints the CRS of the tables, once per distinct CRS.
- **Second reading.** Compare the page with a source that is not the page:
  - `delft`: `fixtures/README.md` gives 748 rows (373 `Building`, 375 `BuildingPart`) in 9 row groups; `fixtures/delft/metadata.json` `bbox` is the extent native DuckDB computed. Expect the row `building 748 9 0.0, 1.2, 1.3, 2.2 62`, `CRS: Amersfoort / RD New + NAP height (EPSG:7415)`, and the bbox to four decimals.
  - `chuo-ku` (`control launch --source /fixtures/chuo-ku/`): rows `building 566` and `bridge 75`, bridge LoDs `1.0, 2.0, 3.0`, and `CRS: JGD2011 + JGD2011 (vertical) height (EPSG:6697)`; extent as in its `metadata.json`.
  - `3dbag` (`control launch --source https://cityparquet.open3d.city/data/3dbag/`): read the footer natively, footers only: `python3 -I -c "import duckdb; c=duckdb.connect(); c.execute('LOAD httpfs'); print(c.execute(\"SELECT num_rows, num_row_groups FROM parquet_file_metadata('https://cityparquet.open3d.city/data/3dbag/building.parquet')\").fetchall())"`. Expect the page's rows and row groups to equal it (21,555,522 and 329).
- **Error.** Launch a second run on a source with nothing in it: `control launch --run bad --source /fixtures/none/`, then in that run `control browser goto --run bad` and `control browser wait --run bad --text "Could not open the package" --timeout 120000`. `control browser text --run bad --role alert` names the URL and says no CityParquet files were found. Clean it up with `control cleanup --run bad`.

## Gotchas

- `Opening …` shows from page load until the summary. On a fixture the footers are read within about 0.2 s of DuckDB being ready, so the snapshot after the `is ready` wait usually shows the summary already; that is not a failure of `open-progress`. On 3DBAG it stays about 7 s after DuckDB is ready, which is where to prove it.
- 3DBAG takes 11 to 12 s from page load to the summary, most of it DuckDB starting (about 4 s) and the 5.7 MB footer (about 4.5 s). Use the timeout, not a retry loop.
- Never verify `open-remote` by running a query that scans the 3DBAG file. The point of the feature is that only footers are read; a scan of 14.4 GB exhausts the machine.
- The extent is the union of the row groups' `bbox` statistics, so for 3DBAG it is a little wider than the `bbox` in its `metadata.json` (north 53.5000 against 53.4870). The fixtures' `metadata.json` boxes were computed the same way and match to four decimals.
- The `Package` heading sits inside the summary that folds the section; folded, the `Tables` table is hidden and `wait --role table --name Tables` does not return. The table's accessible name is `Tables`.
