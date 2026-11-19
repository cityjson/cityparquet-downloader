// The selection's SQL on real duckdb-wasm, against answers native DuckDB computed with SQL
// written by hand (scripts/expect-selection.py writes selection.expected.json).
import { beforeAll, describe, expect, test } from "vitest";
import {
  attributeColumns,
  chunksOf,
  compileSelection,
  createFeaturesSql,
  type DraftCondition,
  distinctValuesSql,
  type Extent,
  FEATURES_TABLE,
  footprintOf,
  loadAttrsSql,
  loadChunkSql,
  materialiseSql,
  openPackage,
  outlinesSql,
  type PackageTable,
  parseExtent,
  parseFilter,
  parseSource,
  resolveSource,
  type ScopeChunk,
  SELECTION_TABLE,
  type Selection,
  selectionCountSql,
  selectionPageSql,
  tileSql,
} from "@/core";
import { getEngine } from "@/engine/session";
import expected from "./selection.expected.json";

let nextId = 1000;

/** Opens a fixture table and loads all of it into the local footprint table, as the map does. */
async function placed(
  dir: string,
  name: string,
): Promise<{ table: PackageTable; chunks: ScopeChunk[] }> {
  const engine = await getEngine();
  const url = new URL(dir, location.href).href;
  const source = await resolveSource(parseSource(url, location.href), (u, i) => fetch(u, i));
  const info = await openPackage(engine, source);
  const table = info.tables.find((t) => t.name === name);
  if (table?.crs.kind !== "known") throw new Error(`no ${name} with a CRS in ${dir}`);
  for (const s of createFeaturesSql) await engine.exec(s);
  const own = chunksOf(table);
  const outlines = outlinesSql(own, table.crs.horizontal.definition);
  for (const r of outlines ? await engine.query(outlines) : []) {
    const c = own[Number(r.i)];
    if (c)
      c.wgs84 = {
        xmin: Number(r.xmin),
        ymin: Number(r.ymin),
        xmax: Number(r.xmax),
        ymax: Number(r.ymax),
      };
  }
  const chunks = own.map((chunk) => ({ chunk, id: nextId++ }));
  for (const { chunk, id } of chunks) {
    await engine.exec(loadChunkSql(chunk, footprintOf(table), table.crs.horizontal.definition, id));
  }
  return { table, chunks };
}

/** Which attribute columns each chunk's local table holds, as the app tracks them. */
const held = new Map<number, string[]>();
async function ensureColumns(chunks: readonly ScopeChunk[], columns: readonly string[]) {
  const engine = await getEngine();
  for (const c of chunks) {
    const have = held.get(c.id) ?? [];
    const missing = attributeColumns(columns).filter((col) => !have.includes(col));
    if (missing.length === 0) continue;
    await engine.exec(loadAttrsSql(c, missing, have));
    held.set(c.id, [...have, ...missing]);
  }
}

let n = 0;
const cond = (
  column: string,
  op: DraftCondition["op"],
  value = "",
  value2 = "",
): DraftCondition => ({
  id: String(n++),
  column,
  op,
  value,
  value2,
});

/** Runs the selection the app would, materialises it, and returns its ids, sorted. */
async function select(
  { table, chunks }: { table: PackageTable; chunks: ScopeChunk[] },
  options: {
    conditions?: DraftCondition[];
    combinator?: "and" | "or";
    extent?: Extent;
    hide?: string[];
  },
): Promise<string[]> {
  const parsed = parseFilter(
    { combinator: options.combinator ?? "and", conditions: options.conditions ?? [] },
    table.columns,
  );
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join("; "));
  const selection: Selection = {
    table: table.name,
    extent: options.extent ?? null,
    filter: parsed.filter,
    hiddenTypes: { all: false, types: options.hide ?? [] },
  };
  const plan = compileSelection(selection, table, chunks, []);
  if (plan.kind !== "ready") throw new Error(plan.kind);
  const engine = await getEngine();
  await ensureColumns(plan.scope.chunks, plan.columns);
  for (const s of materialiseSql(table.name, plan.scope.chunks, plan)) await engine.exec(s);
  const [count] = await engine.query(selectionCountSql(plan.scope.chunks, plan));
  const rows = await engine.query(
    `SELECT f.id FROM ${SELECTION_TABLE} s JOIN ${FEATURES_TABLE} f
       ON f.tbl = s.tbl AND f.file = s.file AND f."row" = s."row" AND f.chunk >= ${chunks[0]?.id}
     WHERE s.tbl = '${table.name}' ORDER BY f.id`,
  );
  expect(Number(count?.n)).toBe(rows.length);
  return rows.map((r) => String(r.id));
}

const cases = expected.cases as Record<string, string[]>;
const area = (name: "delft" | "chuo-ku") => parseExtent(expected.areas[name]);

describe("selections on the Delft fixture", () => {
  let delft: Awaited<ReturnType<typeof placed>>;
  beforeAll(async () => {
    delft = await placed("/fixtures/delft/", "building");
  });

  test("an AND filter on a text and a number column", async () => {
    expect(
      await select(delft, {
        conditions: [
          cond("b3_dak_type", "eq", "slanted"),
          cond("oorspronkelijkbouwjaar", "lt", "1950"),
        ],
      }),
    ).toEqual(cases["delft slanted before 1950"]);
  });

  test("an OR filter", async () => {
    expect(
      await select(delft, {
        combinator: "or",
        conditions: [cond("b3_dak_type", "eq", "horizontal"), cond("b3_h_dak_max", "gt", "20")],
      }),
    ).toEqual(cases["delft horizontal or taller than 20 m"]);
  });

  test("not equals keeps nulls, less than does not", async () => {
    expect(await select(delft, { conditions: [cond("b3_bouwlagen", "ne", "3")] })).toEqual(
      cases["delft storeys not 3"],
    );
    expect(await select(delft, { conditions: [cond("b3_bouwlagen", "lt", "3")] })).toEqual(
      cases["delft storeys below 3"],
    );
  });

  test("contains ignores case", async () => {
    expect(await select(delft, { conditions: [cond("b3_pw_bron", "contains", "HN4")] })).toEqual(
      cases["delft pw source contains HN4"],
    );
  });

  test("a drawn polygon selects the footprints it intersects, alone and with a filter", async () => {
    expect(await select(delft, { extent: area("delft") })).toEqual(cases["delft area"]);
    expect(
      await select(delft, {
        extent: area("delft"),
        conditions: [cond("b3_dak_type", "eq", "horizontal")],
      }),
    ).toEqual(cases["delft area horizontal"]);
  });

  test("a page is sorted by the column's type, and distinct values come from the scope", async () => {
    const plan = compileSelection(
      { table: "building", extent: null, filter: null, hiddenTypes: { all: false, types: [] } },
      delft.table,
      delft.chunks,
      [],
    );
    if (plan.kind !== "ready") throw new Error(plan.kind);
    const engine = await getEngine();
    await ensureColumns(plan.scope.chunks, ["oorspronkelijkbouwjaar", "b3_dak_type"]);
    const page = await engine.query(
      selectionPageSql(plan.scope.chunks, plan, ["id", "oorspronkelijkbouwjaar"], {
        sort: { column: "oorspronkelijkbouwjaar", direction: "asc" },
        limit: 5,
        offset: 0,
      }),
    );
    // As numbers 1455 comes first; as text "1455" would still, so check the order holds.
    const years = page.map((r) => Number(r.oorspronkelijkbouwjaar));
    expect(years[0]).toBe(1455);
    expect([...years].sort((a, b) => a - b)).toEqual(years);
    expect(page[0]).toHaveProperty("__uid");
    const values = await engine.query(distinctValuesSql(plan.scope.chunks, "b3_dak_type", 20));
    expect(values.map((v) => v.v).sort()).toEqual([
      "horizontal",
      "multiple horizontal",
      "slanted",
      "unknown",
    ]);
  });

  test("tiles carry sel when highlighting: 1 for selected rows", async () => {
    await select(delft, { extent: area("delft") });
    const engine = await getEngine();
    const bytes = await engine.queryBytes(
      tileSql({ z: 16, x: 33561, y: 21644 }, { highlight: true }),
    );
    expect(new TextDecoder().decode(bytes ?? undefined)).toContain("sel");
    const plain = await engine.queryBytes(tileSql({ z: 16, x: 33561, y: 21644 }));
    expect(new TextDecoder().decode(plain ?? undefined)).not.toContain("sel");
  });
});

describe("selections on Chuo-ku, two tables", () => {
  test("a filter on buildings, an area on bridges (bbox rectangles), types hidden", async () => {
    const building = await placed("/fixtures/chuo-ku/", "building");
    const bridge = await placed("/fixtures/chuo-ku/", "bridge");
    expect(await select(building, { conditions: [cond("usage", "in", "401, 402")] })).toEqual(
      cases["chuo building usage 401 or 402"],
    );
    expect(await select(bridge, { extent: area("chuo-ku") })).toEqual(cases["chuo bridge area"]);
    expect(await select(bridge, { extent: area("chuo-ku"), hide: ["Bridge"] })).toEqual(
      cases["chuo bridge area without Bridge"],
    );
    // Each table keeps its own rows in selection_rows.
    const engine = await getEngine();
    const per = await engine.query(
      `SELECT tbl, count(*)::INTEGER AS n FROM ${SELECTION_TABLE} WHERE tbl IN ('building', 'bridge') GROUP BY ALL ORDER BY tbl`,
    );
    expect(per).toEqual([
      { tbl: "bridge", n: cases["chuo bridge area without Bridge"]?.length },
      { tbl: "building", n: cases["chuo building usage 401 or 402"]?.length },
    ]);
  });
});
