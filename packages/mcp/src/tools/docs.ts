import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { READ_ONLY } from "./annotations.js";

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
      title: "Read a Fillo documentation page",
      description:
        "Fetch a Fillo documentation page as Markdown by topic, straight from the live site so it is " +
        "never stale. No credential needed. Topics: embed (install + render), authoring (defineForm / " +
        "JSX), reference (schema/field reference), styling, troubleshooting, prefill, webhooks, " +
        "custom-ui, api (the read/management API). Read the relevant page before implementing. This " +
        "returns prose docs on how a feature or the API works; to get a form schema and code you can " +
        "adapt, use fillo_search_examples instead.",
      inputSchema: {
        topic: z.enum(TOPICS).describe("Which docs page to fetch."),
      },
      annotations: READ_ONLY,
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
