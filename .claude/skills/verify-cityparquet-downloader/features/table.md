# Feature table

A drawer below the map, titled `Features`, with one tab per table. Each tab says what its
scope is, has a `Columns` panel and the table's filter bar ([filter.md](./filter.md)), and
shows the selection's rows a page at a time with the total. Headers show each column's
type and sort on a click (ascending, descending, none); nulls show as `null`. Clicking a
row marks its footprint on the map and brings it into view; clicking a footprint marks
its row when it is on the page. The drawer's top edge resizes it, and `Hide table`
folds it to `Show table`.

## Sub-features

- `table-tabs` shows one tab per table.
- `table-scope` says what the scope holds (role `status`, or `alert` for a problem), with `Try again` after a failure.
- `table-page` pages the rows: `Rows per page` 20, 50 or 100, `Previous page`, `Next page`, and `1–20 of N`.
- `table-sort` sorts by a column on the engine.
- `table-columns` chooses the columns shown; only those are read.
- `table-row-to-map` marks a row's footprint on the map.
- `table-map-to-row` marks the row of a clicked footprint.
- `table-resize` and `table-hide` size and fold the drawer.

## How to get to it (user POV)

- The drawer is open below the map once a package is open. Click a tab, a header, a row, or the page buttons.

## Driving it with control

Preconditions:

- The table's selection is counted (see [extent-selection.md](./extent-selection.md)); on 3DBAG, zoom in until footprints show.

- **Rows.** On `delft` after a fresh load: `control browser text --testid page-range` prints `1–20 of 373`, and `control browser text --testid table-scope` reads `Selecting from 373 features in the whole table.`
- **Page.** `control browser click --role button --name "Next page"`: `21–40 of 373`. `control browser select --role combobox --name "Rows per page" --value 50`: `1–50 of 373`.
- **Sort.** `control browser click --role button --name "Sort by b3_h_dak_50p"` twice: the header's `aria-sort` is `descending` and the column reads `22.50…`, `18.98…`, `16.43…` on Delft.
- **Columns.** `control browser click --role button --name Columns`; `control browser click --role checkbox --name "Show b3_dak_type"`: the column goes from the grid, and the button reads `Columns 9 of …`. `Default columns` restores them.
- **Row to map.** The first row's id: `control browser eval --js "document.querySelector('#feature-table tbody tr').cells[0].textContent"`. `control browser click --role row --name "<id>"`; `control browser eval --js "document.querySelector('#feature-table tr[aria-selected=true]')?.cells[0].textContent"` prints it, and `control browser map-feature --id <id>` prints a pixel inside the marked footprint. Screenshot `table/<source>/row-click.png`: the footprint is outlined dark.
- **Map to row.** `control browser map-feature --id <id>` gives `x y`; `control browser click --x … --y …` opens the attribute popup, and the row on the page is `aria-selected`.
- **Tabs.** On `chuo-ku`: `control browser click --role tab --name bridge`, then the bridge rows and their own filter bar.
- **Resize.** Focus `Resize the table` (role `separator`) and `control browser press --key ArrowUp`: its `aria-valuenow` grows by 40.
- **Proof.** Screenshot with the heading visible, and the count against `selection-<table>` in the side panel.

## Gotchas

- `click --role row --name` needs the full id: the visible cell is cut short.
- A row click does not move the map when the footprint is already in view.
- The grid shows only the selected rows; with no area and no filter that is the whole scope, not only what the view shows.
