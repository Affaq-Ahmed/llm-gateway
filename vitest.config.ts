import { defineConfig } from "vitest/config";

// scripts/*.test.mjs use node:test and run under `node --test`.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
