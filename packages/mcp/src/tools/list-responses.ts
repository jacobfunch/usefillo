import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural, untrusted } from "../result.js";
import { gridSearchParams, laneCall, noForm } from "./lane.js";

export function registerListResponses(server: McpServer): void {
  server.registerTool(
    "fillo_list_responses",
    {
      title: localCapability("fillo_list_responses").title,
      description: localCapability("fillo_list_responses").description,
      inputSchema: {
        form: z.string().describe("Form id or slug to read responses from."),
        range: z.string().optional().describe("Date range filter (grid grammar)."),
        q: z.string().optional().describe("Full-text search across answers."),
        source: z.string().optional().describe("Filter by response source."),
        respondent: z.string().optional().describe("Filter by respondent id."),
        where: z
          .array(z.string())
          .optional()
          .describe("Field filters, each `fieldId:op:value`, e.g. ['score:eq:10']."),
        includeFields: z
          .array(z.string().min(1).max(200))
          .max(100)
          .optional()
          .describe("Only these answer field ids; [] returns no answers."),
        includeMeta: z.boolean().optional().describe("Set false to return metadata as null."),
        cursor: z.string().optional().describe("Opaque cursor from a prior page's nextCursor."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Page size (default server-set)."),
      },
      annotations: localCapability("fillo_list_responses").annotations,
    },
    async ({
      form,
      range,
      q,
      source,
      respondent,
      where,
      cursor,
      limit,
      includeFields,
      includeMeta,
    }) => {
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/responses`,
          searchParams: gridSearchParams({
            range,
            q,
            source,
            respondent,
            where,
            cursor,
            limit,
            includeFields,
            includeMeta,
          }),
        },
        {
          scope: "responses:read",
          fallback: "Couldn't list responses",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      if (!Array.isArray(res.json?.data)) {
        return fail("Fillo returned an unexpected responses payload. Retry in a moment.");
      }
      const rows = res.json.data as unknown[];
      return ok(
        `${plural(rows.length, "response")} on this page` +
          (res.json.nextCursor ? " (more available — follow nextCursor)." : "."),
        untrusted(res.json),
      );
    },
  );
}
