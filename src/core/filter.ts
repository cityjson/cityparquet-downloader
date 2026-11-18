// An attribute filter as data: conditions on one table's columns, joined by AND or OR.
// The filter bar edits a draft of raw strings; `parseFilter` checks it against the
// table's columns and types its values; `compileFilter` turns the result into a SQL
// WHERE fragment. Which operators a column takes follows from its DuckDB type, through
// two tables here and nowhere else.
import type { Column } from "@cityjson/cjconv-core";
import { ident, lit, num, type Sql } from "./sql";

export type ColumnKind = "text" | "number" | "date" | "boolean" | "other";

/** DuckDB type names, as `DESCRIBE` prints them, to a kind. The first match wins. */
const TYPE_KINDS: readonly { pattern: RegExp; kind: ColumnKind }[] = [
  { pattern: /^(VARCHAR|UUID|ENUM\(.*\))$/, kind: "text" },
  {
    pattern:
      /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL\(\d+, ?\d+\))$/,
    kind: "number",
  },
  {
    pattern: /^(DATE|TIMESTAMP|TIMESTAMP WITH TIME ZONE|TIMESTAMP_S|TIMESTAMP_MS|TIMESTAMP_NS)$/,
    kind: "date",
  },
  { pattern: /^BOOLEAN$/, kind: "boolean" },
];

/** A column's kind from its DuckDB type; lists, structs, maps, JSON and geometry are `other`. */
export function kindOf(type: string): ColumnKind {
  return TYPE_KINDS.find((k) => k.pattern.test(type))?.kind ?? "other";
}

type NullOp = "isNull" | "isNotNull";
type TextOp = "eq" | "ne" | "contains" | "startsWith" | "endsWith";
type CompareOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";
export type Op = TextOp | CompareOp | "in" | "between" | "isTrue" | "isFalse" | NullOp;

/** What each operator takes: nothing, one value, two, or a comma-separated list. */
export const ARITY: Readonly<Record<Op, "none" | "one" | "two" | "list">> = {
  eq: "one",
  ne: "one",
  lt: "one",
  le: "one",
  gt: "one",
  ge: "one",
  contains: "one",
  startsWith: "one",
  endsWith: "one",
  in: "list",
  between: "two",
  isTrue: "none",
  isFalse: "none",
  isNull: "none",
  isNotNull: "none",
};

/** An operator's name in a message, whatever the column's kind. */
const OP_NAMES: Readonly<Record<Op, string>> = {
  eq: "equals",
  ne: "does not equal",
  lt: "is less than",
  le: "is at most",
  gt: "is more than",
  ge: "is at least",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  in: "is one of",
  between: "between",
  isTrue: "is true",
  isFalse: "is false",
  isNull: "is null",
  isNotNull: "is not null",
};

export interface OperatorChoice {
  op: Op;
  label: string;
}

const COMPARISONS: readonly OperatorChoice[] = [
  { op: "eq", label: "=" },
  { op: "ne", label: "≠" },
  { op: "lt", label: "<" },
  { op: "le", label: "≤" },
  { op: "gt", label: ">" },
  { op: "ge", label: "≥" },
  { op: "between", label: "between" },
  { op: "isNull", label: "is null" },
  { op: "isNotNull", label: "is not null" },
];

/** The operators each kind offers, in the order the filter bar lists them. */
const OPERATORS: Readonly<Record<ColumnKind, readonly OperatorChoice[]>> = {
  text: [
    { op: "eq", label: "equals" },
    { op: "ne", label: "does not equal" },
    { op: "contains", label: "contains" },
    { op: "startsWith", label: "starts with" },
    { op: "endsWith", label: "ends with" },
    { op: "in", label: "is one of" },
    { op: "isNull", label: "is null" },
    { op: "isNotNull", label: "is not null" },
  ],
  number: COMPARISONS,
  date: COMPARISONS,
  boolean: [
    { op: "isTrue", label: "is true" },
    { op: "isFalse", label: "is false" },
    { op: "isNull", label: "is null" },
    { op: "isNotNull", label: "is not null" },
  ],
  other: [
    { op: "isNull", label: "is null" },
    { op: "isNotNull", label: "is not null" },
  ],
};

export const operatorsFor = (kind: ColumnKind): readonly OperatorChoice[] => OPERATORS[kind];

export type Combinator = "and" | "or";

/** A condition as the filter bar holds it: raw text, checked only by `parseFilter`. */
export interface DraftCondition {
  id: string;
  column: string;
  op: Op;
  /** The value, or the first of `between`, or the comma-separated list of `is one of`. */
  value: string;
  /** The second value of `between`. */
  value2: string;
}

export interface DraftFilter {
  combinator: Combinator;
  conditions: readonly DraftCondition[];
}

export const EMPTY_DRAFT: DraftFilter = { combinator: "and", conditions: [] };

/** A checked condition. Each kind carries only its own operators, with typed values. */
export type Condition =
  | { kind: "text"; column: string; op: TextOp; value: string }
  | { kind: "text"; column: string; op: "in"; value: readonly string[] }
  | { kind: "number"; column: string; op: CompareOp; value: number }
  | { kind: "number"; column: string; op: "between"; value: readonly [number, number] }
  /** Dates are ISO 8601 text, which DuckDB casts to the column's type. */
  | { kind: "date"; column: string; op: CompareOp; value: string }
  | { kind: "date"; column: string; op: "between"; value: readonly [string, string] }
  | { kind: "boolean"; column: string; op: "isTrue" | "isFalse" }
  | { kind: ColumnKind; column: string; op: "isNull" }
  | { kind: ColumnKind; column: string; op: "isNotNull" };

/** A checked filter: at least one condition. No filter at all is `null`. */
export interface Filter {
  combinator: Combinator;
  conditions: readonly Condition[];
}

export type ParsedFilter =
  | { ok: true; filter: Filter | null }
  | { ok: false; errors: { id: string; message: string }[] };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE =
  /^(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

class Invalid extends Error {}

function parseNumber(column: string, text: string): number {
  const t = text.trim();
  if (!NUMBER.test(t)) throw new Invalid(`${column}: "${text}" is not a number`);
  return Number(t);
}

function parseDate(column: string, text: string): string {
  const t = text.trim();
  const m = DATE.exec(t);
  const [y, mo, d] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (!m || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    throw new Invalid(
      `${column}: "${text}" is not a date such as 2024-12-31 or 2024-12-31 23:59:00`,
    );
  }
  return t;
}

function parseCondition(c: DraftCondition, columns: readonly Column[]): Condition {
  const column = columns.find((col) => col.name === c.column);
  if (!column) throw new Invalid(`${c.column} is not a column of this table`);
  const kind = kindOf(column.type);
  if (!OPERATORS[kind].some((o) => o.op === c.op)) {
    throw new Invalid(`${OP_NAMES[c.op]} does not apply to ${c.column} (${column.type})`);
  }
  const name = c.column;
  const op = c.op;
  if (op === "isNull") return { kind, column: name, op };
  if (op === "isNotNull") return { kind, column: name, op };
  if (kind === "boolean" && (op === "isTrue" || op === "isFalse")) {
    return { kind, column: name, op };
  }
  if (kind === "text") {
    if (op === "in") {
      const value = c.value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "");
      if (value.length === 0) {
        throw new Invalid(`${name}: give at least one value, separated by commas`);
      }
      return { kind, column: name, op, value };
    }
    if (c.value === "") throw new Invalid(`${name}: give a value`);
    return { kind, column: name, op: op as TextOp, value: c.value };
  }
  if (kind === "number") {
    if (op === "between") {
      const lo = parseNumber(name, c.value);
      const hi = parseNumber(name, c.value2);
      if (lo > hi) throw new Invalid(`${name}: ${lo} is more than ${hi}`);
      return { kind, column: name, op, value: [lo, hi] };
    }
    return { kind, column: name, op: op as CompareOp, value: parseNumber(name, c.value) };
  }
  if (kind === "date") {
    if (op === "between") {
      return {
        kind,
        column: name,
        op,
        value: [parseDate(name, c.value), parseDate(name, c.value2)],
      };
    }
    return { kind, column: name, op: op as CompareOp, value: parseDate(name, c.value) };
  }
  throw new Invalid(`${OP_NAMES[op]} does not apply to ${name} (${column.type})`);
}

/** Checks a draft against the table's columns. Every invalid condition is reported. */
export function parseFilter(draft: DraftFilter, columns: readonly Column[]): ParsedFilter {
  const conditions: Condition[] = [];
  const errors: { id: string; message: string }[] = [];
  for (const c of draft.conditions) {
    try {
      conditions.push(parseCondition(c, columns));
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      errors.push({ id: c.id, message: e.message });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    filter: conditions.length === 0 ? null : { combinator: draft.combinator, conditions },
  };
}

/** `%`, `_` and the escape character itself, escaped for `LIKE … ESCAPE '\'`. */
const likeEscaped = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

const SQL_COMPARE: Readonly<Record<CompareOp, string>> = {
  eq: "=",
  // A null is not equal to the value, so `≠` keeps it.
  ne: "IS DISTINCT FROM",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

function compileCondition(c: Condition): Sql {
  const col = ident(c.column);
  if (c.op === "isNull") return `${col} IS NULL` as Sql;
  if (c.op === "isNotNull") return `${col} IS NOT NULL` as Sql;
  switch (c.kind) {
    case "boolean":
      return `${col} IS ${c.op === "isTrue" ? "TRUE" : "FALSE"}` as Sql;
    case "text":
      switch (c.op) {
        case "in":
          return `${col} IN (${c.value.map(lit).join(", ")})` as Sql;
        case "contains":
          return `${col} ILIKE ${lit(`%${likeEscaped(c.value)}%`)} ESCAPE '\\'` as Sql;
        case "startsWith":
          return `${col} ILIKE ${lit(`${likeEscaped(c.value)}%`)} ESCAPE '\\'` as Sql;
        case "endsWith":
          return `${col} ILIKE ${lit(`%${likeEscaped(c.value)}`)} ESCAPE '\\'` as Sql;
        default:
          return `${col} ${SQL_COMPARE[c.op]} ${lit(c.value)}` as Sql;
      }
    case "number":
      return c.op === "between"
        ? (`${col} BETWEEN ${num(c.value[0])} AND ${num(c.value[1])}` as Sql)
        : (`${col} ${SQL_COMPARE[c.op]} ${num(c.value)}` as Sql);
    case "date":
      return c.op === "between"
        ? (`${col} BETWEEN ${lit(c.value[0])} AND ${lit(c.value[1])}` as Sql)
        : (`${col} ${SQL_COMPARE[c.op]} ${lit(c.value)}` as Sql);
    default:
      throw new Error(`no SQL for this condition: ${JSON.stringify(c)}`);
  }
}

/**
 * The filter as a WHERE fragment over the table's own column names. Null semantics:
 * `does not equal` keeps nulls; every other comparison, `contains`, `is one of` and
 * `between` leave them out, as SQL does.
 */
export function compileFilter(filter: Filter): Sql {
  const glue = filter.combinator === "and" ? " AND " : " OR ";
  return filter.conditions.map((c) => `(${compileCondition(c)})`).join(glue) as Sql;
}

/** The columns a filter reads, each once, in the order they first appear. */
export function filterColumns(filter: Filter): string[] {
  return [...new Set(filter.conditions.map((c) => c.column))];
}
