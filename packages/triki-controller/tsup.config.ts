import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2020",
  dts: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  clean: true,
  outDir: "dist",
});
