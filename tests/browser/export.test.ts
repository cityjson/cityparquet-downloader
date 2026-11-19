// Downloads on real duckdb-wasm: each format written from a selection of the fixtures and
// read back with the extension's own readers, against ids native DuckDB computed with SQL
// written by hand (scripts/expect-export.py writes export.expected.json).
import { beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type Chunk,
  chunksOf,
  cleanupSql,
  createFeaturesSql,
  type ExportExec,
  type ExportFormat,
  type ExportRequest,
  type ExportResult,
  openPackage,
  type PackageInfo,
  type PackageTable,
  parseSource,
  planExport,
  resolveSource,
  runExport,
  SELECTION_TABLE,
  type Url,
} from "@/core";
import { getEngine } from "@/engine/session";
import expected from "./export.expected.json";

interface TableCase {
  seeds: string[];
  ids: string[];
  lodIds: Record<string, string[]>;
  attributes: string[];
  sample: { id: string; values: Record<string, unknown> };
}
const cases = expected as unknown as Record<
  string,
  { fixture: string; tables: Record<string, TableCase> }
>;

const quote = (ids: readonly string[]) => ids.map((i) => `'${i.replaceAll("'", "''")}'`).join(", ");

async function open(dir: string): Promise<PackageInfo> {
  const engine = await getEngine();
  const url = new URL(dir, location.href).href;
  const source = await resolveSource(parseSource(url, location.href), (u, i) => fetch(u, i));
  return openPackage(engine, source);
}

/**
 * Puts a selection's ids into `selection_rows`, as the map's selection would, and returns
 * the row groups holding them: the scope. Reading the ids here is the test's own lookup.
 */
async function seed(table: PackageTable, ids: readonly string[]): Promise<Chunk[]> {
  const engine = await getEngine();
  for (const s of createFeaturesSql) await engine.exec(s);
  await engine.exec(`DELETE FROM ${SELECTION_TABLE} WHERE tbl = '${table.name}'`);
  const rows: number[] = [];
  for (const [file, url] of table.files.entries()) {
    const found = await engine.query(
      `SELECT file_row_number AS r FROM read_parquet('${url}', file_row_number := true) WHERE id IN (${quote(ids)})`,
    );
    for (const f of found) {
      await engine.exec(
        `INSERT INTO ${SELECTION_TABLE} VALUES ('${table.name}', ${file}, ${Number(f.r)})`,
      );
      rows.push(Number(f.r));
    }
  }
  expect(rows.length).toBe(ids.length);
  return chunksOf(table).filter((c) => rows.some((r) => r >= c.start && r < c.start + c.rows));
}

const direct: ExportExec = async (_progress, work) => work(await getEngine());

let run = 100;
/** Runs a download of the case; returns what it wrote. The local schema is dropped after. */
async function download(
  info: PackageInfo,
  scopes: Record<string, Chunk[]>,
  request: ExportRequest,
): Promise<ExportResult & { root: string; target: string }> {
  const inputs = info.tables
    .filter((t) => scopes[t.name])
    .map((table) => ({ table, scope: scopes[table.name] ?? [] }));
  const plan = planExport(inputs, request, run++);
  const engine = await getEngine();
  try {
    return { ...(await runExport(plan, direct)), ...plan.layout };
  } finally {
    for (const s of cleanupSql(plan)) await engine.exec(s);
  }
}

const READERS: Record<Exclude<ExportFormat, "cityparquet" | "obj">, string> = {
  cityjson: "read_cityjson",
  cityjsonseq: "read_cityjsonseq",
  flatcitybuf: "read_flatcitybuf",
};

const columnsOf = async (relation: string) =>
  (await (await getEngine()).query(`DESCRIBE SELECT * FROM ${relation}`)).map((r) =>
    String(r.column_name),
  );

const geometryLods = (columns: readonly string[]) =>
  columns
    .filter((c) => c.startsWith("geometry_lod"))
    .map((c) => c.slice("geometry_lod".length).replace("_", "."))
    .sort();

/** The sample row's chosen attributes in the output, read the way the expectations were. */
async function sampleOf(relation: string, t: TableCase, columns: readonly string[]) {
  const engine = await getEngine();
  const types = new Map(
    (await engine.query(`DESCRIBE SELECT * FROM ${relation}`)).map((r) => [
      String(r.column_name),
      String(r.column_type),
    ]),
  );
  const present = t.attributes.filter((a) => columns.includes(a));
  const cell = (a: string) => {
    const type = types.get(a) ?? "";
    if (type.startsWith("TIMESTAMP")) return `epoch_us("${a}") AS "${a}"`;
    if (["BIGINT", "INTEGER", "DOUBLE", "FLOAT", "BOOLEAN", "VARCHAR"].includes(type))
      return `"${a}"`;
    return `CAST("${a}" AS VARCHAR) AS "${a}"`;
  };
  const [row] = await engine.query(
    `SELECT ${present.map(cell).join(", ")} FROM ${relation} WHERE id = '${t.sample.id}'`,
  );
  return row ?? {};
}

describe("downloads of the Delft fixture", () => {
  const c = cases["delft area horizontal"];
  const t = c?.tables.building as TableCase;
  let info: PackageInfo;
  let scope: Chunk[];
  const request = (format: ExportFormat): ExportRequest => ({
    tables: [{ name: "building", lods: ["2.2"], attributes: t.attributes }],
    format,
    fileName: "delft subset",
  });

  beforeAll(async () => {
    info = await open(c?.fixture ?? "");
    const table = info.tables.find((x) => x.name === "building");
    if (!table) throw new Error("no building table");
    scope = await seed(table, t.seeds);
    // The case only proves completion if features have rows the selection does not.
    expect(t.ids.length).toBeGreaterThan(t.seeds.length);
  });

  test.each(Object.keys(READERS) as (keyof typeof READERS)[])(
    "%s: whole features, the CRS, LoD 2.2 only and the chosen attributes",
    async (format) => {
      const out = await download(info, { building: scope }, request(format));
      expect(out.files).toEqual([out.target]);
      expect(out.rows).toEqual({ building: t.ids.length });
      const engine = await getEngine();
      const relation = `${READERS[format]}('${out.target}')`;
      const ids = await engine.query(`SELECT id FROM ${relation} ORDER BY id`);
      expect(ids.map((r) => r.id)).toEqual(t.ids);
      const meta = READERS[format].replace("read_", "");
      const [m] = await engine.query(
        `SELECT reference_system.code AS code FROM ${meta}_metadata('${out.target}')`,
      );
      expect(m?.code).toBe("7415");
      const columns = await columnsOf(relation);
      expect(geometryLods(columns)).toEqual(["2.2"]);
      const attributes = columns.filter((col) =>
        info.tables[0]?.attributes.some((a) => a.name === col),
      );
      // Every chosen attribute comes back, timestamps included, and no other.
      expect(attributes.sort()).toEqual([...t.attributes].sort());
      expect(await sampleOf(relation, t, columns)).toEqual(t.sample.values);
      await engine.dropFiles(out.files);
    },
  );

  test("obj: the parts with LoD 2.2 geometry, a .mtl beside it, the CRS in its header", async () => {
    const out = await download(info, { building: scope }, request("obj"));
    expect(out.files.sort()).toEqual([out.target, out.target.replace(/\.obj$/, ".mtl")].sort());
    const engine = await getEngine();
    const ids = await engine.query(
      `SELECT id FROM read_obj('${out.target}', lod := '2.2') ORDER BY id`,
    );
    expect(ids.map((r) => r.id)).toEqual(t.lodIds["2.2"]);
    const text = new TextDecoder().decode(await engine.readFile(out.target));
    expect(text).toMatch(/^# crs https:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/7415$/m);
    await engine.dropFiles(out.files);
  });

  test("cityparquet: a valid package with the source footer, LoD 2.2 only", async () => {
    const out = await download(info, { building: scope }, request("cityparquet"));
    expect(out.files.map((f) => f.slice(out.target.length)).sort()).toEqual([
      "building.parquet",
      "metadata.json",
    ]);
    const engine = await getEngine();
    const file = `${out.target}building.parquet`;
    const ids = await engine.query(`SELECT id FROM read_parquet('${file}') ORDER BY id`);
    expect(ids.map((r) => r.id)).toEqual(t.ids);
    const [kv] = await engine.query(
      `SELECT decode(value) AS city FROM parquet_kv_metadata('${file}') WHERE decode(key) = 'city'`,
    );
    const city = JSON.parse(String(kv?.city)) as {
      crs: { id: { code: number } };
      source_format?: string;
      other?: { source_metadata?: { title?: string } };
    };
    expect(city.crs.id.code).toBe(7415);
    expect(city.source_format).toBe("CityJSONSeq");
    expect(city.other?.source_metadata?.title).toBe("3DBAG");
    const columns = await columnsOf(`read_parquet('${file}')`);
    expect(geometryLods(columns)).toEqual(["2.2"]);
    expect(await sampleOf(`read_parquet('${file}')`, t, columns)).toEqual(t.sample.values);
    await engine.exec("DROP SCHEMA IF EXISTS readback CASCADE");
    await engine.exec(`PRAGMA cityparquet_read('${out.target}', 'readback')`);
    await engine.exec("PRAGMA cityparquet_validate('readback')");
    const errors = await engine.query(
      "SELECT * FROM cityparquet_validation WHERE severity = 'error'",
    );
    expect(errors).toEqual([]);
    await engine.exec("DROP SCHEMA readback CASCADE");
    await engine.dropFiles(out.files);
  });
});

describe("downloads of Chuo-ku, two tables", () => {
  const c = cases["chuo-ku area, two tables"];
  const building = c?.tables.building as TableCase;
  const bridge = c?.tables.bridge as TableCase;
  let info: PackageInfo;
  let scopes: Record<string, Chunk[]>;
  const request = (format: ExportFormat, lods: string[]): ExportRequest => ({
    tables: [
      { name: "building", lods, attributes: building.attributes },
      { name: "bridge", lods, attributes: bridge.attributes },
    ],
    format,
    fileName: "chuo",
  });

  beforeAll(async () => {
    info = await open(c?.fixture ?? "");
    const table = (name: string) => {
      const t = info.tables.find((x) => x.name === name);
      if (!t) throw new Error(`no ${name}`);
      return t;
    };
    scopes = {
      building: await seed(table("building"), building.seeds),
      bridge: await seed(table("bridge"), bridge.seeds),
    };
    expect(bridge.ids.length).toBeGreaterThan(bridge.seeds.length);
  });

  test.each(Object.keys(READERS) as (keyof typeof READERS)[])(
    "%s: both tables in one file, whole features, the CRS and the source's precision",
    async (format) => {
      const out = await download(info, scopes, request(format, ["1.0", "2.0"]));
      expect(out.files).toEqual([out.target]);
      expect(out.rows).toEqual({ building: building.ids.length, bridge: bridge.ids.length });
      const engine = await getEngine();
      const relation = `${READERS[format]}('${out.target}')`;
      const ids = await engine.query(`SELECT id FROM ${relation} ORDER BY id`);
      expect(ids.map((r) => r.id)).toEqual([...building.ids, ...bridge.ids].sort());
      const meta = READERS[format].replace("read_", "");
      const [m] = await engine.query(
        `SELECT reference_system.code AS code FROM ${meta}_metadata('${out.target}')`,
      );
      expect(m?.code).toBe("6697");
      const columns = await columnsOf(relation);
      expect(geometryLods(columns)).toEqual(["1.0", "2.0"]);
      expect(await sampleOf(relation, building, columns)).toEqual(building.sample.values);
      expect(await sampleOf(relation, bridge, columns)).toEqual(bridge.sample.values);
      // Degrees at the source's 1e-9 scale: the writer's 0.001 default would move a vertex
      // by up to 100 m here.
      const [d] = await engine.query(
        `SELECT max(abs(o.bbox.xmin - s.bbox.xmin) + abs(o.bbox.ymin - s.bbox.ymin)) AS d
         FROM ${relation} o JOIN read_parquet('${info.tables[0]?.files[0]}') s USING (id)`,
      );
      expect(Number(d?.d)).toBeLessThan(1e-8);
      await engine.dropFiles(out.files);
    },
  );

  test("obj: one LoD of both tables", async () => {
    const out = await download(info, scopes, request("obj", ["2.0"]));
    const engine = await getEngine();
    const ids = await engine.query(
      `SELECT id FROM read_obj('${out.target}', lod := '2.0') ORDER BY id`,
    );
    expect(ids.map((r) => r.id)).toEqual(
      [...(building.lodIds["2.0"] ?? []), ...(bridge.lodIds["2.0"] ?? [])].sort(),
    );
    await engine.dropFiles(out.files);
  });

  test("cityparquet: one file per table, valid, each with its footer", async () => {
    const out = await download(info, scopes, request("cityparquet", ["2.0"]));
    expect(out.files.map((f) => f.slice(out.target.length)).sort()).toEqual([
      "bridge.parquet",
      "building.parquet",
      "metadata.json",
    ]);
    const engine = await getEngine();
    for (const [name, t] of [
      ["building", building],
      ["bridge", bridge],
    ] as const) {
      const file = `${out.target}${name}.parquet`;
      const ids = await engine.query(`SELECT id FROM read_parquet('${file}') ORDER BY id`);
      expect(ids.map((r) => r.id)).toEqual(t.ids);
      const [kv] = await engine.query(
        `SELECT decode(value) AS city FROM parquet_kv_metadata('${file}') WHERE decode(key) = 'city'`,
      );
      expect((JSON.parse(String(kv?.city)) as { crs: { id: { code: number } } }).crs.id.code).toBe(
        6697,
      );
      const columns = await columnsOf(`read_parquet('${file}')`);
      expect(geometryLods(columns)).toEqual(["2.0"]);
      expect(await sampleOf(`read_parquet('${file}')`, t, columns)).toEqual(t.sample.values);
    }
    await engine.exec("DROP SCHEMA IF EXISTS readback CASCADE");
    await engine.exec(`PRAGMA cityparquet_read('${out.target}', 'readback')`);
    await engine.exec("PRAGMA cityparquet_validate('readback')");
    expect(
      await engine.query("SELECT * FROM cityparquet_validation WHERE severity = 'error'"),
    ).toEqual([]);
    await engine.exec("DROP SCHEMA readback CASCADE");
    await engine.dropFiles(out.files);
  });
});

describe("a feature split across row groups", () => {
  test("comes whole: the row group beside the scope is read for its other rows", async () => {
    const engine = await getEngine();
    // The Delft fixture again, in row groups of a few rows, so that some features cross
    // a row group boundary; the source footer goes along.
    const source = new URL("/fixtures/delft/building.parquet", location.href).href;
    const split = "/split/building.parquet" as Url;
    await engine.exec(
      `SET VARIABLE city = (SELECT decode(value) FROM parquet_kv_metadata('${source}') WHERE decode(key) = 'city')`,
    );
    await engine.exec(
      `COPY (SELECT * FROM read_parquet('${source}')) TO '${split}' (FORMAT parquet, ROW_GROUP_SIZE_BYTES 50000, KV_METADATA {city: getvariable('city')})`,
    );
    const info = await openPackage(engine, {
      spec: { kind: "file", url: split },
      listedBy: "url",
      tables: [{ name: "building", files: [split] }],
      sidecars: [],
    });
    const table = info.tables[0] as PackageTable;
    const chunks = chunksOf(table);
    // Roots on the last row of their row group, whose parts start the next one.
    const rows = await engine.query(
      `SELECT id, feature_id, file_row_number AS r FROM read_parquet('${split}', file_row_number := true)
       WHERE object_type = 'Building' AND file_row_number IN (${chunks.map((c) => c.start + c.rows - 1).join(", ")})`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const seeds = rows.map((r) => String(r.id));
    const scope = await seed(table, seeds);
    const whole = await engine.query(
      `SELECT id, file_row_number AS r FROM read_parquet('${split}', file_row_number := true)
       WHERE feature_id IN (${quote(rows.map((r) => String(r.feature_id)))}) ORDER BY id`,
    );
    const inScope = (r: number) => scope.some((c) => r >= c.start && r < c.start + c.rows);
    expect(whole.some((w) => !inScope(Number(w.r)))).toBe(true);

    const out = await download(
      info,
      { building: scope },
      {
        tables: [{ name: "building", lods: ["2.2"], attributes: [] }],
        format: "cityjsonseq",
        fileName: "split",
      },
    );
    const ids = await engine.query(`SELECT id FROM read_cityjsonseq('${out.target}') ORDER BY id`);
    expect(ids.map((r) => r.id)).toEqual(whole.map((w) => w.id));
    await engine.dropFiles([...out.files, split]);
  });
});
