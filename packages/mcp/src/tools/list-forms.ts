import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveToken } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { READ_ONLY } from "./annotations.js";

export function registerListForms(server: McpServer): void {
  server.registerTool(
    "fillo_list_forms",
    {
      title: "List the project's forms",
      description:
        "List every form in the selected project with its id, name, status (draft/published), and " +
        "hosted URL. Needs a login token (FILLO_TOKEN or `npx @usefillo/cli login`); a `pk_` " +
        "publishable key is not enough. If no token is set, run `fillo login` first.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const token = resolveToken();
      if (!token) {
        return fail(
          "Listing forms needs a login token. Set FILLO_TOKEN or run `npx @usefillo/cli login`, then retry.",
        );
      }
      const res = await filloFetch("/api/v1/cli/forms", { token });
      if (res.status === 401) {
        return fail(
          "Login token is invalid or expired. Run `npx @usefillo/cli login`, or set a fresh FILLO_TOKEN.",
        );
      }
      if (!res.ok || !Array.isArray(res.json?.forms)) {
        return fail(apiErrorMessage(res, "Couldn't list forms"));
      }
      const forms = res.json.forms as Array<{ name?: string; status?: string }>;
      return ok(
        forms.length
          ? `${forms.length} form${forms.length === 1 ? "" : "s"}: ` +
              forms.map((f) => `${f.name ?? "Untitled"} (${f.status ?? "?"})`).join(", ")
          : "No forms in this project yet.",
        { forms: res.json.forms },
      );
    },
  );
}
