import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveApiKey } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok, plural, untrusted } from "../result.js";

const NEEDS_KEY =
  "Summarizing responses needs a project API key (`fsk_…`). This works only in a CLAIMED " +
  "workspace: claim it, then mint a key in Settings → Connections and set FILLO_API_KEY. A `pk_` " +
  "key or login token cannot read responses.";

export function registerResponseSummary(server: McpServer): void {
  server.registerTool(
    "fillo_response_summary",
    {
      title: localCapability("fillo_response_summary").title,
      description: localCapability("fillo_response_summary").description,
      inputSchema: {
        form: z.string().describe("Form id or slug to summarize."),
        excludeFields: z
          .array(z.string())
          .optional()
          .describe("Field ids to keep OUT of the recent sample's answers (e.g. long free text)."),
        recent: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe("How many recent responses to sample (0–20, default 5)."),
      },
      annotations: localCapability("fillo_response_summary").annotations,
    },
    async ({ form, excludeFields, recent }) => {
      const apiKey = resolveApiKey();
      if (!apiKey) return fail(NEEDS_KEY);

      const searchParams = new URLSearchParams();
      if (excludeFields?.length) searchParams.set("exclude", excludeFields.join(","));
      if (recent !== undefined) searchParams.set("recent", String(recent));

      const res = await filloFetch(
        `/api/v1/manage/forms/${encodeURIComponent(form)}/responses/summary`,
        { token: apiKey, searchParams },
      );
      if (res.status === 401) return fail(NEEDS_KEY);
      if (res.status === 403) {
        return fail(
          "This API key is missing the responses:read scope. Mint a key with read access in Settings → Connections.",
        );
      }
      if (res.status === 404) {
        return fail(
          `No form "${form}" in this key's project. Check the id, or the key may belong to another project.`,
        );
      }
      if (!res.ok || typeof res.json?.total !== "number") {
        return fail(apiErrorMessage(res, "Couldn't summarize responses"));
      }
      return ok(
        `${plural(res.json.total, "accepted response")} on form "${res.json.formId}"` +
          (res.json.lastAt ? ` (latest ${res.json.lastAt}).` : "."),
        untrusted(res.json),
      );
    },
  );
}
