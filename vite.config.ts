import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // duckdb-wasm ships its own worker and .wasm; pre-bundling breaks their ?url imports.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
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
