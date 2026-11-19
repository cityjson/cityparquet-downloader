// SQL text. Values reach a statement only through these functions, so quoting happens
// in one place and a plain string cannot be interpolated by accident.
import { quoteIdent, quoteLiteral } from "@cityjson/cjconv-core";
import type { Url } from "./url";

declare const sqlBrand: unique symbol;
export type Sql = string & { readonly [sqlBrand]: true };

/** A string literal. */
export const lit = (value: string): Sql => quoteLiteral(value) as Sql;

/** A quoted identifier. */
export const ident = (name: string): Sql => quoteIdent(name) as Sql;

/** A numeric literal. */
export function num(value: number): Sql {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  return String(value) as Sql;
}

/** A list of file URLs, as the Parquet table functions take it. */
export const fileList = (files: readonly Url[]): Sql => `[${files.map(lit).join(", ")}]` as Sql;

/** A statement whose interpolated parts are SQL already: `sql\`SELECT ${lit(x)}\``. */
export function sql(strings: TemplateStringsArray, ...parts: Sql[]): Sql {
  return strings.reduce((text, s, i) => text + s + (parts[i] ?? ""), "") as Sql;
}
