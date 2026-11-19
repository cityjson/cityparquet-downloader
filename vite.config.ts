import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type TestProjectInlineConfiguration } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const browser = (name: string, include: string[]): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name,
    include,
    // The tests boot duckdb-wasm and fetch its extensions over the network.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      // CHROMIUM_PATH points at an installed Chromium; without it Playwright's own is used.
      provider: playwright({
        launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
      }),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});

// The worker is bundled from this package; a wasm fetched from jsDelivr must be its version.
const duckdbWasm = JSON.parse(
  readFileSync(new URL("./node_modules/@duckdb/duckdb-wasm/package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __DUCKDB_WASM_VERSION__: JSON.stringify(duckdbWasm.version) },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // duckdb-wasm ships its own worker and .wasm; pre-bundling breaks their ?url imports.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  fmt: {
    printWidth: 100,
    ignorePatterns: [
      "dist/**",
      "fixtures/**",
      "pnpm-lock.yaml",
      "**/*.md",
      "tests/browser/*.expected.json",
    ],
  },
  lint: {
    ignorePatterns: ["dist/**", "fixtures/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    overrides: [
      {
        // src/core is pure TypeScript: it takes an Engine and a Fetch, and runs without a browser.
        files: ["src/core/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                { name: "react", message: "src/core is pure TypeScript: no React." },
                { name: "react-dom", message: "src/core is pure TypeScript: no React." },
                { name: "zustand", message: "src/core is pure TypeScript: no state store." },
                {
                  name: "@duckdb/duckdb-wasm",
                  message: "src/core sends SQL through Engine; DuckDB lives in src/engine.",
                },
              ],
              patterns: [
                {
                  group: ["@/engine*", "@/features*", "@/components*", "@/lib*", "../*"],
                  message: "src/core imports only from itself and @cityjson/cjconv-core.",
                },
              ],
            },
          ],
          "no-restricted-globals": [
            "error",
            { name: "window", message: "src/core runs without a browser." },
            { name: "document", message: "src/core runs without a browser." },
            { name: "location", message: "src/core runs without a browser; take a base URL." },
            { name: "navigator", message: "src/core runs without a browser." },
            { name: "fetch", message: "src/core takes a Fetch argument instead." },
            { name: "Worker", message: "src/core runs without a browser." },
            { name: "localStorage", message: "src/core runs without a browser." },
          ],
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      browser("browser", ["tests/browser/*.test.ts"]),
      // Reads packages hosted by someone else; only with CITYPARQUET_REMOTE=1.
      ...(process.env.CITYPARQUET_REMOTE
        ? [browser("remote", ["tests/browser/remote/*.test.ts"])]
        : []),
    ],
  },
});
