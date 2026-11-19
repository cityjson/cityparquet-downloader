// The map's reads on the national 3DBAG file: the row group of footprints over central
// Delft, tiles cut from it, and one feature's attributes. Opt-in: CITYPARQUET_REMOTE=1.
// Bytes on the wire are in docs/findings.md, measured with the verification skill.
import { expect, test } from "vite-plus/test";
import {
  attributesSql,
  chunksOf,
  chunkTypesSql,
  createFeaturesSql,
  DEFAULT_SOURCE,
  FEATURES_TABLE,
  footprintOf,
  loadChunkSql,
  openPackage,
  parseSource,
  resolveSource,
  tileSql,
} from "@/core";
import { getEngine } from "@/engine/session";

const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await work();
  console.log(`${label}: ${Math.round(performance.now() - start)} ms`);
  return result;
};

function tileOf(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  };
}

test("the Delft row group loads, tiles come from it, and a feature's attributes by its row", async () => {
  const engine = await getEngine();
  const source = await resolveSource(parseSource(DEFAULT_SOURCE, location.href), (u, i) =>
    fetch(u, i),
  );
  const info = await timed("open", () => openPackage(engine, source));
  const building = info.tables[0];
  if (building?.crs.kind !== "known") throw new Error("no building table with a CRS");
  // The smallest row group over central Delft, RD New 84500 447500.
  const width = (b: { xmin: number; xmax: number } | null) => (b ? b.xmax - b.xmin : Infinity);
  const [chunk] = chunksOf(building)
    .filter((c) => c.bbox && c.bbox.xmin <= 84500 && c.bbox.xmax >= 84500)
    .filter((c) => c.bbox && c.bbox.ymin <= 447500 && c.bbox.ymax >= 447500)
    .sort((a, b) => width(a.bbox) - width(b.bbox));
  if (!chunk) throw new Error("no row group over Delft");
  console.log(`row group ${chunk.index}, rows ${chunk.start} to ${chunk.start + chunk.rows}`);

  for (const s of createFeaturesSql) await engine.exec(s);
  const from = building.crs.horizontal.definition;
  await timed("load chunk", () => engine.exec(loadChunkSql(chunk, footprintOf(building), from, 1)));
  const types = await engine.query(chunkTypesSql(1));
  console.log(`types ${JSON.stringify(types)}`);
  expect(types.find((t) => t.object_type === "Building")?.n).toBeGreaterThan(10_000);

  for (const z of [14, 15, 16]) {
    const bytes = await timed(`tile z${z}`, () =>
      engine.queryBytes(tileSql(tileOf(4.357, 52.011, z))),
    );
    console.log(`tile z${z}: ${bytes?.length} bytes`);
  }

  const [hit] = await engine.query(`SELECT "row", id FROM ${FEATURES_TABLE} LIMIT 1`);
  const [row] = await timed("attributes", () =>
    engine.query(attributesSql(building, chunk.file, Number(hit?.row))),
  );
  expect(row?.id).toBe(hit?.id);
});
