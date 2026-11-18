# Map

The page is a map filling the window beside a side panel. Once the package is open the
camera fits its extent, and the map shows each row group of each table as its outline,
shaded darker where its rows are denser. The status line under `View` in the panel says
which regime the view is in and how many row groups and features it touches. The basemap
is Positron in the light theme and Dark Matter in the dark one, credited in the corner;
the theme follows the system until the user switches it. The panel folds away to give the
map the whole window.

## Sub-features

- `map-render` draws a basemap and the package's row-group outlines; the region `Map` is not blank.
- `map-fit` fits the camera to the package's WGS 84 extent once it opens.
- `map-overview` says `Overview: N row groups, M features in view` while the view touches more than 4 row groups and more than 20,000 rows, and counts change as the view moves.
- `map-attribution` credits the basemap's data (OpenStreetMap) and its maker.
- `map-theme` switches basemap and panel between light and dark with the theme button, keeping what the map shows.
- `map-panel` hides and shows the side panel.

## How to get to it (user POV)

- Open the app; the map is the rest of the window once DuckDB starts and the package opens.
- Drag to pan, scroll or double-click to zoom in, or use `Zoom in` and `Zoom out`.
- Click `Dark theme` (or `Light theme`) at the top of the panel.
- Click `Hide panel` (or `Show panel`) at the top left of the map.

## Driving it with control

Preconditions:

- `control doctor` passes and the package has opened: `control browser wait --testid map-status --timeout 120000` returns `visible`.

- **Render.** Run `control browser screenshot --path map/<source>/fit.png` and look at it: a basemap with place names, and purple outlines over the package's area. A white or grey map region is a failure.
- **Fit.** Run `control browser map-view`. Its bounds contain the package extent (`control browser text --testid package-extent`), and are no more than about twice as wide.
- **Overview.** On `3dbag` (`control launch --source https://cityparquet.open3d.city/data/3dbag/`): `control browser text --testid map-status` prints `Overview: 329 row groups, 21,555,522 features in view`, the row groups and rows of the `Tables` row. Then zoom in once towards Delft: `read x y < <(control browser map-at --lon 4.357 --lat 52.011)` and `control browser click --x $x --y $y --count 2`. The counts drop.
- **Attribution.** In the snapshot of the Proof step, the group beside `Zoom out` holds the links `OpenFreeMap`, `© OpenMapTiles` and `OpenStreetMap` (with `VITE_CARTO_KEY`: `OpenStreetMap` and `CARTO`). The screenshot shows them in the bottom right corner.
- **Theme.** Run `control browser click --role button --name "Dark theme"`, wait for the button `Light theme` (`control browser wait --role button --name "Light theme"`), then `control browser screenshot --path map/<source>/dark.png`. The basemap is dark and the outlines (or footprints) drawn before are still there. Click `Light theme` to go back.
- **Panel.** Run `control browser click --role button --name "Hide panel"`, then `control browser screenshot --path map/<source>/no-panel.png`: the map fills the window. `control browser click --role button --name "Show panel"` brings the panel back.
- **Proof.** `control browser snapshot --path map/<source>/map.aria.txt` holds the heading, the region `Map`, the credit links and the status line.

## Gotchas

- There is no GPU in the cloud container; WebGL 2 comes from SwiftShader, which `launch` enables. A map region that stays white with the status line present means WebGL did not start, or the basemap did not load: read `.verify/runs/<run>/chromium.log`.
- The fixtures are small enough (under 20,000 rows) that they never show the overview: they go straight to footprints. Prove `map-overview` on `3dbag`.
- CARTO's basemap tiles need an API key; without one they show an "API key required" watermark, which is why a build without `VITE_CARTO_KEY` uses OpenFreeMap's copies of the same two styles.
- `map-at` gives page pixels of the current camera. Run it again after every zoom or pan before clicking.
- Double-click zoom animates for about a quarter of a second; read the status after `control browser wait` for the text you expect, not straight away.
