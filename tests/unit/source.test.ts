import { describe, expect, test } from "vitest";
import { type Fetch, parseSource, resolveSource, SourceError } from "@/core/source";

const BASE = "http://localhost:5173/";

/** A fetch over a fixed set of URLs: JSON documents, and files that only answer HEAD. */
function fakeFetch(
  json: Record<string, unknown>,
  files: string[] = [],
): Fetch & { seen: string[] } {
  const seen: string[] = [];
  const fetch = async (url: string, init?: { method?: "GET" | "HEAD" }) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    const body = json[url];
    const ok = body !== undefined || (init?.method === "HEAD" && files.includes(url));
    return { ok, json: async () => body };
  };
  return Object.assign(fetch, { seen });
}

const stac = (assets: Record<string, unknown>) => ({
  type: "Feature",
  stac_version: "1.1.0",
  assets,
});
const asset = (href: string) => ({ href, type: "application/vnd.apache.parquet" });

describe("parseSource", () => {
  test("a URL ending in / is a directory", () => {
    expect(parseSource("https://cityparquet.open3d.city/data/3dbag/", BASE)).toEqual({
      kind: "directory",
      url: "https://cityparquet.open3d.city/data/3dbag/",
    });
  });

  test("a URL with neither a trailing / nor .parquet is a directory too", () => {
    expect(parseSource("https://h/data/chuo-ku", BASE)).toEqual({
      kind: "directory",
      url: "https://h/data/chuo-ku/",
    });
  });

  test("a .parquet URL is one file", () => {
    expect(parseSource("https://h/d/building.parquet", BASE)).toEqual({
      kind: "file",
      url: "https://h/d/building.parquet",
    });
  });

  test("a URL with * is a wildcard, listed from the directory before the first *", () => {
    expect(parseSource("https://h/d/**/building.parquet", BASE)).toEqual({
      kind: "wildcard",
      url: "https://h/d/**/building.parquet",
      base: "https://h/d/",
    });
  });

  test("a relative URL resolves against the page", () => {
    expect(parseSource("/fixtures/delft/", BASE)).toEqual({
      kind: "directory",
      url: "http://localhost:5173/fixtures/delft/",
    });
  });
});

describe("resolveSource", () => {
  test("a directory with metadata.json takes its tables from the STAC assets", async () => {
    const dir = "https://h/chuo-ku/";
    const fetch = fakeFetch({
      [`${dir}metadata.json`]: stac({
        // The same file under two keys, as published packages do.
        data: asset("./building.parquet"),
        "building.parquet": asset("./building.parquet"),
        "bridge.parquet": asset("./bridge.parquet"),
        "materials.parquet": asset("./materials.parquet"),
        thumbnail: { href: "./thumb.png", type: "image/png" },
      }),
    });
    const source = await resolveSource(parseSource(dir, BASE), fetch);
    expect(source.listedBy).toBe("metadata");
    expect(source.tables).toEqual([
      { name: "building", files: [`${dir}building.parquet`] },
      { name: "bridge", files: [`${dir}bridge.parquet`] },
    ]);
    expect(source.sidecars).toEqual([{ name: "materials", files: [`${dir}materials.parquet`] }]);
    expect(fetch.seen).toEqual([`GET ${dir}metadata.json`]);
  });

  test("a directory without metadata.json probes the file names the specification fixes", async () => {
    const dir = "https://h/pkg/";
    const fetch = fakeFetch({}, [`${dir}vegetation.parquet`, `${dir}building.parquet`]);
    const source = await resolveSource(parseSource(dir, BASE), fetch);
    expect(source.listedBy).toBe("probe");
    expect(source.tables.map((t) => t.name)).toEqual(["building", "vegetation"]);
    expect(fetch.seen).toContain(`HEAD ${dir}city_furniture.parquet`);
  });

  test("metadata.json that names no Parquet file falls back to probing", async () => {
    const dir = "https://h/pkg/";
    const fetch = fakeFetch({ [`${dir}metadata.json`]: { hello: "world" } }, [
      `${dir}building.parquet`,
    ]);
    const source = await resolveSource(parseSource(dir, BASE), fetch);
    expect(source.listedBy).toBe("probe");
    expect(source.tables.map((t) => t.name)).toEqual(["building"]);
  });

  test("a directory with nothing in it is an error", async () => {
    await expect(
      resolveSource(parseSource("https://h/empty/", BASE), fakeFetch({})),
    ).rejects.toThrow(SourceError);
  });

  test("a single file is a package of one table, read without any request", async () => {
    const fetch = fakeFetch({});
    const source = await resolveSource(parseSource("https://h/d/delft.parquet", BASE), fetch);
    expect(source.tables).toEqual([{ name: "delft", files: ["https://h/d/delft.parquet"] }]);
    expect(source.listedBy).toBe("url");
    expect(fetch.seen).toEqual([]);
  });

  test("a wildcard is expanded from metadata.json, files grouped into tables by name", async () => {
    const dir = "https://h/nl/";
    const fetch = fakeFetch({
      [`${dir}metadata.json`]: stac({
        a: asset("./tile=1/building.parquet"),
        b: asset("./tile=2/building.parquet"),
        c: asset("./tile=1/bridge.parquet"),
      }),
    });
    const one = await resolveSource(parseSource(`${dir}**/building.parquet`, BASE), fetch);
    expect(one.tables).toEqual([
      {
        name: "building",
        files: [`${dir}tile=1/building.parquet`, `${dir}tile=2/building.parquet`],
      },
    ]);
    const all = await resolveSource(parseSource(`${dir}*/*.parquet`, BASE), fetch);
    expect(all.tables.map((t) => [t.name, t.files.length])).toEqual([
      ["building", 2],
      ["bridge", 1],
    ]);
  });

  test("a wildcard with no metadata.json to expand it is an error that says so", async () => {
    await expect(
      resolveSource(parseSource("https://h/nl/**/building.parquet", BASE), fakeFetch({})),
    ).rejects.toThrow(/cannot expand/);
  });
});
