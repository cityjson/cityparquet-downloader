# Fixtures

Small CityParquet packages cut from public ones, for the browser tests and for running
the app without the network-sized data. `scripts/make-fixture.py` writes all of them
(`just fixture`); do not edit the files by hand.

| Package | Cut from | Box (package CRS) | Tables |
| --- | --- | --- | --- |
| `delft/` | `https://cityparquet.open3d.city/data/3dbag/` | x 84400–84700, y 447200–447500 (Amersfoort / RD New) | `building`: 373 `Building`, 375 `BuildingPart`, 9 row groups |
| `chuo-ku/` | `https://cityparquet.open3d.city/data/plateau/chuo-ku/` | lon 139.7845–139.7895, lat 35.6795–35.6845 (JGD2011) | `building`: 566 rows, 6 row groups; `bridge`: 75 rows, 1 row group |

Each package is a valid CityParquet package:

- the source schema, unchanged, including the Parquet GEOMETRY logical type on the
  GeoParquet column;
- the source `city` and `geo` footer keys, each exactly once;
- rows in source order, which is Hilbert order, in row groups of about 100 rows, so that
  row-group pruning can be tested on a box smaller than the package;
- whole features: a feature is in when its root object's `bbox` overlaps the box, and
  then with every object of the same `feature_id`;
- `metadata.json`, a STAC Item whose assets name the files, with their sizes and
  checksums.

3DBAG holds buildings only, so the multi-table paths are covered by `chuo-ku/`. Its CRS
is geographic with latitude first by definition, while the coordinates are stored
longitude first, which is the axis-order case the CRS code has to handle.

The `city` footer is the source's, so it describes the source dataset (its attribute
list, for instance), not only the cut.
