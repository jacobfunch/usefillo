import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runner for the loopback + PKCE unit checks. The assertions live in a .mts that
// imports the CLI source directly, so it needs Node's type stripping (>= 22.6
// behind --experimental-strip-types). Probe support and skip cleanly on older
// runtimes — the same "skip where a tool is unavailable" contract as the pty test.
const impl = join(dirname(fileURLToPath(import.meta.url)), "test-loopback.impl.mts");

const probe = spawnSync(process.execPath, ["--experimental-strip-types", "-e", "0"], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  console.log("loopback: skipped (node type stripping unavailable)");
  process.exit(0);
}

const run = spawnSync(process.execPath, ["--experimental-strip-types", impl], { stdio: "inherit" });
process.exit(run.status ?? 1);
