import { describe, expect, test } from "vite-plus/test";
import {
  compileFilter,
  type DraftCondition,
  type DraftFilter,
  type Filter,
  filterColumns,
  kindOf,
  type Op,
  operatorsFor,
  parseFilter,
} from "@/core/filter";

const columns = [
  { name: "b3_dak_type", type: "VARCHAR" },
  { name: "oorspronkelijkbouwjaar", type: "BIGINT" },
  { name: "b3_h_dak_max", type: "DOUBLE" },
  { name: "b3_is_glas_dak", type: "BOOLEAN" },
  { name: "tijdstipregistratie", type: "TIMESTAMP WITH TIME ZONE" },
  { name: "creationDate", type: "DATE" },
  { name: "children", type: "VARCHAR[]" },
  { name: 'odd "name" ', type: "VARCHAR" },
];

let n = 0;
const cond = (column: string, op: Op, value = "", value2 = ""): DraftCondition => ({
  id: `c${n++}`,
  column,
  op,
  value,
  value2,
});
const draft = (...conditions: DraftCondition[]): DraftFilter => ({
  combinator: "and",
  conditions,
});

/** Parses a draft that must be valid, and compiles it. */
function where(d: DraftFilter): string {
  const parsed = parseFilter(d, columns);
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join("; "));
  if (!parsed.filter) throw new Error("empty");
  return compileFilter(parsed.filter);
}

describe("kindOf", () => {
  test("maps DuckDB types to a column kind; lists, structs and geometry are other", () => {
    expect(
      [
        "VARCHAR",
        "BIGINT",
        "DECIMAL(18,3)",
        "UBIGINT",
        "DATE",
        "TIMESTAMP WITH TIME ZONE",
        "BOOLEAN",
        "VARCHAR[]",
        "STRUCT(a INTEGER)",
        "GEOMETRY('EPSG:7415')",
        "JSON",
        "ENUM('a', 'b')",
      ].map(kindOf),
    ).toEqual([
      "text",
      "number",
      "number",
      "number",
      "date",
      "date",
      "boolean",
      "other",
      "other",
      "other",
      "other",
      "text",
    ]);
  });

  test("offers each kind only its own operators", () => {
    const ops = (type: string) => operatorsFor(kindOf(type)).map((o) => o.op);
    expect(ops("VARCHAR")).toEqual([
      "eq",
      "ne",
      "contains",
      "startsWith",
      "endsWith",
      "in",
      "isNull",
      "isNotNull",
    ]);
    expect(ops("BIGINT")).toEqual([
      "eq",
      "ne",
      "lt",
      "le",
      "gt",
      "ge",
      "between",
      "isNull",
      "isNotNull",
    ]);
    expect(ops("DATE")).toEqual(ops("BIGINT"));
    expect(ops("BOOLEAN")).toEqual(["isTrue", "isFalse", "isNull", "isNotNull"]);
    expect(ops("VARCHAR[]")).toEqual(["isNull", "isNotNull"]);
  });
});

describe("compileFilter", () => {
  test("quotes identifiers and literals: embedded quotes are doubled", () => {
    expect(where(draft(cond('odd "name" ', "eq", "it's")))).toBe(`("odd ""name"" " = 'it''s')`);
  });

  test("text operators, with LIKE wildcards in the value escaped", () => {
    expect(where(draft(cond("b3_dak_type", "contains", "50%_a\\b")))).toBe(
      `("b3_dak_type" ILIKE '%50\\%\\_a\\\\b%' ESCAPE '\\')`,
    );
    expect(where(draft(cond("b3_dak_type", "startsWith", "sl")))).toBe(
      `("b3_dak_type" ILIKE 'sl%' ESCAPE '\\')`,
    );
    expect(where(draft(cond("b3_dak_type", "endsWith", "ted")))).toBe(
      `("b3_dak_type" ILIKE '%ted' ESCAPE '\\')`,
    );
    expect(where(draft(cond("b3_dak_type", "in", " slanted, horizontal ,, x'y ")))).toBe(
      `("b3_dak_type" IN ('slanted', 'horizontal', 'x''y'))`,
    );
  });

  test("not equals keeps nulls; the other comparisons leave them out", () => {
    expect(where(draft(cond("b3_dak_type", "ne", "slanted")))).toBe(
      `("b3_dak_type" IS DISTINCT FROM 'slanted')`,
    );
    expect(where(draft(cond("oorspronkelijkbouwjaar", "ne", "1950")))).toBe(
      `("oorspronkelijkbouwjaar" IS DISTINCT FROM 1950)`,
    );
    expect(where(draft(cond("oorspronkelijkbouwjaar", "lt", "1950")))).toBe(
      `("oorspronkelijkbouwjaar" < 1950)`,
    );
    expect(where(draft(cond("b3_dak_type", "isNull")))).toBe(`("b3_dak_type" IS NULL)`);
    expect(where(draft(cond("children", "isNotNull")))).toBe(`("children" IS NOT NULL)`);
  });

  test("numbers, dates and booleans", () => {
    expect(where(draft(cond("b3_h_dak_max", "between", "2.5", "1e1")))).toBe(
      `("b3_h_dak_max" BETWEEN 2.5 AND 10)`,
    );
    expect(where(draft(cond("oorspronkelijkbouwjaar", "ge", " -3 ")))).toBe(
      `("oorspronkelijkbouwjaar" >= -3)`,
    );
    expect(where(draft(cond("creationDate", "le", "2020-02-29")))).toBe(
      `("creationDate" <= '2020-02-29')`,
    );
    expect(where(draft(cond("tijdstipregistratie", "gt", "2010-01-01 12:30:00+01:00")))).toBe(
      `("tijdstipregistratie" > '2010-01-01 12:30:00+01:00')`,
    );
    expect(where(draft(cond("b3_is_glas_dak", "isTrue")))).toBe(`("b3_is_glas_dak" IS TRUE)`);
    expect(where(draft(cond("b3_is_glas_dak", "isFalse")))).toBe(`("b3_is_glas_dak" IS FALSE)`);
  });

  test("joins conditions with the filter's combinator", () => {
    const a = cond("b3_dak_type", "eq", "slanted");
    const b = cond("oorspronkelijkbouwjaar", "lt", "1950");
    expect(where({ combinator: "and", conditions: [a, b] })).toBe(
      `("b3_dak_type" = 'slanted') AND ("oorspronkelijkbouwjaar" < 1950)`,
    );
    expect(where({ combinator: "or", conditions: [a, b] })).toBe(
      `("b3_dak_type" = 'slanted') OR ("oorspronkelijkbouwjaar" < 1950)`,
    );
  });
});

describe("parseFilter", () => {
  test("an empty draft is no filter", () => {
    expect(parseFilter(draft(), columns)).toEqual({ ok: true, filter: null });
  });

  test("keeps the parsed values typed by the column's kind", () => {
    const parsed = parseFilter(
      draft(
        cond("oorspronkelijkbouwjaar", "between", "1900", "1950"),
        cond("b3_dak_type", "in", "a,b"),
      ),
      columns,
    );
    expect(parsed).toEqual({
      ok: true,
      filter: {
        combinator: "and",
        conditions: [
          {
            kind: "number",
            column: "oorspronkelijkbouwjaar",
            op: "between",
            value: [1900, 1950],
          },
          { kind: "text", column: "b3_dak_type", op: "in", value: ["a", "b"] },
        ],
      } satisfies Filter,
    });
  });

  test("refuses each invalid condition with a message naming it", () => {
    const bad = [
      cond("nope", "eq", "x"),
      cond("oorspronkelijkbouwjaar", "contains", "19"),
      cond("oorspronkelijkbouwjaar", "eq", "19x"),
      cond("oorspronkelijkbouwjaar", "eq", "0x10"),
      cond("oorspronkelijkbouwjaar", "between", "1950", "1900"),
      cond("b3_h_dak_max", "between", "1", ""),
      cond("b3_dak_type", "eq", ""),
      cond("b3_dak_type", "in", " , "),
      cond("creationDate", "eq", "2020-02-30"),
      cond("creationDate", "eq", "yesterday"),
      cond("children", "eq", "x"),
      cond("b3_is_glas_dak", "eq", "true"),
    ];
    const parsed = parseFilter(draft(...bad), columns);
    if (parsed.ok) throw new Error("parsed");
    expect(parsed.errors.map((e) => e.id)).toEqual(bad.map((c) => c.id));
    expect(parsed.errors.map((e) => e.message)).toEqual([
      "nope is not a column of this table",
      "contains does not apply to oorspronkelijkbouwjaar (BIGINT)",
      'oorspronkelijkbouwjaar: "19x" is not a number',
      'oorspronkelijkbouwjaar: "0x10" is not a number',
      "oorspronkelijkbouwjaar: 1950 is more than 1900",
      'b3_h_dak_max: "" is not a number',
      "b3_dak_type: give a value",
      "b3_dak_type: give at least one value, separated by commas",
      'creationDate: "2020-02-30" is not a date such as 2024-12-31 or 2024-12-31 23:59:00',
      'creationDate: "yesterday" is not a date such as 2024-12-31 or 2024-12-31 23:59:00',
      "equals does not apply to children (VARCHAR[])",
      "equals does not apply to b3_is_glas_dak (BOOLEAN)",
    ]);
  });
});

test("filterColumns lists each column a filter reads once", () => {
  const parsed = parseFilter(
    draft(
      cond("b3_dak_type", "eq", "a"),
      cond("oorspronkelijkbouwjaar", "isNull"),
      cond("b3_dak_type", "ne", "b"),
    ),
    columns,
  );
  if (!parsed.ok || !parsed.filter) throw new Error("invalid");
  expect(filterColumns(parsed.filter)).toEqual(["b3_dak_type", "oorspronkelijkbouwjaar"]);
});
