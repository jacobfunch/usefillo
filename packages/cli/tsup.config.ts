import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  // The CLI ships as a self-contained bin (a single dist/index.js run via npx),
  // so inline @usefillo/core instead of externalizing the workspace dependency.
  // This lets the CLI validate schemas with the same core validator the server
  // uses, without requiring core to be installed alongside the published bin.
  noExternal: ["@usefillo/core"],
});
