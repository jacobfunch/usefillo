import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { filloFetch } from "../http.js";
import { fail, ok } from "../result.js";

/** The shipped docs topics, each mirrored at `/docs/<topic>.md`. Fetched from the
 *  live origin so the docs can never go stale inside the published package. */
const TOPICS = [
  "embed",
  "authoring",
  "reference",
  "styling",
  "troubleshooting",
  "prefill",
  "webhooks",
  "custom-ui",
  "api",
] as const;

export function registerDocs(server: McpServer): void {
  server.registerTool(
    "fillo_docs",
    {
      title: localCapability("fillo_docs").title,
      description: localCapability("fillo_docs").description,
      inputSchema: {
        topic: z.enum(TOPICS).describe("Which docs page to fetch."),
      },
      annotations: localCapability("fillo_docs").annotations,
    },
    async ({ topic }) => {
      const res = await filloFetch(`/docs/${topic}.md`);
      if (!res.ok || !res.text) {
        return fail(`Couldn't fetch the "${topic}" docs page (HTTP ${res.status}).`);
      }
      // The page is Markdown, not JSON — return it as the readable body directly.
      return ok(res.text);
    },
  );
}
