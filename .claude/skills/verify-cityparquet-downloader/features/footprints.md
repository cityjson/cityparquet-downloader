# Footprints

Zoomed in until the view touches at most 4 row groups (or at most 20,000 rows), the map
reads the footprints of exactly those row groups from the package and draws them,
coloured by object type. Each row group is read once and kept while it fits the cache;
the panel lists the row groups in view with `loading`, `failed` or their feature count,
and a row group being read is outlined in amber on the map. Tables without LoD 0
geometry are drawn as the rectangles of their objects' bounding boxes.

## Sub-features

- `footprints-load` switches the status to `Footprints: …`, reads the touched row groups and draws their footprints.
- `footprints-progress` shows `, loading k of n row groups` and `loading` per row group until each is read.
- `footprints-prune` reads only the touched row groups' byte ranges of the file, and only the footprint columns.
- `footprints-cache` reads a row group once: panning back to it reads nothing again.
- `footprints-bbox` draws a table without LoD 0 (Chuo-ku `bridge`) as bbox rectangles.
- `footprints-error` shows `A row group did not load` with the reason and `Try again`.

## How to get to it (user POV)

- Zoom in on a city. On 3DBAG the footprints of Delft load at about zoom 13.7 in a window of 1440 by 900. The fixtures show them as soon as the package opens.

## Driving it with control

Preconditions:

- `control doctor` passes and the package has opened.

- **Fixture.** On `delft` (the default source): `control browser wait --text "Footprints:" --timeout 120000`, then `control browser wait --text ", loading" --state hidden --timeout 120000`. `control browser text --testid map-status` prints `Footprints: 373 features`, which is the 373 `Building` rows of `fixtures/README.md` (`BuildingPart` rows have no LoD 0). The list `Row groups in view` (`control browser text --role list --name "Row groups in view"`) has 9 items, one per row group. Screenshot `footprints/delft/loaded.png` shows building footprints over the city centre of Delft, on top of the basemap's buildings.
- **3DBAG.** On `3dbag`, run `control network mark`, then repeat until the status starts with `Footprints:`: `read x y < <(control browser map-at --lon 4.357 --lat 52.011)`, `control browser click --x $x --y $y --count 2`, `control browser text --testid map-status`. Then `control browser wait --text ", loading" --state hidden --timeout 120000`. The status reads `Footprints: 131,009 features` for row groups 69, 70, 71 and 96; screenshot `footprints/3dbag/delft.png` shows Delft's buildings.
- **Prune.** Right after, `control network summary --host cityparquet.open3d.city` lists three range GETs per row group in view (12 for four), about 21 MB in all, each range inside the byte span of its row group. Nothing near the whole file (14.4 GB) and no other row group's columns.
- **Timing.** `control browser eval --js "window.__mapLogs.loads"` gives each row group's read in ms (2 to 4 s each on 3DBAG); `window.__mapLogs.tiles` each tile's queue wait and run time.
- **Cache.** Pan away and back: `control browser wheel --x $x --y $y --dy 400` (zoom out a little), then double-click Delft again. Mark the network before returning; `control network summary --host cityparquet.open3d.city` lists no parquet GETs, and the status shows the same feature count at once.
- **Bbox fallback.** `control launch --run chuo --source /fixtures/chuo-ku/`, then in that run wait for `Footprints:` without `, loading`. The status reads `Footprints: 641 features` (566 `building`, 75 `bridge`), and the legend lists `Bridge`, `BridgeConstructiveElement` and `BridgeInstallation` under `bridge`. Zoom in on the bridge (`control browser map-at --lon 139.787 --lat 35.682`, double-click twice): screenshot `footprints/chuo-ku/bridge.png` shows amber rectangles. `control cleanup --run chuo` afterwards.
- **Proof.** Snapshot `footprints/<source>/loaded.aria.txt` with the status, the list and the legend.

## Gotchas

- The status counts features in the row groups in view, which reach beyond the window: a row group is about 9 by 12 km on 3DBAG.
- On 3DBAG the first footprints show 4 to 5 s after the status switches, and all of them about 14 s after; the panel says `loading` meanwhile. Wait for the text, never a fixed time.
- `footprints-prune` cannot be shown against the fixtures: the dev server is local, and a fixture row group is tens of kB.
- Row group 96 of 3DBAG spans almost the whole country, so every Dutch view touches it.
- `footprints-error` needs a host that fails mid-session; there is no switch for it. If it cannot be reached, report it as not verified.
