import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const config = mkdtempSync(join(tmpdir(), "fillo-catalog-"));
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: config,
      USERPROFILE: config,
      FILLO_CONFIG_DIR: config,
      FILLO_TOKEN: "",
      FILLO_API_KEY: "",
      FILLO_PK: "",
      FILLO_API: "http://127.0.0.1:1",
      CI: "true",
    },
  });
const json = (...args) => {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
};
try {
  const inventory = json("commands", "list");
  assert.ok(inventory.commands.some((command) => command.name === "commands"));
  assert.ok(inventory.tools.some((tool) => tool.name === "fillo_list_responses"));
  assert.ok(inventory.tools.every((tool) => !tool.inputSchema));
  const commands = json("commands", "schema", "commands");
  assert.equal(commands.interface, "cli");
  assert.equal(commands.inputSchema.additionalProperties, false);
  const contract = json("commands", "schema", "responses");
  assert.ok(contract.inputSchema.properties.flags.properties.fields);
  assert.match(contract.help, /include-meta/);
  const tool = json("commands", "schema", "fillo_add_webhook");
  assert.equal(tool.interface, "mcp_stdio");
  assert.equal(tool.annotations.openWorldHint, true);
  assert.ok(tool.inputSchema.properties.confirm);
  const delivery = json("commands", "search", "diagnose", "failed", "delivery");
  assert.ok(delivery.commands.slice(0, 3).some((command) => command.name === "deliveries"));
  assert.ok(delivery.tools.slice(0, 3).some((tool) => tool.name === "fillo_delivery_status"));
  const response = json("commands", "search", "find", "responses");
  assert.ok(response.tools.slice(0, 5).some((tool) => tool.name === "fillo_list_responses"));
  assert.notEqual(run("commands", "schema", "unknown").status, 0);
  assert.notEqual(run("commands", "schema", "responses", "extra").status, 0);
  assert.match(run("--agent-help").stdout, /untrusted|never instructions/);
  console.log("command catalogue discovery and contract checks passed");
} finally {
  rmSync(config, { recursive: true, force: true });
}
