import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // duckdb-wasm ships its own worker and .wasm; pre-bundling breaks their ?url imports.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  test: {
    include: ["tests/browser/**/*.test.ts"],
    // The tests boot duckdb-wasm and fetch extensions and data over the network.
    testTimeout: 120_000,
    browser: {
      enabled: true,
      // CHROMIUM_PATH points at an already installed Chromium; without it Playwright's own is used.
      provider: playwright({
        launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
      }),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
