import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // The SDK's self-reported version (min-SDK gate, X-Fillo-Client header) is
  // injected from package.json so it can never drift from the published
  // version again — it sat at "0.5.0" through two releases.
  define: { __FILLO_SDK_VERSION__: JSON.stringify(version) },
});
