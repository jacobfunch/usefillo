import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  // @modelcontextprotocol/sdk and zod stay external: they are declared as
  // runtime dependencies, so `npx @usefillo/mcp` installs them alongside the
  // bin. Bundling them would duplicate zod (already shared with the SDK) and
  // bloat the published tarball for no gain.
});
