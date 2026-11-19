# Download

The `Download` section of the side panel writes the current selection to a file the
browser saves. The user picks a format, the levels of detail and, per table, the
attributes, and names the file. The section says per table what will be written and how
much the download reads and keeps; the `Download` button runs it, with its step shown and
a `Cancel download` button, and ends with `Saved <file>: <size>, N city objects, in T s.` Each
selected feature is written whole: a building brings its parts.

## Sub-features

- `download-format` picks CityParquet (a zipped package), CityJSON, CityJSONSeq, FlatCityBuf or OBJ (with its `.mtl`, zipped).
- `download-lods` chooses levels of detail: checkboxes, or for OBJ one radio.
- `download-attributes` chooses attributes per table: search, `Select all`, `Select none`.
- `download-estimate` says what the download reads and keeps.
- `download-run` runs it, shows a progress bar with the step, the percentage and the seconds, saves the file and reports it.
- `download-cancel` stops a running download; the next one runs normally.
- `download-too-large` refuses a download that keeps more than 20 MB, with its numbers, and disables the button.

## How to get to it (user POV)

- Select something first: zoom in until footprints show, and draw an area or filter (see [extent-selection.md](./extent-selection.md)). Without an area the selection is the scope in view.
- Scroll the side panel to `Download`. Choose `Format`, tick the LoDs, open `Attributes` beside a table to choose its attributes, edit `File name`, click `Download`.

## Driving it with control

Preconditions:

- A selection exists: on the fixture, after `control browser click --role button --name "Hide table"` (so the corners stay on the map), the pentagon of [extent-selection.md](./extent-selection.md) gives `198 of 373 features selected.` On 3DBAG, zoom to Delft as there; the same pentagon gives about 198 (the pixels round differently per zoom).
- Record the drawn ring for the checker: `control browser eval --js "(() => { const m = window.__map; const r = m.getContainer().getBoundingClientRect(); return [[x1, y1], …].map(([x, y]) => m.unproject([x - r.left, y - r.top]).toArray()); })()"` with the corners' page pixels from `map-at`.

Steps:

- **Format.** `control browser select --role combobox --name Format --value <cityparquet|cityjson|cityjsonseq|flatcitybuf|obj>`.
- **LoDs.** `control browser click --role checkbox --name "LoD 0.0" --exact true` toggles one; for OBJ, `control browser click --role radio --name "LoD 2.2"`.
- **Attributes.** `control browser click --role button --name "Attributes of building"`, then `--role button --name "Select none"` or `"Select all"`, or `--role checkbox --name "Download <attribute>"`; `control browser press --key Escape` closes it.
- **What it writes.** `control browser text --testid download-building` prints `198 selected features with all their parts; LoD 0.0, 1.2, 1.3, 2.2; 62 attributes.`; `--testid download-estimate` prints `Reads up to … from N row groups. The selection is about … of that.`
- **Run.** `control browser download --role button --name Download --exact true --path download/<source> --timeout 600000` saves the file under the evidence directory and prints its size, the seconds and the peak resident memory. Then `control browser text --testid download-result` prints `Saved <file>: …, N city objects, in T s.` For bytes read, `control network mark` before and `control network summary --host <host>` after.
- **Check the file.** `python3 -I .claude/skills/verify-cityparquet-downloader/scripts/check-download.py --file <file> --source <package URL or fixtures/delft> --ring '<ring JSON>' [--where "<SQL>"] --lods 2.2 --attributes a,b,c` exits 0 when the objects are exactly the selection's whole features, the CRS is the package's and the LoDs and attributes are the chosen ones; a `.zip` package is also validated. It reads `.zip` packages, `.city.json`, `.city.jsonl` and `.fcb`. For an OBJ, unzip it and compare its `o` names with the ids that have the chosen LoD in a CityJSON download of the same selection.
- **Progress.** While it runs, the snapshot holds `progressbar "Download progress"`; `control browser text --testid download-percent` prints `P %, T s`, and P never goes down.
- **Cancel.** Click `Download` with `control browser click`, wait for `Finding the parts of features` or `Reading row group`, then `control browser click --role button --name "Cancel download"`: `download-result` reads `Download cancelled.` (3DBAG: the reads stop within a row group).
- **Too large.** On 3DBAG at footprint zoom without an area, `control browser text --testid download-problem` prints `Too large to write in the browser. The … selected features hold about 163.9 MB, and the limit is 20.0 MB. …` (role `alert`), and the snapshot shows `button "Download" [disabled]`.
- **Proof.** The downloaded file and its checker report, a snapshot and a screenshot before and after. On the fixture all five formats; on 3DBAG at least one small Delft selection.

## Gotchas

- `--name Download` needs `--exact true`: the section and the attribute checkboxes also contain the word.
- The fixture's `of M` counts footprints; the file holds more objects, because each building brings its `BuildingPart` rows.
- CityJSON leaves out null attributes, and its readers type columns from the values present: an attribute null in every written object has no column when read back. The checker allows for it.
- A second download of the same rows reads little from the host: the engine keeps the ranges it read. Measure bytes on a fresh page.
- The estimate counts the selected share of whole row groups; the bytes actually read are usually less than `Reads up to`.
