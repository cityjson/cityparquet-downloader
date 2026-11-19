# Area selection

The toolbar `Area` over the map draws the area a selection is limited to: a polygon
clicked corner by corner, a rectangle dragged on the map, or the current view. While
drawing, a hint at the bottom left says what to do, with `Finish` and `Cancel`. Once
drawn, the area shows as a blue outline, the footprints outside it are dimmed, and the
`Selection` section of the side panel reads `Area: drawn, N corners.` with, per table,
how many features are selected.

## Sub-features

- `area-polygon` draws a polygon: a click adds a corner, a double-click or Enter finishes, Backspace removes the last corner, Escape cancels.
- `area-rectangle` drags a rectangle.
- `area-view` takes the current view as the area.
- `area-clear` removes the area; the selection goes back to the whole scope.
- `area-highlight` dims the footprints that are not selected.
- `area-summary` shows, per table, `N of M features selected.` (role `status`).
- `area-too-large` refuses a scope over 400,000 rows and says what reading it would cost.

## How to get to it (user POV)

- Zoom in until footprints show. Click `Draw area`, click the corners on the map, then double-click or press Enter. Or click `Draw rectangle` and drag. Or click `Use current view`.
- Click `Clear area` to remove it.

## Driving it with control

Preconditions:

- Footprints are on the map (see [footprints.md](./footprints.md)). The drawer below the map takes half the window: keep the corners inside the map above it, and away from the toolbar at the top.

- **Polygon on Delft.** For each corner `(4.3595, 52.0092)`, `(4.3620, 52.0089)`, `(4.3627, 52.0103)`, `(4.3610, 52.0111)`, `(4.3593, 52.0104)`: `control browser map-at --lon … --lat …` gives `x y`; after `control browser click --role button --name "Draw area"`, `control browser click --x … --y …` each. Then `control browser press --key Enter`.
- **Result.** `control browser text --testid selection-area` prints `Area: drawn, 5 corners.`; `control browser wait --text "198 of"` returns, and `control browser text --testid selection-building` prints `198 of … features selected.` (on the fixture and on 3DBAG). The grid's `control browser text --testid page-range` ends `of 198`.
- **Highlight.** `control browser eval --js "window.__map.queryRenderedFeatures({ layers: ['footprints-fill'] }).filter(f => f.properties.sel === 1).map(f => f.properties.id).filter((v, i, a) => a.indexOf(v) === i).length"` equals the count, or falls short of it only by footprints outside the view. Screenshot `extent-selection/<source>/area.png`: the selected footprints are solid, the rest faint.
- **Rectangle.** `control browser click --role button --name "Draw rectangle"`, then `control browser drag --x … --y … --to-x … --to-y …`. `selection-area` reads `Area: drawn, 4 corners.`
- **View.** `control browser click --role button --name "Use current view"`.
- **Cancel.** During a polygon, `control browser press --key Escape`: the hint goes and the area is unchanged.
- **Clear.** `control browser click --role button --name "Clear area"`: `selection-area` reads `Area: none. …`.
- **Too large.** On 3DBAG at the fitted view, `control browser text --testid table-scope` reads `The scope is 285 row groups with 18,671,938 rows, about 675 MB to read. The limit is 400,000 rows: …` (role `alert`).
- **Proof.** An independent count: `scripts/expect-selection.py` computes the fixture's answers in native DuckDB (`tests/browser/selection.expected.json`, case `delft area`).

## Gotchas

- Clicks on the map while drawing add corners; they do not open the popup.
- A corner placed under the toolbar or the drawer is a click on that instead.
- A double-click finishes; its two clicks do not add two corners.
- Without an area the scope is every row group in view, whole: more features than the view shows.
- The summary's `of M` is the features in the scope's row groups, not in the area.
