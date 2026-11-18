import { describe, expect, test } from "vitest";
import { densifiedRing, parseCrs, wgs84ExtentSql } from "@/core/crs";

const RD_NEW = {
  type: "ProjectedCRS",
  name: "Amersfoort / RD New",
  base_crs: { name: "Amersfoort", id: { authority: "EPSG", code: 4289 } },
  conversion: { name: "RD New" },
  coordinate_system: { subtype: "Cartesian", axis: [] },
};
const NAP = { type: "VerticalCRS", name: "NAP height" };
const COMPOUND = {
  type: "CompoundCRS",
  name: "Amersfoort / RD New + NAP height",
  components: [RD_NEW, NAP],
  id: { authority: "EPSG", code: 7415 },
};

describe("parseCrs", () => {
  test("a compound CRS uses its horizontal part, as PROJJSON when it has no code", () => {
    const crs = parseCrs({ crs: COMPOUND });
    expect(crs).toEqual({
      kind: "known",
      name: "Amersfoort / RD New + NAP height",
      code: { authority: "EPSG", code: "7415" },
      horizontal: {
        name: "Amersfoort / RD New",
        code: null,
        definition: JSON.stringify(RD_NEW),
      },
    });
  });

  test("a horizontal part with its own code is named by the code", () => {
    const rd = { ...RD_NEW, id: { authority: "EPSG", code: 28992 } };
    const crs = parseCrs({ crs: { ...COMPOUND, components: [NAP, rd] } });
    expect(crs.kind === "known" && crs.horizontal).toEqual({
      name: "Amersfoort / RD New",
      code: { authority: "EPSG", code: "28992" },
      definition: "EPSG:28992",
    });
  });

  test("a single CRS is its own horizontal part", () => {
    const crs = parseCrs({ crs: { ...RD_NEW, id: { authority: "EPSG", code: 28992 } } });
    expect(crs.kind === "known" && crs.horizontal.definition).toBe("EPSG:28992");
  });

  test("an explicit null is a CRS that is not known, and a missing key is none at all", () => {
    expect(parseCrs({ crs: null })).toEqual({ kind: "unknown" });
    expect(parseCrs({})).toEqual({ kind: "none" });
  });

  test("a CRS with no horizontal part is not known", () => {
    expect(parseCrs({ crs: NAP })).toEqual({ kind: "unknown" });
  });
});

describe("wgs84ExtentSql", () => {
  const box = { xmin: 0, ymin: 0, xmax: 4, ymax: 2 };

  test("densifies every edge and closes the ring", () => {
    const ring = densifiedRing(box, 4);
    expect(ring).toHaveLength(17);
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring).toContainEqual([2, 0]);
    expect(ring).toContainEqual([4, 1]);
  });

  test("transforms with always_xy, so coordinates are read as x = east whatever the CRS says", () => {
    const sql = wgs84ExtentSql(box, "EPSG:28992");
    expect(sql).toContain("ST_Transform(");
    expect(sql).toContain("'EPSG:28992', 'EPSG:4326', always_xy := true");
    expect(sql).toMatch(/ST_XMin\(g\) AS xmin/);
  });
});
