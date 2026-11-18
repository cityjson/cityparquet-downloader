#!/usr/bin/env node
// Drives the CityParquet downloader for verification: one dev server and one headless
// Chromium per run, both started here and only ever stopped by pid.
//
//   control.mjs launch [--source <package URL>] | doctor | cleanup
//   control.mjs browser <goto|click|fill|press|wait|text|snapshot|screenshot|eval> [--flags]
//
// Every command takes --run <name> (default "default"); runs with different names can
// be alive at the same time.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg.startsWith("--"))
    flags[arg.slice(2)] =
      rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? "true" : rest[++i];
  else positional.push(arg);
}
const run = flags.run ?? "default";
const runDir = path.join(repo, ".verify", "runs", run);
const evidenceDir = path.join(repo, ".verify", "evidence", run);
const stateFile = path.join(runDir, "state.json");
const TITLE = "CityParquet downloader";
// The package a launch opens unless --source names another: the fixture the dev server
// serves, so verification needs neither the 14 GB national file nor its host.
const DEFAULT_SOURCE = "/fixtures/delft/";

const readState = () =>
  fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const until = async (what, check, ms = 60_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const head = () => fs.readFileSync(path.join(repo, ".git/HEAD"), "utf8").trim();
const fail = (message) => {
  console.error(`control: ${message}`);
  process.exit(1);
};

async function launch() {
  const existing = readState();
  if (existing && (alive(existing.vitePid) || alive(existing.chromePid))) {
    fail(`run "${run}" is already up at ${existing.url}. Use it, or run cleanup first.`);
  }
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const port = await freePort();
  const cdpPort = await freePort();
  const url = `http://127.0.0.1:${port}/`;

  const source = flags.source ?? DEFAULT_SOURCE;
  const viteLog = fs.openSync(path.join(runDir, "vite.log"), "w");
  const vite = spawn(
    process.execPath,
    [
      path.join(repo, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: repo,
      detached: true,
      stdio: ["ignore", viteLog, viteLog],
      env: { ...process.env, VITE_CITYPARQUET_URL: source },
    },
  );
  vite.unref();

  const chromeLog = fs.openSync(path.join(runDir, "chromium.log"), "w");
  const chrome = spawn(
    process.env.CHROMIUM_PATH || chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${path.join(runDir, "profile")}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", chromeLog, chromeLog] },
  );
  chrome.unref();

  const state = {
    run,
    url,
    source,
    port,
    cdpPort,
    vitePid: vite.pid,
    chromePid: chrome.pid,
    head: head(),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  await until("the dev server", async () => (await fetch(url)).ok);
  await until("Chromium", async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok);
  console.log(JSON.stringify(state, null, 2));
  console.log(`ready: ${url} (evidence goes to ${path.relative(repo, evidenceDir)}/)`);
}

async function doctor() {
  const state = readState();
  if (!state) fail(`no run "${run}". Start one with: control.mjs launch`);
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
  check("dev server process started by this run", alive(state.vitePid), `pid ${state.vitePid}`);
  check("Chromium process started by this run", alive(state.chromePid), `pid ${state.chromePid}`);
  let html = "";
  try {
    html = await (await fetch(state.url)).text();
  } catch (error) {
    html = String(error);
  }
  check("port serves this app", html.includes(`<title>${TITLE}</title>`), state.url);
  let cdp = false;
  try {
    cdp = (await fetch(`http://127.0.0.1:${state.cdpPort}/json/version`)).ok;
  } catch {
    cdp = false;
  }
  check("Chromium answers on its debugging port", cdp, `port ${state.cdpPort}`);
  check(
    "checkout is on the ref it was launched from",
    head() === state.head,
    `${state.head} -> ${head()}`,
  );
  console.log(`package: ${state.source}`);
  for (const c of checks)
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  if (checks.some((c) => !c.ok)) process.exit(1);
}

async function cleanup() {
  const state = readState();
  if (!state) return console.log(`nothing to clean for run "${run}"`);
  for (const pid of [state.vitePid, state.chromePid]) {
    // Each was spawned detached, so -pid is the group this run created and nothing else.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await until(
    "processes to exit",
    () => !alive(state.vitePid) && !alive(state.chromePid),
    10_000,
  ).catch(() => {
    for (const pid of [state.vitePid, state.chromePid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log(`stopped run "${run}". Evidence kept in ${path.relative(repo, evidenceDir)}/`);
}

async function browser() {
  const state = readState();
  if (!state) fail(`no run "${run}". Start one with: control.mjs launch`);
  const [action] = positional;
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`);
  try {
    const context = connection.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    const timeout = Number(flags.timeout ?? 60_000);
    const target = () => {
      if (flags.role)
        return page.getByRole(
          flags.role,
          flags.name ? { name: flags.name, exact: flags.exact === "true" } : {},
        );
      if (flags.label) return page.getByLabel(flags.label);
      if (flags.text) return page.getByText(flags.text);
      if (flags.testid) return page.getByTestId(flags.testid);
      return fail("give a target: --role [--name], --label, --text or --testid");
    };
    const out = (name) => {
      const file = path.resolve(evidenceDir, flags.path ?? name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return file;
    };
    switch (action) {
      case "goto":
        await page.goto(new URL(flags.path ?? "/", state.url).href, { waitUntil: "load", timeout });
        console.log(page.url());
        break;
      case "click":
        await target().click({ timeout });
        break;
      case "fill":
        await target().fill(flags.value ?? "", { timeout });
        break;
      case "press":
        await page.keyboard.press(flags.key);
        break;
      case "wait":
        await target().waitFor({ state: flags.state ?? "visible", timeout });
        console.log("visible");
        break;
      case "text":
        // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is what a user reads
        console.log(await target().first().innerText({ timeout }));
        break;
      case "snapshot": {
        const file = out("snapshot.aria.txt");
        fs.writeFileSync(
          file,
          `${page.url()}\n${await page.title()}\n\n${await page.locator("body").ariaSnapshot()}\n`,
        );
        console.log(path.relative(repo, file));
        break;
      }
      case "screenshot": {
        const file = out("screenshot.png");
        await page.screenshot({ path: file });
        console.log(path.relative(repo, file));
        break;
      }
      case "eval":
        console.log(JSON.stringify(await page.evaluate(flags.js), null, 2));
        break;
      default:
        fail(`unknown browser action "${action}"`);
    }
  } finally {
    await connection.close();
  }
}

const commands = { launch, doctor, cleanup, browser };
if (!commands[command]) fail("usage: control.mjs <launch|doctor|browser|cleanup> [--run name]");
commands[command]().catch((error) => fail(error.message));
