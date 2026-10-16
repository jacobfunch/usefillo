import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveApiKey } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok, plural, untrusted } from "../result.js";

const NEEDS_KEY =
  "Reading a response needs a project API key (`fsk_…`). This works only in a CLAIMED workspace: " +
  "claim it, then mint a key in Settings → Connections and set FILLO_API_KEY.";

export function registerGetResponse(server: McpServer): void {
  server.registerTool(
    "fillo_get_response",
    {
      title: localCapability("fillo_get_response").title,
      description: localCapability("fillo_get_response").description,
      inputSchema: {
        id: z.string().describe("Response id (e.g. from fillo_list_responses)."),
      },
      annotations: localCapability("fillo_get_response").annotations,
    },
    async ({ id }) => {
      const apiKey = resolveApiKey();
      if (!apiKey) return fail(NEEDS_KEY);

      const res = await filloFetch(`/api/v1/manage/responses/${encodeURIComponent(id)}`, {
        token: apiKey,
      });
      if (res.status === 401) return fail(NEEDS_KEY);
      if (res.status === 403) {
        return fail(
          "This API key is missing the responses:read scope. Mint a key with read access in Settings → Connections.",
        );
      }
      if (res.status === 404) {
        return fail(
          `No response "${id}" in this key's project (it may be withheld, deleted, or in another project).`,
        );
      }
      if (!res.ok || typeof res.json?.id !== "string") {
        return fail(apiErrorMessage(res, "Couldn't fetch the response"));
      }
      const fileCount = Array.isArray(res.json.files) ? res.json.files.length : 0;
      return ok(
        `Response "${res.json.id}" on form "${res.json.formId}"` +
          (fileCount ? ` with ${plural(fileCount, "file reference")}.` : "."),
        untrusted(res.json),
      );
    },
  );
}
