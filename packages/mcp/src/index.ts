import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLIENT_VERSION, apiOrigin } from "./config.js";
import { registerTools } from "./tools/index.js";

/**
 * The Fillo MCP server. A thin stdio client over Fillo's public HTTP API: it
 * provisions/claims workspaces, scaffolds and publishes forms, reads docs and
 * examples, and queries responses — using exactly the credentials a human has
 * (`~/.fillo/config.json` or FILLO_TOKEN / FILLO_PK / FILLO_API_KEY). It never
 * touches the database and imports no app code, so project isolation, workspace-wide rate
 * limits, and validation all stay server-side.
 *
 * stdout is the JSON-RPC channel — diagnostics go to stderr only, never stdout.
 */
async function main(): Promise<void> {
  const version = CLIENT_VERSION.split("@").pop() ?? "0.0.0";
  const server = new McpServer({ name: "fillo", version });
  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // A single startup line on stderr aids debugging without corrupting stdout.
  process.stderr.write(`Fillo MCP server ready (${CLIENT_VERSION}) → ${apiOrigin()}\n`);
}

main().catch((error) => {
  process.stderr.write(`Fillo MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
