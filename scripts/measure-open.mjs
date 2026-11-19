#!/usr/bin/env node
// Opens a package in the real app and reports what that cost: every request to a
// .parquet or metadata.json URL (method, range, status, bytes), the time until the
// summary or an error shows, and the peak memory of the browser.
//
//   node scripts/measure-open.mjs [package URL] [--timeout ms] [--max-range bytes] [--max-rss bytes]
//
// The package URL defaults to the app's default (3DBAG). The run stops, and says why,
// at a Parquet response longer than --max-range (default 64 MiB), which is a whole-file
// download, or when the browser's memory passes --max-rss (default 4 GiB).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const timeout = Number(flag("timeout", 180_000));
const maxRange = Number(flag("max-range", 64 * 1024 * 1024));
const maxRss = Number(flag("max-rss", 4 * 2 ** 30));
const source = args[0];

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Resident memory of a process and its descendants except `skip`'s subtree, in bytes. */
function treeRss(root, skip) {
  const children = new Map();
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const ppid = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1];
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    } catch {
      // gone
    }
  }
  let total = 0;
  const stack = [String(root)];
  while (stack.length) {
    const pid = stack.pop();
    if (pid === String(skip)) continue;
    try {
      const rss = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      total += rss ? Number(rss[1]) * 1024 : 0;
    } catch {
      // gone
    }
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

const port = await freePort();
const env = { ...process.env };
if (source) env.VITE_CITYPARQUET_URL = source;
const vite = spawn(
  process.execPath,
  [
    path.join(repo, "node_modules/vite-plus/bin/vp"),
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: repo, env, stdio: "ignore", detached: true },
);
const url = `http://127.0.0.1:${port}/`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    if (i > 120) throw new Error("the dev server did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});
const requests = [];
let peakRss = 0;
let stop;
const sampler = setInterval(() => {
  // This process's tree without the dev server: Node itself plus every browser process.
  peakRss = Math.max(peakRss, treeRss(process.pid, vite.pid));
  if (peakRss > maxRss) stop?.(`browser memory above ${maxRss} bytes`);
}, 250);
const started = performance.now();
const ms = () => Math.round(performance.now() - started);

try {
  const context = await browser.newContext();
  // A guard, not an interception: routing a request makes Playwright drop its Range
  // header, which turns every read into a whole-file read.
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  context.on("response", (response) => {
    const length = Number(response.headers()["content-length"] ?? 0);
    if (
      /\.parquet($|\?)/.test(response.url()) &&
      response.request().method() === "GET" &&
      length > maxRange
    ) {
      requests.push({
        at: ms(),
        refused: true,
        url: response.url(),
        status: response.status(),
        length,
      });
      stop(`a ${length}-byte response`);
    }
  });
  context.on("requestfinished", async (request) => {
    if (!/\.parquet($|\?)|metadata\.json$/.test(request.url())) return;
    const response = await request.response();
    const sizes = await request.sizes().catch(() => null);
    requests.push({
      at: ms(),
      method: request.method(),
      url: request.url(),
      range: request.headers().range ?? null,
      status: response?.status(),
      bytes: sizes?.responseBodySize ?? null,
      ms: Math.round(request.timing().responseEnd),
    });
  });
  const page = await context.newPage();
  await page.goto(url);
  const outcome = await Promise.race([
    stopped.then((why) => `stopped: ${why}`),
    page
      .getByRole("table", { name: "Tables" })
      .waitFor({ timeout })
      .then(() => "summary"),
    page
      .getByText("Could not open the package")
      .waitFor({ timeout })
      .then(() => "error"),
  ]).catch(() => "timeout");
  const at = ms();
  // The rendered text is what a user reads
  const text = await page.locator("main").innerText();
  const get = requests.filter((r) => r.method === "GET");
  console.log(
    JSON.stringify(
      {
        source: source ?? "(default)",
        outcome,
        msToOutcome: at,
        peakBrowserRssMiB: Math.round(peakRss / 2 ** 20),
        requests: requests.length,
        getRequests: get.length,
        headRequests: requests.filter((r) => r.method === "HEAD").length,
        bytesReceived: get.reduce((n, r) => n + (r.bytes ?? 0), 0),
        refused: requests.filter((r) => r.refused),
        page: text,
        log: requests,
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sampler);
  await browser.close();
  process.kill(-vite.pid, "SIGTERM");
}
