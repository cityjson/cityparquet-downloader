import { describe, expect, test } from "vite-plus/test";
import { fileList, lit, num, sql } from "@/core/sql";
import { parseUrl } from "@/core/url";

describe("sql", () => {
  test("quotes a literal once, doubling single quotes", () => {
    expect(lit("it's")).toBe("'it''s'");
    expect(sql`SELECT ${lit("a'b")} AS v`).toBe("SELECT 'a''b' AS v");
  });

  test("refuses a number that is not finite", () => {
    expect(num(1.5)).toBe("1.5");
    expect(() => num(Number.NaN)).toThrow();
  });

  test("lists files as a list of literals", () => {
    const files = [parseUrl("https://h/a.parquet"), parseUrl("https://h/b'.parquet")];
    expect(fileList(files)).toBe("['https://h/a.parquet', 'https://h/b''.parquet']");
  });
});

describe("parseUrl", () => {
  test("resolves a relative URL against a base", () => {
    expect(parseUrl("/fixtures/delft/", "http://127.0.0.1:5173/x")).toBe(
      "http://127.0.0.1:5173/fixtures/delft/",
    );
  });

  test("refuses anything but http and https", () => {
    expect(() => parseUrl("file:///tmp/a.parquet")).toThrow(/http/);
    expect(() => parseUrl("not a url")).toThrow();
  });
});
