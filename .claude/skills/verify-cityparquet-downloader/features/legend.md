# Legend

The `Legend` in the side panel lists every table of the package, and under each the city
object types its loaded footprints have, each with its colour swatch, the number of
loaded features of that type, and a checkbox. Unchecking a type hides it on the map;
unchecking a table hides the whole table. Before any footprints load, a table says its
types show once footprints load. Types stay listed once seen.

## Sub-features

- `legend-tables` lists every table of the package, checked.
- `legend-types` lists the object types of loaded footprints per table with a colour and a count.
- `legend-hide-type` hides one type on the map, and shows it again.
- `legend-hide-table` hides a whole table on the map, and disables its type checkboxes.
- `legend-empty` says `Its object types show once footprints load.` before any load.

## How to get to it (user POV)

- Look at `Legend` in the side panel. Click a checkbox to hide or show.

## Driving it with control

Preconditions:

- `control doctor` passes and footprints have loaded (see [footprints.md](./footprints.md)).

- **Types.** On `delft`: `control browser text --role heading --name Legend` exists, and `control browser wait --role checkbox --name "Building in building"` returns `visible`. The row reads `Building 373`.
- **Before hiding.** `control browser eval --js "window.__map.queryRenderedFeatures({ layers: ['footprints-fill'] }).length"` is above 0. Screenshot `legend/<source>/shown.png`.
- **Hide a type.** `control browser click --role checkbox --name "Building in building"`. The same eval prints `0`, and screenshot `legend/<source>/hidden.png` shows the basemap with outlines and no footprints. Click it again: the count returns.
- **Hide a table.** `control browser click --role checkbox --name "building table"`: the footprints go, and `Building in building` is disabled. Click it again.
- **Several tables.** On `chuo-ku`: the checkboxes `building table` and `bridge table`, with `Building in building` and `Bridge in bridge`, `BridgeConstructiveElement in bridge`, `BridgeInstallation in bridge`. Hiding `bridge table` leaves the buildings.
- **Empty.** On `3dbag` before zooming in: `control browser text --text "Its object types show once footprints load."` prints it.
- **Proof.** Snapshot `legend/<source>/legend.aria.txt` before and after a toggle: the checkbox's `checked` state changes.

## Gotchas

- A checkbox's accessible name is fixed (`<Type> in <table>`, `<table> table`); the count beside it is not part of it.
- A hidden type is hidden for footprints loaded later too.
- The rendered-feature count counts a footprint once per tile it crosses, so it can exceed the status count. Compare it with zero, not with the status.
