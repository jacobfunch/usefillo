import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiOrigin, resolveProvision, resolvePk, resolveToken } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { READ_ONLY } from "./annotations.js";

export function registerWhoami(server: McpServer): void {
  server.registerTool(
    "fillo_whoami",
    {
      title: "Show the active Fillo credential",
      description:
        "Report which Fillo credential is active and what it can reach. With a login token " +
        "(FILLO_TOKEN or `fillo login`) it confirms the signed-in workspace and selected project. With only a `pk_` " +
        "publishable key (from fillo_provision_workspace) it reports the unclaimed preview " +
        "workspace's caps and claim state. If nothing is set up, it says exactly what to do: " +
        "run fillo_provision_workspace, or set FILLO_TOKEN / run `fillo login`. Never prints " +
        "token material. For just the claim deadline and days left on a preview workspace, use " +
        "fillo_claim_status.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const token = resolveToken();
      if (token) {
        const res = await filloFetch("/api/v1/cli/whoami", { token });
        if (res.status === 401) {
          return fail(
            "Login token is invalid or expired. Run `npx @usefillo/cli login`, or set a fresh FILLO_TOKEN.",
          );
        }
        if (!res.ok) return fail(apiErrorMessage(res, "whoami failed"));
        const workspace = typeof res.json?.workspace === "string" ? res.json.workspace : undefined;
        const workspaceId =
          typeof res.json?.workspaceId === "string" ? res.json.workspaceId : undefined;
        const workspaceSlug =
          typeof res.json?.workspaceSlug === "string" ? res.json.workspaceSlug : undefined;
        const project = typeof res.json?.project === "string" ? res.json.project : undefined;
        const projectId = typeof res.json?.projectId === "string" ? res.json.projectId : undefined;
        const projectSlug =
          typeof res.json?.projectSlug === "string" ? res.json.projectSlug : undefined;
        return ok(
          workspace
            ? `Signed in with a login token. Workspace: ${workspace}${project ? `; project: ${project}` : ""}.`
            : "Signed in with a login token.",
          {
            mode: "token",
            workspace,
            workspaceId,
            workspaceSlug,
            project,
            projectId,
            projectSlug,
            api: apiOrigin(),
          },
        );
      }

      const pk = resolvePk();
      if (pk) {
        // The provisional-status route is scoped to the browser cookie that
        // provisioned the workspace, so a headless `pk_` cannot re-query it.
        // Report the caps/claim state cached from provisioning instead.
        const provision = resolveProvision();
        if (provision) {
          return ok(
            `A publishable key for an unclaimed preview workspace is configured. The claim link ` +
              `was emailed to ${provision.email ?? "the provisioning address"}` +
              (provision.expiresAt ? `; claim it before ${provision.expiresAt}.` : "."),
            {
              mode: "provisional",
              api: apiOrigin(),
              organizationId: provision.organizationId,
              claimLinkEmailedTo: provision.email,
              responseCap: provision.responseCap,
              expiresAt: provision.expiresAt,
            },
          );
        }
        return ok(
          "A publishable key is configured, but no provisioning record was found on this machine. " +
            "A `pk_` key resolves and syncs forms; claim state is only visible from the browser that " +
            "provisioned it, or with a login token after claiming. Sign in and set FILLO_TOKEN to see " +
            "the live workspace.",
          { mode: "publishable-key", api: apiOrigin() },
        );
      }

      return fail(
        "No Fillo credential is set up. Run fillo_provision_workspace to start a preview workspace, " +
          "or set FILLO_TOKEN (or run `npx @usefillo/cli login`) to use an existing account.",
      );
    },
  );
}
