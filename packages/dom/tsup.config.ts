import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    external: ["@usefillo/core"],
  },
  {
    entry: { standalone: "src/standalone.ts" },
    format: ["iife"],
    globalName: "Fillo",
    dts: false,
    clean: false,
    // This bundle is loaded straight into the browser via <script> (no consumer
    // bundler to minify it), so minify here — unlike the ESM build, which the
    // host app's bundler optimizes and which stays readable for tree-shaking.
    minify: true,
    noExternal: ["@usefillo/core"],
    outExtension: () => ({ js: ".global.js" }),
  },
]);
