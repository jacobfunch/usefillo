import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiOrigin, readConfig, writeConfig } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { CREATE } from "./annotations.js";

export function registerProvisionWorkspace(server: McpServer): void {
  server.registerTool(
    "fillo_provision_workspace",
    {
      title: "Provision a Fillo workspace",
      description:
        "Create an unclaimed preview Fillo workspace so you can take a form live during " +
        "integration before the developer signs up. No credential needed, but an email is " +
        "REQUIRED — Fillo emails the private claim link to that inbox (it is never returned " +
        "here). Returns a `pk_` publishable key (safe for browser/public env such as " +
        "NEXT_PUBLIC_FILLO_KEY) plus the caps: up to N responses and a hold window. The key " +
        "is saved locally so fillo_push_form and fillo_claim_status can use it. Next: push a " +
        "form with fillo_push_form, then tell the user to open the emailed link and sign in " +
        "to claim the workspace before the hold expires. Rate limited to 5/hour per network " +
        "and 3/hour per email; a repeat email returns a collision error — reuse the emailed link.",
      inputSchema: {
        email: z
          .string()
          .email()
          .describe("Where Fillo emails the private claim link. Ask the developer for theirs."),
        name: z
          .string()
          .optional()
          .describe("The human's display name if known, e.g. from git config user.name"),
      },
      annotations: CREATE,
    },
    async ({ email, name }) => {
      const res = await filloFetch("/api/v1/workspaces/provision", {
        method: "POST",
        body: { email, source: "mcp", ...(name ? { name } : {}) },
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
      const emailedTo: string | undefined =
        typeof res.json.claim?.email === "string" ? res.json.claim.email : email;

      // Persist the publishable key + the caps/claim state the response reported.
      // Those caps are not queryable later with a `pk_` alone, so cache them for
      // fillo_claim_status. The `pk_` is publishable; the claim token is not
      // returned by the API (it is emailed), so nothing secret is stored here
      // beyond the config's existing 0600 discipline.
      const { apiKey: _apiKey, ...current } = readConfig();
      writeConfig({
        ...current,
        activeContext: "provisional",
        pk: key,
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
