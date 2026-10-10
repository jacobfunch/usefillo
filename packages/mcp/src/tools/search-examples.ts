import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok, plural } from "../result.js";

export function registerSearchExamples(server: McpServer): void {
  server.registerTool(
    "fillo_search_examples",
    {
      title: localCapability("fillo_search_examples").title,
      description: localCapability("fillo_search_examples").description,
      inputSchema: {
        q: z
          .string()
          .describe("What you need, e.g. 'contact form with file upload' or 'NPS survey'."),
        kind: z
          .enum(["template", "implementation", "style"])
          .optional()
          .describe("Restrict to one kind of example."),
        framework: z
          .string()
          .optional()
          .describe("Restrict to a framework, e.g. 'react' or 'dom'."),
        capability: z
          .string()
          .optional()
          .describe("Restrict to a capability, e.g. 'uploads' or 'conditional'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe("Max results (1–12, default 5)."),
      },
      annotations: localCapability("fillo_search_examples").annotations,
    },
    async ({ q, kind, framework, capability, limit }) => {
      const searchParams = new URLSearchParams({ q: q ?? "", detail: "full" });
      if (kind) searchParams.set("kind", kind);
      if (framework) searchParams.set("framework", framework);
      if (capability) searchParams.set("capability", capability);
      if (limit) searchParams.set("limit", String(limit));

      const res = await filloFetch("/api/v1/agent-examples/search", { searchParams });
      if (!res.ok || !res.json) {
        return fail(apiErrorMessage(res, "Couldn't search examples"));
      }
      const results = Array.isArray(res.json.results) ? res.json.results : res.json;
      const count = Array.isArray(results) ? results.length : undefined;
      return ok(
        count === undefined
          ? "Example search results below."
          : `${plural(count, "example")} for "${q ?? ""}".`,
        res.json,
      );
    },
  );
}
