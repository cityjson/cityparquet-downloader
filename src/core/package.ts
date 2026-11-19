// Opening a package: footers only, through an Engine, never the data.
import type { Engine } from "@cityjson/cjconv-core";
import { type Box, boxFrom, union } from "./box";
import { wgs84ExtentSql } from "./crs";
import { describeSql, kvSql, parseTable, rowGroupsSql, type TableInfo } from "./footer";
import type { ResolvedSource } from "./source";

export interface PackageTable extends TableInfo {
  /** The extent in WGS 84 (longitude as x); null when the CRS is not known. */
  extentWgs84: Box | null;
}

export interface PackageInfo {
  source: ResolvedSource;
  tables: PackageTable[];
  /** The union of the tables' WGS 84 extents. */
  extentWgs84: Box | null;
}

/** Reads every table's footers and transforms its extent to WGS 84. */
export async function openPackage(engine: Engine, source: ResolvedSource): Promise<PackageInfo> {
  const tables: PackageTable[] = [];
  for (const { name, files } of source.tables) {
    const kv = await engine.query(kvSql(files));
    const columns = await engine.query(describeSql(files));
    const rowGroups = await engine.query(rowGroupsSql(files));
    const info = parseTable(name, files, kv, columns, rowGroups);
    tables.push({ ...info, extentWgs84: await extentWgs84(engine, info) });
  }
  return {
    source,
    tables,
    extentWgs84: union(tables.flatMap((t) => (t.extentWgs84 ? [t.extentWgs84] : []))),
  };
}

async function extentWgs84(engine: Engine, table: TableInfo): Promise<Box | null> {
  if (table.crs.kind !== "known" || !table.extent) return null;
  const [row] = await engine.query(wgs84ExtentSql(table.extent, table.crs.horizontal.definition));
  const box = boxFrom(row);
  if (!box) throw new Error(`${table.name}: the extent did not transform to WGS 84`);
  return box;
}
