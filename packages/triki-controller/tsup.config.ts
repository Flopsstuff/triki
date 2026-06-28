import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm"],
  target: "es2020",
  dts: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  clean: true,
  outDir: "dist",
  // Optional native dependency for the Node transport — resolved at runtime, never bundled.
  external: ["@abandonware/noble"],
});
