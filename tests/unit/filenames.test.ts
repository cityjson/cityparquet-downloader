import { execFileSync } from "node:child_process";
import { expect, test } from "vite-plus/test";

// macOS and Windows file systems ignore case, and an import without an extension tries
// `.ts` before `.tsx`. `Legend.tsx` beside `legend.ts` then resolves to the wrong file.
test("no two source files differ only by case or extension", () => {
  const files = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f));
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const file of files) {
    const key = file.replace(/\.tsx?$/, "").toLowerCase();
    const other = seen.get(key);
    if (other) clashes.push(`${other} and ${file}`);
    seen.set(key, file);
  }
  expect(clashes).toEqual([]);
});
