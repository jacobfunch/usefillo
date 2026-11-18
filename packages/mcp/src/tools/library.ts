import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";

// Catalog data stays on the server. These schemas describe only the wire contract.
const searchInput = z
  .object({
    q: z
      .string()
      .max(200)
      .optional()
      .describe("Product situation or measure, e.g. 'onboarding friction' or 'SUS'."),
    category: z
      .enum(["All forms", "Feedback", "Bug reports", "Onboarding", "Research", "AI products"])
      .optional()
      .describe("Optional library category."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(5)
      .describe("Maximum matches per page (1–12, default 5)."),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(0)
      .describe("Continue from nextOffset in a previous search."),
  })
  .strict();

const getInput = z
  .object({
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .describe("Exact form id from fillo_search_library."),
  })
  .strict();

const catalogOutput = z.object({
  version: z.number().int(),
  status: z.string(),
  updated: z.string(),
  instructions: z.string(),
  previewCollectsResponses: z.literal(false),
  publishing: z.string(),
  categories: z.array(z.string()),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  forms: z.array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        useWhen: z.string(),
        avoidWhen: z.string(),
        sources: z.array(
          z.object({ title: z.string(), publisher: z.string(), date: z.string(), url: z.string() }),
        ),
        schema: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  ),
});

async function readCatalog(params: URLSearchParams, limit: number, id?: string) {
  const res = await filloFetch("/library.json", { searchParams: params });
  if (!res.ok) {
    return fail(
      res.status === 404
        ? "Library form not found. Use fillo_search_library to find an exact id."
        : apiErrorMessage(res, "Couldn't read the form library"),
    );
  }
  const parsed = catalogOutput.safeParse(res.json);
  if (
    !parsed.success ||
    parsed.data.forms.length > limit ||
    parsed.data.count !== parsed.data.forms.length ||
    (id !== undefined &&
      (parsed.data.forms.length !== 1 ||
        parsed.data.forms[0]?.id !== id ||
        !parsed.data.forms[0]?.schema))
  ) {
    return fail(
      "The library returned an unexpected catalog response. Retry or read /library.md on your Fillo origin.",
    );
  }
  const data = parsed.data;
  return {
    ...ok(
      id
        ? "Exact library schema and guidance. Complete setup and beforePublish requirements before using the existing publishing flow."
        : `${data.count} of ${data.total} library forms. Fetch an id with fillo_get_library_form before adapting.`,
      data,
    ),
    structuredContent: data,
  };
}

export function registerLibrary(server: McpServer): void {
  server.registerTool(
    "fillo_search_library",
    {
      title: localCapability("fillo_search_library").title,
      description: localCapability("fillo_search_library").description,
      inputSchema: searchInput,
      outputSchema: catalogOutput,
      annotations: localCapability("fillo_search_library").annotations,
    },
    async ({ q, category, limit, offset }) => {
      const params = new URLSearchParams({
        detail: "summary",
        limit: String(limit),
        offset: String(offset),
      });
      if (q !== undefined) params.set("q", q);
      if (category !== undefined) params.set("category", category);
      return readCatalog(params, limit);
    },
  );

  server.registerTool(
    "fillo_get_library_form",
    {
      title: localCapability("fillo_get_library_form").title,
      description: localCapability("fillo_get_library_form").description,
      inputSchema: getInput,
      outputSchema: catalogOutput,
      annotations: localCapability("fillo_get_library_form").annotations,
    },
    async ({ id }) => readCatalog(new URLSearchParams({ id }), 1, id),
  );
}
