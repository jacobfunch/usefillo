import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: ["src/client.ts"],
  format: ["iife"],
  globalName: "FilloStorageCanary",
  noExternal: ["zod"],
  outDir: "../../.data-storage-canary",
  dts: false,
  clean: true,
  minify: false,
  define: { __FILLO_SDK_VERSION__: JSON.stringify(version) },
});
