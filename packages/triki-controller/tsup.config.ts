import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm"],
  target: "es2020",
  dts: true,
  sourcemap: true,
  treeshake: true,
  // Splitting keeps the core in ONE shared chunk: with two entries and no splitting,
  // dist/node.js would inline a full second copy of TrikiController & co., breaking
  // `instanceof` across entry points and doubling the shipped code.
  splitting: true,
  clean: true,
  outDir: "dist",
  // Optional native dependency for the Node transport — resolved at runtime, never bundled.
  external: ["@abandonware/noble"],
});
