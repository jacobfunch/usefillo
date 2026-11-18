import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["react", "react-dom"],
  // The whole SDK is interactive — mark it client-side for RSC bundlers.
  banner: { js: '"use client";' },
});
