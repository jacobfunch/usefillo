import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { READ_ONLY } from "./annotations.js";

export function registerGetForm(server: McpServer): void {
  server.registerTool(
    "fillo_get_form",
    {
      title: "Get a published form's schema",
      description:
        "Fetch a published form's schema, theme, capabilities, and closed flag by form id or slug. " +
        "No credential needed — only published forms are served (drafts return not-found). Use this " +
        "to verify what went live after fillo_publish_form (or a direct regular push), or to read an " +
        "existing form before editing it.",
      inputSchema: {
        form: z
          .string()
          .describe("Form id or slug (the trailing id of a /f/<slug> URL also works)."),
      },
      annotations: READ_ONLY,
    },
    async ({ form }) => {
      const res = await filloFetch(`/api/v1/forms/${encodeURIComponent(form)}`);
      if (res.status === 404) {
        return fail(
          `No published form "${form}". It may be a draft (publish it first) or the id/slug may be wrong.`,
        );
      }
      if (!res.ok || typeof res.json?.id !== "string") {
        return fail(apiErrorMessage(res, "Couldn't fetch the form"));
      }
      const title =
        res.json.schema && typeof res.json.schema.title === "string"
          ? res.json.schema.title
          : undefined;
      return ok(
        `Form "${res.json.id}"${title ? ` — "${title}"` : ""}${res.json.closed ? " (closed to new responses)" : ""}.`,
        res.json,
      );
    },
  );
}
