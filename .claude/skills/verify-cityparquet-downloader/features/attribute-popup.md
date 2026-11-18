# Attribute popup

Hovering a footprint highlights it and turns the cursor into a pointer. Clicking it opens
the `Feature attributes` panel at the top right of the map: the feature's id, its object
type, table and row, then `Loading attributes…` while that one row is read from the
package, then a two-column table of its attributes. Nulls read `null`; long values are
cut short and shown whole on hover. The clicked footprint stays outlined until the panel
closes with `Close`, Escape, or a click on the map away from any footprint. A click opens it
250 ms later, once it is not the first half of a double-click, which zooms instead. Where
features overlap, the click means a footprint before a bbox rectangle, and the smaller of
two rectangles.

## Sub-features

- `popup-hover` highlights the footprint under the mouse.
- `popup-open` opens the panel with the clicked feature's id and its attributes.
- `popup-loading` shows `Loading attributes…` while the row is read.
- `popup-values` shows each attribute once, `null` for nulls, and the full value in the cell's title.
- `popup-prune` reads only the clicked feature's row group, and no geometry columns.
- `popup-close` closes with `Close`, Escape, or a click on empty map.
- `popup-pick` takes the footprint under a bbox rectangle, and never opens on a double-click.
- `popup-error` shows `Could not read its attributes` with the reason.

## How to get to it (user POV)

- With footprints on the map, move the mouse over one and click it.

## Driving it with control

Preconditions:

- `control doctor` passes and footprints have loaded (see [footprints.md](./footprints.md)).

- **Find a footprint.** On `delft`: `read x y < <(control browser map-at --lon 4.3620 --lat 52.0100)`, inside `NL.IMBAG.Pand.0503100000004555` (row 584, `b3_h_dak_max` 10.642999649047852). On `3dbag`, zoomed in on Delft: `read x y < <(control browser map-at --lon 4.3572 --lat 52.0116)`. Check one is under it: `control browser eval --js "(() => { const m = window.__map, r = m.getContainer().getBoundingClientRect(); return m.queryRenderedFeatures([$x - r.left, $y - r.top], { layers: ['footprints-fill'] }).map((f) => f.properties.id) })()"` prints one id.
- **Hover.** `control browser hover --x $x --y $y`, then `control browser screenshot --path popup/<source>/hover.png`: that footprint is darker than its neighbours.
- **Open.** `control network mark`, `control browser click --x $x --y $y`, then `control browser wait --role table --name Attributes --timeout 120000`. `control browser text --role dialog --name "Feature attributes"` prints the id from the step above, `Building in building, row …`, and rows such as `object_type Building` and `b3_h_dak_max …`; no `geometry_lod…`, `bbox` or `material…` rows. Screenshot `popup/<source>/open.png` shows the panel and the clicked footprint outlined.
- **Second reading.** Native DuckDB on the same row: `python3 -I -c "import duckdb; print(duckdb.sql(\"SELECT id, b3_h_dak_max FROM 'fixtures/delft/building.parquet' WHERE id = '<id>'\").fetchall())"` on `delft`. The value matches the panel's.
- **Pick.** On `chuo`, zoomed in on the bridge as in [footprints.md](./footprints.md): clicking a building inside the `Bridge` box opens `Building in building, row …`, and a small amber rectangle opens `BridgeConstructiveElement in bridge, row …`. After a double-click, `control browser eval --js "!!document.querySelector('[aria-label=\"Feature attributes\"]')"` prints `false`.
- **Prune.** On `3dbag`, `control network summary --host cityparquet.open3d.city` after the open lists about four range GETs (about 15 MB), all inside the byte span of the clicked feature's row group, as the footprint reads of that row group were.
- **Close.** `control browser click --role button --name Close`; `control browser wait --role dialog --name "Feature attributes" --state hidden` returns. Open it again and `control browser press --key Escape` closes it too.
- **Proof.** Snapshot `popup/<source>/open.aria.txt` while it is open.

## Gotchas

- `Loading attributes…` lasts a few milliseconds on the fixtures and about 4 s on 3DBAG; prove `popup-loading` there, with a snapshot straight after the click.
- On 3DBAG a building is a few pixels wide at the zoom footprints first appear. Zoom in two levels (double-click on it) before hovering, or the highlight cannot be seen.
- `popup-error` needs a row that is not where the tile says, which only a changed file produces. If it cannot be reached, report it as not verified.
- The panel covers the top right of the map; a footprint under it cannot be clicked until it closes.
