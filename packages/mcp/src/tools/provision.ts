import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiOrigin, readConfig, writeConfig } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";

export function registerProvisionWorkspace(server: McpServer): void {
  server.registerTool(
    "fillo_provision_workspace",
    {
      title: localCapability("fillo_provision_workspace").title,
      description: localCapability("fillo_provision_workspace").description,
      inputSchema: {
        email: z
          .string()
          .email()
          .describe("Where Fillo emails the private claim link. Ask the developer for theirs."),
        name: z
          .string()
          .optional()
          .describe("The human's display name if known, e.g. from git config user.name"),
        promptCopyId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Opaque marketing stitch id. Pass the `pc` query from /agents?pc= or the `--pc` value from the documented bootstrap command when present.",
          ),
      },
      annotations: localCapability("fillo_provision_workspace").annotations,
    },
    async ({ email, name, promptCopyId }) => {
      const res = await filloFetch("/api/v1/workspaces/provision", {
        method: "POST",
        body: {
          email,
          source: "mcp",
          ...(name ? { name } : {}),
          ...(promptCopyId ? { promptCopyId } : {}),
        },
      });
      if (!res.ok || typeof res.json?.key !== "string") {
        return fail(apiErrorMessage(res, "Couldn't provision a workspace"));
      }

      const key: string = res.json.key;
      const organizationId: string | undefined =
        typeof res.json.organizationId === "string" ? res.json.organizationId : undefined;
      const responseCap: number | undefined =
        typeof res.json.limits?.responses === "number" ? res.json.limits.responses : undefined;
      const expiresAt: string | undefined =
        typeof res.json.limits?.expiresAt === "string" ? res.json.limits.expiresAt : undefined;
      const emailedTo: string =
        typeof res.json.claim?.email === "string" ? res.json.claim.email : email;

      // Persist the publishable key + the caps/claim state the response reported.
      // Those caps are not queryable later with a `pk_` alone, so cache them for
      // fillo_claim_status. The `pk_` is publishable; the claim token is not
      // returned by the API (it is emailed), so nothing secret is stored here
      // beyond the config's existing 0600 discipline.
      const {
        apiKey: _apiKey,
        apiKeyApi: _apiKeyApi,
        claimUrl: _claimUrl,
        claimToken: _claimToken,
        name: _name,
        preview: _preview,
        ...current
      } = readConfig();
      writeConfig({
        ...current,
        activeContext: "provisional",
        pk: key,
        pkApi: apiOrigin(),
        email: emailedTo,
        ...(name ? { name } : {}),
        preview: {
          workspace:
            typeof res.json.workspaceName === "string"
              ? res.json.workspaceName
              : `${name?.trim().split(/\s+/)[0] || emailedTo.split("@")[0]}'s workspace`,
          ...(responseCap !== undefined && expiresAt
            ? { limits: { responses: responseCap, expiresAt } }
            : {}),
          ...(typeof res.json.canPublishFileFields === "boolean"
            ? { canPublishFileFields: res.json.canPublishFileFields }
            : {}),
        },
        provision: { organizationId, email: emailedTo, responseCap, expiresAt, api: apiOrigin() },
      });

      return ok(
        `Provisioned an unclaimed Fillo workspace. Publishable key returned below — put it in ` +
          `the app's public env (e.g. NEXT_PUBLIC_FILLO_KEY). The claim link was emailed to ` +
          `${emailedTo}. Push a form with fillo_push_form, then have the developer open that ` +
          `email and sign in to claim the workspace` +
          (expiresAt ? ` before ${expiresAt}.` : "."),
        {
          publishableKey: key,
          organizationId,
          responseCap,
          expiresAt,
          claimLinkEmailedTo: emailedTo,
        },
      );
    },
  );
}
