import { defineConfig } from "vitest/config";

// Node environment: the source only needs EventTarget, performance.now(), DataView
// and Uint8Array, all of which Node provides — no jsdom. Tests import { test, expect,
// vi, ... } from "vitest" explicitly (globals stay off) so tsconfig's restrictive
// `types: ["web-bluetooth"]` does not need touching.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/testkit/**", "src/index.ts"],
    },
  },
});
