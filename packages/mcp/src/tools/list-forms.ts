import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveToken } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok, plural } from "../result.js";

export function registerListForms(server: McpServer): void {
  server.registerTool(
    "fillo_list_forms",
    {
      title: localCapability("fillo_list_forms").title,
      description: localCapability("fillo_list_forms").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_forms").annotations,
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
          ? `${plural(forms.length, "form")}: ` +
              forms.map((f) => `${f.name ?? "Untitled"} (${f.status ?? "?"})`).join(", ")
          : "No forms in this project yet.",
        { forms: res.json.forms },
      );
    },
  );
}
