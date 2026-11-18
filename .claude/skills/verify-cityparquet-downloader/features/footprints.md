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
- `footprints-prune` reads only within the touched row groups' byte spans of the file, from their footprint columns on; never the whole file.
- `footprints-cache` reads a row group once: panning back to it reads nothing again.
- `footprints-bbox` draws a table without LoD 0 (Chuo-ku `bridge`) as faint bbox rectangles, which never hide a footprint under them.
- `footprints-error` shows `A row group did not load` with the reason and `Try again`.

## How to get to it (user POV)

- Zoom in on a city. On 3DBAG the footprints of Delft load at about zoom 13.7 in a window of 1440 by 900. The fixtures show them as soon as the package opens.

## Driving it with control

Preconditions:

- `control doctor` passes and the package has opened.

- **Fixture.** On `delft` (the default source): `control browser wait --text "Footprints:" --timeout 120000`, then `control browser wait --text ", loading" --state hidden --timeout 120000`. `control browser text --testid map-status` prints `Footprints: 373 features`, which is the 373 `Building` rows of `fixtures/README.md` (`BuildingPart` rows have no LoD 0). The list `Row groups in view` (`control browser text --role list --name "Row groups in view"`) has 9 items, one per row group. Screenshot `footprints/delft/loaded.png` shows building footprints over the city centre of Delft, on top of the basemap's buildings.
- **3DBAG.** On `3dbag`, run `control network mark`, then repeat until the status starts with `Footprints:`: `read x y < <(control browser map-at --lon 4.357 --lat 52.011)`, `control browser click --x $x --y $y --count 2`, `control browser text --testid map-status`. Then `control browser wait --text ", loading" --state hidden --timeout 120000`. The status reads `Footprints: 131,009 features` for row groups 69, 70, 71 and 96; screenshot `footprints/3dbag/delft.png` shows Delft's buildings.
- **Prune.** Right after, `control network summary --host cityparquet.open3d.city` lists three range GETs per row group in view (12 for four), about 21 MB in all: per row group about 230 kB for `id`, `feature_id` and `object_type`, then 1 MB and 4 MB from the start of `geometry_lod0_0`. Each range starts at most 4 kB before its first column (reads are block-aligned) and ends inside its row group. Nothing near the whole file (14.4 GB). The byte spans of row groups 69, 70, 71 and 96, for comparison, come from `parquet_metadata` in native DuckDB (it reads the footer only).
- **Timing.** `control browser eval --js "window.__mapLogs.loads"` gives each row group's read in ms (2.5 to 4.5 s each on 3DBAG); `window.__mapLogs.tiles` each tile's queue wait and run time.
- **Cache.** Pan away and back: `control browser wheel --x $x --y $y --dy 400` (zoom out a little), then double-click Delft again. Mark the network before returning; `control network summary --host cityparquet.open3d.city` lists no parquet GETs, and the status shows the same feature count at once.
- **Bbox fallback.** `control launch --run chuo --source /fixtures/chuo-ku/` and `control browser goto --run chuo`, then in that run (`--run chuo` on each `browser` command) wait for `Footprints:` without `, loading`. The status reads `Footprints: 641 features` (566 `building`, 75 `bridge`), and the legend lists `Bridge`, `BridgeConstructiveElement` and `BridgeInstallation` under `bridge`. Zoom in on the bridge (`control browser map-at --lon 139.787 --lat 35.682`, double-click twice; the status then reads `Footprints: 478 features`): screenshot `footprints/chuo-ku/bridge.png` shows amber rectangles beside the buildings, and no popup has opened. The one `Bridge` object's box spans almost the whole package, so the map has a faint amber tint: rectangles are filled at a quarter of a footprint's opacity for that reason. `control cleanup --run chuo` afterwards.
- **Proof.** Snapshot `footprints/<source>/loaded.aria.txt` with the status, the list and the legend.

## Gotchas

- The status counts features in the row groups in view, which reach beyond the window: a row group is about 9 by 12 km on 3DBAG.
- On 3DBAG the first footprints show 4 to 5 s after the status switches, and all of them 14 to 16 s after; the panel says `loading` meanwhile. Wait for the text, never a fixed time.
- `footprints-prune` cannot be shown against the fixtures: the dev server is local, and a fixture row group is tens of kB.
- Row group 96 of 3DBAG spans almost the whole country, so every Dutch view touches it.
- `footprints-error` needs a host that fails mid-session; there is no switch for it. If it cannot be reached, report it as not verified.
- The 4 MB read past the start of `geometry_lod0_0` runs about 3 MB into `geometry_lod1_2`: duckdb-wasm reads a remote file through a buffer that doubles from 16 kB to 4 MB, so about 2.3 MB of footprint columns cost 5.3 MB per row group. `SET disable_parquet_prefetching = true` makes it worse (49 GETs, 24 MB, 33 s for the Delft zoom).
