// Fails when a file in the build is over 25 MiB, the most Cloudflare Workers serve as one
// static asset. `just build-deploy` runs it on dist/.
//
//   node scripts/check-asset-sizes.mjs [dir]
import fs from "node:fs";
import path from "node:path";

const LIMIT = 25 * 2 ** 20;
const dir = process.argv[2] ?? "dist";
if (!fs.existsSync(dir)) {
  console.error(`${dir} does not exist: build first.`);
  process.exit(1);
}
const files = fs
  .readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => {
    const file = path.join(e.parentPath, e.name);
    return { file, bytes: fs.statSync(file).size };
  })
  .sort((a, b) => b.bytes - a.bytes);
const mib = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
const over = files.filter((f) => f.bytes > LIMIT);
for (const f of over) console.error(`${f.file}: ${mib(f.bytes)}, over the ${mib(LIMIT)} limit`);
if (over.length > 0) process.exit(1);
const [largest] = files;
console.log(
  `${files.length} files in ${dir}, all at most ${mib(LIMIT)}; the largest is ${largest ? `${largest.file} (${mib(largest.bytes)})` : "none"}.`,
);
