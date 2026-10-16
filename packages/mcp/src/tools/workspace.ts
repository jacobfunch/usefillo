import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural } from "../result.js";
import { OUTWARD_CONFIRM, blockOutward, mismatch, typedConfirm } from "./confirm.js";
import { laneCall, laneFetch, laneProblem, noCredential, resolveLane } from "./lane.js";

/**
 * Wave 1d: administering the workspace itself — who is in it, what may sync
 * code-defined forms into it, which origins may embed it, and every credential
 * it has issued.
 *
 * Two rules shape this file. Anything that changes who can act on the workspace
 * is Tier B (a role change, an origin list, a code-sync policy, turning identity
 * verification on). Anything that revokes a credential is Tier C, and its
 * `confirm` is always the same value the route addresses the thing by — an id
 * for a token or a grant, an email for a member — so a mismatch 409 quotes
 * something the human can read back.
 */

const WORKSPACE = "workspace:manage";
const MEMBERS = "members:manage";

/** A few capabilities have no `fsk_` route at all — enumerating or revoking the
 *  workspace's API keys, the badge a plan controls, and the plan itself. Say so
 *  once, the same way, instead of letting a 404 look like a missing entity. */
const LOGIN_ONLY = (what: string) =>
  fail(
    `${what} needs a login token. Run \`npx @usefillo/cli login\` or set FILLO_TOKEN — ` +
      "there is deliberately no project-API-key route for it.",
  );

export function registerWorkspaceAdmin(server: McpServer): void {
  registerRenameWorkspace(server);
  registerRenameProject(server);
  registerGetBranding(server);
  registerSetBranding(server);
  registerGetBilling(server);
  registerListMembers(server);
  registerInviteMember(server);
  registerSetMemberRole(server);
  registerRemoveMember(server);
  registerListTokens(server);
  registerRevokeToken(server);
  registerListSyncTokens(server);
  registerCreateSyncToken(server);
  registerRevokeSyncToken(server);
  registerGetCodeSyncPolicy(server);
  registerSetCodeSyncPolicy(server);
  registerGetAllowedOrigins(server);
  registerSetAllowedOrigins(server);
  registerGetIdentityVerification(server);
  registerEnableIdentityVerification(server);
  registerDisableIdentityVerification(server);
  registerListAgentGrants(server);
  registerRevokeAgentGrant(server);
  registerListApiKeys(server);
  registerRevokeApiKey(server);
}

// ----------------------------------------------------------------- names ---

function registerRenameWorkspace(server: McpServer): void {
  server.registerTool(
    "fillo_rename_workspace",
    {
      title: localCapability("fillo_rename_workspace").title,
      description: localCapability("fillo_rename_workspace").description,
      inputSchema: { name: z.string().trim().min(1).max(200).describe("New workspace name.") },
      annotations: localCapability("fillo_rename_workspace").annotations,
    },
    async ({ name }) => {
      const call = await laneCall(
        { path: "/workspace", method: "PATCH", body: { name } },
        {
          scope: WORKSPACE,
          fallback: "Couldn't rename the workspace",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Workspace renamed to "${res.json?.workspace?.name ?? name}".`, res.json);
    },
  );
}

function registerRenameProject(server: McpServer): void {
  server.registerTool(
    "fillo_rename_project",
    {
      title: localCapability("fillo_rename_project").title,
      description: localCapability("fillo_rename_project").description,
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe("New project name."),
        project: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Project id, slug, or name (default: the credential's own project)."),
      },
      annotations: localCapability("fillo_rename_project").annotations,
    },
    async ({ name, project }) => {
      const call = await laneCall(
        {
          path: "/project",
          method: "PATCH",
          body: { name, ...(project ? { project } : {}) },
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't rename the project",
          missing: "No project in this workspace matches that value.",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Project renamed to "${res.json?.project?.name ?? name}".`, res.json);
    },
  );
}

// -------------------------------------------------------------- branding ---

function registerGetBranding(server: McpServer): void {
  server.registerTool(
    "fillo_get_branding",
    {
      title: localCapability("fillo_get_branding").title,
      description: localCapability("fillo_get_branding").description,
      inputSchema: {},
      annotations: localCapability("fillo_get_branding").annotations,
    },
    async () => {
      const lane = resolveLane();
      if (!lane) return noCredential("(login token only)");
      if (lane.kind !== "cli") return LOGIN_ONLY("Reading the badge state");

      const res = await laneFetch(lane, { path: "/workspace/branding" });
      const problem = laneProblem(lane, res, {
        scope: "(login token only)",
        fallback: "Couldn't read the branding state",
      });
      if (problem) return problem;

      return ok(
        res.json?.showBranding
          ? `The Fillo badge shows on this workspace's forms (plan: ${res.json?.plan ?? "unknown"}).`
          : "The Fillo badge is hidden on this workspace's forms.",
        res.json,
      );
    },
  );
}

function registerSetBranding(server: McpServer): void {
  server.registerTool(
    "fillo_set_branding",
    {
      title: localCapability("fillo_set_branding").title,
      description: localCapability("fillo_set_branding").description,
      inputSchema: {
        show: z.boolean().describe("true shows the Fillo badge, false hides it."),
      },
      annotations: localCapability("fillo_set_branding").annotations,
    },
    async ({ show }) => {
      const lane = resolveLane();
      if (!lane) return noCredential("(login token only)");
      if (lane.kind !== "cli") return LOGIN_ONLY("Changing the badge");

      const res = await laneFetch(lane, {
        path: "/workspace/branding",
        method: "PATCH",
        body: { show },
      });
      const problem = laneProblem(lane, res, {
        scope: "(login token only)",
        fallback: "Couldn't change the branding",
      });
      if (problem) return problem;

      return ok(
        res.json?.showBranding
          ? "The Fillo badge now shows on this workspace's forms."
          : "The Fillo badge is now hidden on this workspace's forms.",
        res.json,
      );
    },
  );
}

// --------------------------------------------------------------- billing ---

/** "26 September 2027" — billing dates read in UTC, like usage periods. */
const LONG_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const COUNT = new Intl.NumberFormat("en-US");

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : LONG_DATE.format(date);
}

/**
 * One line a model can read back to a human. The route's JSON rides beside it.
 * `plan: "trial"` and `trialEndsAt` only come from servers before 2026-09-27,
 * when a no-card trial still existed; a running one is read back plainly.
 */
function billingSummary(json: Record<string, unknown> | undefined): string {
  const tier = typeof json?.tier === "string" ? `Everything ${json.tier}` : "Everything";
  const plan =
    json?.plan === "free"
      ? "Free"
      : json?.plan === "trial"
        ? `${tier} trial`
        : json?.plan === "complimentary"
          ? `${tier}, complimentary`
          : json?.plan === "subscribed"
            ? `${tier}, billed ${json.interval === "year" ? "yearly" : "monthly"}`
            : "Plan unknown";
  const parts = [plan];
  const usage = json?.usage as { responses?: unknown } | undefined;
  if (typeof usage?.responses === "number" && typeof json?.allowance === "number") {
    parts.push(
      `${COUNT.format(usage.responses)} of ${COUNT.format(json.allowance)} responses this month`,
    );
  }
  const periodEnd = isoDate(json?.currentPeriodEnd);
  const trialEnd = isoDate(json?.trialEndsAt);
  if (json?.plan === "subscribed" && json.status === "past_due") {
    parts.push("the last payment failed; Stripe is retrying");
  } else if (json?.plan === "subscribed" && periodEnd) {
    parts.push(json.cancelAtPeriodEnd ? `cancels ${periodEnd}` : `renews ${periodEnd}`);
  } else if (json?.plan === "trial" && trialEnd) {
    parts.push(`trial ends ${trialEnd}`);
  }
  const manageUrl =
    typeof json?.manageUrl === "string" && /^https?:\/\//u.test(json.manageUrl)
      ? `: ${json.manageUrl}`
      : "";
  return (
    `${parts.join(" · ")}. Plan changes are made by an owner or admin in ` +
    `Settings → Billing & plan${manageUrl}`
  );
}

function registerGetBilling(server: McpServer): void {
  server.registerTool(
    "fillo_get_billing",
    {
      title: localCapability("fillo_get_billing").title,
      description: localCapability("fillo_get_billing").description,
      inputSchema: {},
      annotations: localCapability("fillo_get_billing").annotations,
    },
    async () => {
      const lane = resolveLane();
      if (!lane) return noCredential("(login token only)");
      if (lane.kind !== "cli") return LOGIN_ONLY("Reading the plan and usage");

      const res = await laneFetch(lane, { path: "/workspace/billing" });
      const problem = laneProblem(lane, res, {
        scope: "(login token only)",
        fallback: "Couldn't read the plan and usage",
        missing:
          "This Fillo server doesn't report billing yet. Open Settings → Billing & plan to see the plan and usage.",
      });
      if (problem) return problem;

      return ok(billingSummary(res.json), res.json);
    },
  );
}

// --------------------------------------------------------------- members ---

function registerInviteMember(server: McpServer): void {
  server.registerTool(
    "fillo_invite_member",
    {
      title: localCapability("fillo_invite_member").title,
      description: localCapability("fillo_invite_member").description,
      inputSchema: {
        email: z.string().trim().min(1).max(254).describe("Who to invite."),
        role: z
          .enum(["member", "admin", "owner"])
          .optional()
          .describe("Role they join with (default member)."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: localCapability("fillo_invite_member").annotations,
    },
    async ({ email, role, confirm }) => {
      const blocked = blockOutward(
        confirm,
        `Emailing ${email} an invitation to join this workspace as ${role ?? "member"}`,
      );
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: "/members/invites",
          method: "POST",
          body: { email, ...(role ? { role } : {}) },
        },
        {
          scope: MEMBERS,
          fallback: "Couldn't send that invitation",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const invitation = res.json?.invitation;
      return ok(
        `Invited ${invitation?.email ?? email} as ${invitation?.role ?? role ?? "member"}. ` +
          "They have an email with the join link.",
        res.json,
      );
    },
  );
}

function registerListMembers(server: McpServer): void {
  server.registerTool(
    "fillo_list_members",
    {
      title: localCapability("fillo_list_members").title,
      description: localCapability("fillo_list_members").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_members").annotations,
    },
    async () => {
      const call = await laneCall(
        { path: "/members" },
        {
          scope: MEMBERS,
          fallback: "Couldn't list the members",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const members = Array.isArray(res.json?.members) ? (res.json.members as unknown[]) : [];
      const invites = Array.isArray(res.json?.invitations)
        ? (res.json.invitations as unknown[])
        : [];
      return ok(
        plural(members.length, "member") +
          (invites.length ? `, ${plural(invites.length, "invitation")} pending.` : "."),
        res.json,
      );
    },
  );
}

function registerSetMemberRole(server: McpServer): void {
  server.registerTool(
    "fillo_change_member_role",
    {
      title: localCapability("fillo_change_member_role").title,
      description: localCapability("fillo_change_member_role").description,
      inputSchema: {
        member: z.string().trim().min(1).describe("Member id or email from fillo_list_members."),
        role: z.enum(["owner", "admin", "member"]).describe("The new role."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: localCapability("fillo_change_member_role").annotations,
    },
    async ({ member, role, confirm }) => {
      const blocked = blockOutward(confirm, `Making ${member} a workspace ${role}`);
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: `/members/${encodeURIComponent(member)}`,
          method: "PATCH",
          body: { role },
        },
        {
          scope: MEMBERS,
          fallback: "Couldn't change that member's role",
          missing: `No member "${member}" in this workspace. List them with fillo_list_members.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `${res.json?.email ?? member} is now a workspace ${res.json?.role ?? role}.`,
        res.json,
      );
    },
  );
}

function registerRemoveMember(server: McpServer): void {
  server.registerTool(
    "fillo_remove_member",
    {
      title: localCapability("fillo_remove_member").title,
      description: localCapability("fillo_remove_member").description,
      inputSchema: {
        member: z.string().trim().min(1).describe("Member id or email from fillo_list_members."),
        confirm: typedConfirm("member email address"),
      },
      annotations: localCapability("fillo_remove_member").annotations,
    },
    async ({ member, confirm }) => {
      const call = await laneCall(
        {
          path: `/members/${encodeURIComponent(member)}`,
          method: "DELETE",
          body: { confirm },
        },
        {
          scope: MEMBERS,
          fallback: "Couldn't remove that member",
          missing: `No member "${member}" in this workspace.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Removed ${res.json?.email ?? member} from the workspace.`, res.json);
    },
  );
}

// ----------------------------------------------------------- credentials ---

function registerListTokens(server: McpServer): void {
  server.registerTool(
    "fillo_list_tokens",
    {
      title: localCapability("fillo_list_tokens").title,
      description: localCapability("fillo_list_tokens").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_tokens").annotations,
    },
    async () => {
      const call = await laneCall(
        { path: "/tokens" },
        {
          scope: WORKSPACE,
          fallback: "Couldn't list the tokens",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.tokens) ? (res.json.tokens as unknown[]) : [];
      return ok(`${plural(rows.length, "connector token")}.`, res.json);
    },
  );
}

function registerRevokeToken(server: McpServer): void {
  server.registerTool(
    "fillo_revoke_token",
    {
      title: localCapability("fillo_revoke_token").title,
      description: localCapability("fillo_revoke_token").description,
      inputSchema: {
        id: z.string().trim().min(1).describe("Token id from fillo_list_tokens."),
        confirm: typedConfirm("token id"),
      },
      annotations: localCapability("fillo_revoke_token").annotations,
    },
    async ({ id, confirm }) => {
      const call = await laneCall(
        {
          path: `/tokens/${encodeURIComponent(id)}`,
          method: "DELETE",
          body: { confirm },
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't revoke that token",
          missing: `No token "${id}" in this workspace.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `Revoked token "${id}".` +
          (res.json?.self
            ? " That was this session's own credential — you will need to log in again."
            : ""),
        res.json,
      );
    },
  );
}

function registerListSyncTokens(server: McpServer): void {
  server.registerTool(
    "fillo_list_sync_tokens",
    {
      title: localCapability("fillo_list_sync_tokens").title,
      description: localCapability("fillo_list_sync_tokens").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_sync_tokens").annotations,
    },
    async () => {
      const call = await laneCall(
        { path: "/sync-tokens" },
        {
          scope: WORKSPACE,
          fallback: "Couldn't list the sync tokens",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.tokens) ? (res.json.tokens as unknown[]) : [];
      return ok(`${plural(rows.length, "form sync token")}.`, res.json);
    },
  );
}

function registerCreateSyncToken(server: McpServer): void {
  server.registerTool(
    "fillo_create_sync_token",
    {
      title: localCapability("fillo_create_sync_token").title,
      description: localCapability("fillo_create_sync_token").description,
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .optional()
          .describe('What it is for, e.g. "GitHub Actions" (default "Form sync").'),
      },
      annotations: localCapability("fillo_create_sync_token").annotations,
    },
    async ({ name }) => {
      const call = await laneCall(
        {
          path: "/sync-tokens",
          method: "POST",
          body: name ? { name } : {},
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't create that form sync token",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `Minted the form sync token "${res.json?.name ?? name ?? "Form sync"}". Its value is in this ` +
          "result and Fillo will never show it again — give it to the human to store as a secret " +
          "now, and do not write it into source control.",
        res.json,
      );
    },
  );
}

function registerRevokeSyncToken(server: McpServer): void {
  server.registerTool(
    "fillo_revoke_sync_token",
    {
      title: localCapability("fillo_revoke_sync_token").title,
      description: localCapability("fillo_revoke_sync_token").description,
      inputSchema: {
        id: z.string().trim().min(1).describe("Sync token id from fillo_list_sync_tokens."),
        confirm: typedConfirm("sync token id"),
      },
      annotations: localCapability("fillo_revoke_sync_token").annotations,
    },
    async ({ id, confirm }) => {
      const call = await laneCall(
        {
          path: `/sync-tokens/${encodeURIComponent(id)}`,
          method: "DELETE",
          body: { confirm },
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't revoke that sync token",
          missing: `No form sync token "${id}" in this project.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Revoked form sync token "${id}".`, res.json);
    },
  );
}

function registerListApiKeys(server: McpServer): void {
  server.registerTool(
    "fillo_list_api_keys",
    {
      title: localCapability("fillo_list_api_keys").title,
      description: localCapability("fillo_list_api_keys").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_api_keys").annotations,
    },
    async () => {
      const lane = resolveLane();
      if (!lane) return noCredential("(login token only)");
      if (lane.kind !== "cli") {
        return fail(
          "Listing API keys needs a login token. Run `npx @usefillo/cli login` or set FILLO_TOKEN — " +
            "a project API key deliberately cannot enumerate the workspace's other keys.",
        );
      }

      const res = await laneFetch(lane, { path: "/keys" });
      const problem = laneProblem(lane, res, {
        scope: "(login token only)",
        fallback: "Couldn't list the API keys",
      });
      if (problem) return problem;

      const rows = Array.isArray(res.json?.keys) ? (res.json.keys as unknown[]) : [];
      return ok(`${plural(rows.length, "project API key")}.`, res.json);
    },
  );
}

function registerRevokeApiKey(server: McpServer): void {
  server.registerTool(
    "fillo_revoke_api_key",
    {
      title: localCapability("fillo_revoke_api_key").title,
      description: localCapability("fillo_revoke_api_key").description,
      inputSchema: {
        id: z.string().trim().min(1).describe("Key id from fillo_list_api_keys."),
        confirm: typedConfirm("API key id"),
      },
      annotations: localCapability("fillo_revoke_api_key").annotations,
    },
    async ({ id, confirm }) => {
      const wrong = mismatch(confirm, id, "API key id");
      if (wrong) return wrong;

      const lane = resolveLane();
      if (!lane) return noCredential("(login token only)");
      if (lane.kind !== "cli") return LOGIN_ONLY("Revoking an API key");

      // The route has no body `confirm` of its own — a login token is the whole
      // gate there — so the typed match above is what keeps this Tier C.
      const res = await laneFetch(lane, {
        path: `/keys/${encodeURIComponent(id)}`,
        method: "DELETE",
      });
      const problem = laneProblem(lane, res, {
        scope: "(login token only)",
        fallback: "Couldn't revoke that API key",
        missing: `No API key "${id}" in this project. List them with fillo_list_api_keys.`,
      });
      if (problem) return problem;

      return ok(
        res.json?.alreadyRevoked
          ? `API key "${id}" was already revoked.`
          : `Revoked API key "${id}".`,
        res.json,
      );
    },
  );
}

// --------------------------------------------------- developer settings ---

function registerGetCodeSyncPolicy(server: McpServer): void {
  server.registerTool(
    "fillo_get_code_sync_policy",
    {
      title: localCapability("fillo_get_code_sync_policy").title,
      description: localCapability("fillo_get_code_sync_policy").description,
      inputSchema: {},
      annotations: localCapability("fillo_get_code_sync_policy").annotations,
    },
    async () => {
      const call = await laneCall(
        { path: "/project/code-sync" },
        {
          scope: WORKSPACE,
          fallback: "Couldn't read the code-sync policy",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Code-sync policy is ${res.json?.policy ?? "unknown"}.`, res.json);
    },
  );
}

function registerSetCodeSyncPolicy(server: McpServer): void {
  server.registerTool(
    "fillo_set_code_sync_policy",
    {
      title: localCapability("fillo_set_code_sync_policy").title,
      description: localCapability("fillo_set_code_sync_policy").description,
      inputSchema: {
        policy: z
          .enum(["publishable_key", "trusted_only"])
          .describe("publishable_key (permissive) or trusted_only (production)."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: localCapability("fillo_set_code_sync_policy").annotations,
    },
    async ({ policy, confirm }) => {
      const blocked = blockOutward(confirm, `Setting this project's code-sync policy to ${policy}`);
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: "/project/code-sync",
          method: "PATCH",
          body: { policy },
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't change the code-sync policy",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Code-sync policy is now ${res.json?.policy ?? policy}.`, res.json);
    },
  );
}

function registerGetAllowedOrigins(server: McpServer): void {
  server.registerTool(
    "fillo_get_origins",
    {
      title: localCapability("fillo_get_origins").title,
      description: localCapability("fillo_get_origins").description,
      inputSchema: {},
      annotations: localCapability("fillo_get_origins").annotations,
    },
    async () => {
      const call = await laneCall(
        { path: "/project/origins" },
        {
          scope: WORKSPACE,
          fallback: "Couldn't read the allowed origins",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const origins = Array.isArray(res.json?.origins) ? (res.json.origins as string[]) : [];
      return ok(
        origins.length
          ? `Allowed origins: ${origins.join(", ")}.`
          : "Any origin may embed (no list set).",
        res.json,
      );
    },
  );
}

function registerSetAllowedOrigins(server: McpServer): void {
  server.registerTool(
    "fillo_set_origins",
    {
      title: localCapability("fillo_set_origins").title,
      description: localCapability("fillo_set_origins").description,
      inputSchema: {
        origins: z
          .array(z.string().trim().min(1))
          .max(100)
          .describe(
            'The complete new list, e.g. ["https://app.example.com"]. [] means any origin.',
          ),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: localCapability("fillo_set_origins").annotations,
    },
    async ({ origins, confirm }) => {
      const blocked = blockOutward(
        confirm,
        origins.length
          ? `Allowing only ${origins.join(", ")} to embed this project's forms`
          : "Allowing ANY origin to embed this project's forms",
      );
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: "/project/origins",
          method: "PUT",
          body: { origins },
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't set the allowed origins",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const saved = Array.isArray(res.json?.origins) ? (res.json.origins as string[]) : origins;
      return ok(
        saved.length
          ? `Only these origins may embed now: ${saved.join(", ")}.`
          : "Any origin may embed now.",
        res.json,
      );
    },
  );
}

// --------------------------------------------- identity verification ---

function registerGetIdentityVerification(server: McpServer): void {
  server.registerTool(
    "fillo_identity_status",
    {
      title: localCapability("fillo_identity_status").title,
      description: localCapability("fillo_identity_status").description,
      inputSchema: {},
      annotations: localCapability("fillo_identity_status").annotations,
    },
    async () => {
      const call = await laneCall(
        { path: "/project/identity" },
        {
          scope: WORKSPACE,
          fallback: "Couldn't read identity verification",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        res.json?.enabled
          ? `Identity verification is on; ${res.json?.protectedFormCount ?? 0} form(s) require a verified respondent.`
          : "Identity verification is off.",
        res.json,
      );
    },
  );
}

function registerEnableIdentityVerification(server: McpServer): void {
  server.registerTool(
    "fillo_enable_identity",
    {
      title: localCapability("fillo_enable_identity").title,
      description: localCapability("fillo_enable_identity").description,
      inputSchema: { confirm: OUTWARD_CONFIRM },
      annotations: localCapability("fillo_enable_identity").annotations,
    },
    async ({ confirm }) => {
      const blocked = blockOutward(
        confirm,
        "Turning on identity verification (unsigned respondents will be refused by forms that require it)",
      );
      if (blocked) return blocked;

      const call = await laneCall(
        { path: "/project/identity", method: "POST", body: {} },
        {
          scope: WORKSPACE,
          fallback: "Couldn't turn on identity verification",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        res.json?.minted
          ? "Identity verification is on and the signing secret is in this result. Fillo will never " +
              "show it again — give it to the human to store as a secret now, and do not write it " +
              "into source control."
          : "Identity verification was already on, so no new secret was minted. If the old secret is " +
              "lost, a workspace manager has to rotate it in Settings.",
        res.json,
      );
    },
  );
}

function registerDisableIdentityVerification(server: McpServer): void {
  server.registerTool(
    "fillo_disable_identity",
    {
      title: localCapability("fillo_disable_identity").title,
      description: localCapability("fillo_disable_identity").description,
      inputSchema: { confirm: typedConfirm("project slug") },
      annotations: localCapability("fillo_disable_identity").annotations,
    },
    async ({ confirm }) => {
      const call = await laneCall(
        {
          path: "/project/identity",
          method: "DELETE",
          body: { confirm },
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't turn off identity verification",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok("Identity verification is off and the signing secret is gone.", res.json);
    },
  );
}

// ------------------------------------------------------------ MCP grants ---

function registerListAgentGrants(server: McpServer): void {
  server.registerTool(
    "fillo_list_agents",
    {
      title: localCapability("fillo_list_agents").title,
      description: localCapability("fillo_list_agents").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_agents").annotations,
    },
    async () => {
      const call = await laneCall(
        { path: "/agents" },
        {
          scope: WORKSPACE,
          fallback: "Couldn't list the MCP clients",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.grants) ? (res.json.grants as unknown[]) : [];
      return ok(`${plural(rows.length, "connected MCP client")}.`, res.json);
    },
  );
}

function registerRevokeAgentGrant(server: McpServer): void {
  server.registerTool(
    "fillo_revoke_agent",
    {
      title: localCapability("fillo_revoke_agent").title,
      description: localCapability("fillo_revoke_agent").description,
      inputSchema: {
        id: z.string().trim().min(1).describe("Grant id from fillo_list_agents."),
        confirm: typedConfirm("grant id"),
      },
      annotations: localCapability("fillo_revoke_agent").annotations,
    },
    async ({ id, confirm }) => {
      const call = await laneCall(
        {
          path: `/agents/${encodeURIComponent(id)}`,
          method: "DELETE",
          body: { confirm },
        },
        {
          scope: WORKSPACE,
          fallback: "Couldn't revoke that MCP client",
          missing: `No MCP client "${id}" in this project.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        res.json?.alreadyRevoked
          ? `MCP client "${id}" was already revoked.`
          : `Revoked MCP client "${id}".`,
        res.json,
      );
    },
  );
}
