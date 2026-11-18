import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { localCapability, searchCapabilities } from "./capabilities.js";
import { fail, ok } from "./result.js";
import { READ_ONLY } from "./tools/annotations.js";
import { registerTools } from "./tools/index.js";

function catalogueResult(summary: string, data: Record<string, unknown>) {
  return { ...ok(summary, data), structuredContent: data };
}

/** Build the native catalogue without opening a transport or calling an API.
 * Discovery activates the original registration on the connected server;
 * there is no generic executor that could bypass validation or confirmations. */
export function registerDiscovery(server: McpServer): void {
  const source = new McpServer({ name: "fillo-catalog", version: "1" });
  const registrations = new Map<string, () => void>();
  const register = source.registerTool.bind(source);
  source.registerTool = ((name: string, config: unknown, callback: unknown) => {
    registrations.set(name, () => {
      Reflect.apply(server.registerTool, server, [name, config, callback]);
    });
    return Reflect.apply(register, source, [name, config, callback]);
  }) as McpServer["registerTool"];
  registerTools(source);
  const activated = new Set<string>();

  server.registerTool(
    "fillo_search_tools",
    {
      title: "Find Fillo tools",
      description:
        "Search Fillo capabilities by task. Returns names, task areas, and permission hints without full schemas. Fetch a schema with fillo_get_tool_schema before calling its native tool.",
      annotations: { ...READ_ONLY, title: "Find Fillo tools" },
      outputSchema: {
        tools: z.array(
          z.object({
            name: z.string(),
            title: z.string(),
            toolsets: z.array(z.string()),
            annotations: z.record(z.string(), z.unknown()),
          }),
        ),
      },
      inputSchema: {
        query: z
          .string()
          .max(200)
          .describe("Task words such as 'publish form', 'responses', or 'delivery'."),
        limit: z.number().int().min(1).max(20).default(10),
      },
    },
    async ({ query, limit }) =>
      catalogueResult("Matching Fillo tools.", { tools: searchCapabilities(query, limit) }),
  );

  server.registerTool(
    "fillo_get_tool_schema",
    {
      title: "Read and activate a Fillo tool",
      description:
        "Return one native tool's complete contract and make that tool available on this connection. Call it by its original name; its credential, validation, and human-confirmation requirements still apply.",
      annotations: { ...READ_ONLY, title: "Read and activate a Fillo tool" },
      outputSchema: {
        name: z.string(),
        title: z.string(),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
        annotations: z.record(z.string(), z.unknown()),
      },
      inputSchema: {
        name: z.string().min(1).max(100).describe("Exact name from fillo_search_tools."),
      },
    },
    async ({ name }) => {
      const registration = registrations.get(name);
      if (!registration) return fail("Unknown tool. Find a name with fillo_search_tools.");
      if (!activated.has(name)) {
        registration();
        activated.add(name);
      }
      return catalogueResult(
        "Call this tool by its native name. Its approval requirements still apply.",
        {
          name,
          ...localCapability(name),
        },
      );
    },
  );
}
