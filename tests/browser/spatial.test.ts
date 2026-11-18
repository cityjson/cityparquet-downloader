// What the map stands on: footprints taken to Web Mercator and cut into vector tiles,
// in duckdb-wasm's spatial build.
import { expect, test } from "vitest";
import { getEngine } from "@/engine/session";

const url = new URL("/fixtures/delft/building.parquet", location.href).href;

/** The z/x/y tile that holds a WGS 84 point. */
function tileOf(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  ];
}

test("ST_AsMVT makes a vector tile from the fixture's LoD0 footprints", async () => {
  const engine = await getEngine();
  await engine.exec(
    `CREATE OR REPLACE TABLE footprints AS
     SELECT id, object_type,
            ST_Transform(ST_Force2D(geometry_lod0_0), 'EPSG:28992', 'EPSG:3857', always_xy := true) AS g
     FROM read_parquet('${url}') WHERE geometry_lod0_0 IS NOT NULL`,
  );
  const [x, y] = tileOf(4.3621, 52.0099, 16);
  const tile = `ST_TileEnvelope(16, ${x}, ${y})`;
  const [row] = await engine.query(
    `SELECT count(*) AS features,
            octet_length(ST_AsMVT({'id': id, 'object_type': object_type,
                                   'geom': ST_AsMVTGeom(g, ST_Extent(${tile}))}, 'building')) AS bytes
     FROM footprints WHERE ST_Intersects(g, ${tile})`,
  );
  expect(row?.features).toBeGreaterThan(50);
  expect(row?.bytes).toBeGreaterThan(1000);
});
