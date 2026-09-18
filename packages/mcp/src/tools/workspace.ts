import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural } from "../result.js";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, OUTWARD_WRITE, READ_ONLY } from "./annotations.js";
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
 *  workspace's API keys, and the badge a plan controls. Say so once, the same
 *  way, instead of letting a 404 look like a missing entity. */
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
      title: "Rename the workspace",
      description:
        "Change the workspace's display name. Cosmetic: it does not move any data, change any id, " +
        `or affect a live form. Everyone in the workspace sees the new name. Needs ${WORKSPACE}.`,
      inputSchema: { name: z.string().trim().min(1).max(200).describe("New workspace name.") },
      annotations: IDEMPOTENT_WRITE,
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
      title: "Rename a project",
      description:
        "Change a project's display name. Cosmetic — form ids, publishable keys, and hosted URLs " +
        "are untouched. A login token may name any project in the workspace; a project API key can " +
        `only rename its own. Needs ${WORKSPACE}.`,
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe("New project name."),
        project: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Project id, slug, or name (default: the credential's own project)."),
      },
      annotations: IDEMPOTENT_WRITE,
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
      title: "Read the workspace's Fillo badge state",
      description:
        "Report whether Fillo's badge shows on this workspace's forms, the plan, and whether the " +
        `plan allows hiding it. Needs a LOGIN TOKEN — branding has no project-API-key route.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Show or hide the Fillo badge",
      description:
        "Show or hide the Fillo badge on every form this workspace renders. Hiding it requires the " +
        "paid plan; without it the call is refused rather than silently ignored. Visible to every " +
        "respondent, but reversible in one call, so it is a routine change. Needs a LOGIN TOKEN.",
      inputSchema: {
        show: z.boolean().describe("true shows the Fillo badge, false hides it."),
      },
      annotations: IDEMPOTENT_WRITE,
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

// --------------------------------------------------------------- members ---

function registerInviteMember(server: McpServer): void {
  server.registerTool(
    "fillo_invite_member",
    {
      title: "Invite someone to the workspace",
      description:
        "Send a workspace invitation. Fillo emails the address, and accepting gives that person " +
        "access to every form, response, and setting in the workspace at the role you pick. That " +
        "is mail leaving Fillo to a person, and access changing — ASK THE HUMAN FIRST with the " +
        "exact address and role, then pass confirm=true. You can never grant a role above the " +
        `acting person's own. Needs ${MEMBERS}.`,
      inputSchema: {
        email: z.string().trim().min(1).max(254).describe("Who to invite."),
        role: z
          .enum(["member", "admin", "owner"])
          .optional()
          .describe("Role they join with (default member)."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: OUTWARD_WRITE,
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
      title: "List workspace members",
      description:
        "List everyone in the workspace with their role and member id, plus the invitations still " +
        "pending. This is where you get the id for a role change and the EMAIL that " +
        `fillo_remove_member needs as its confirm value. No credentials are returned. Needs ${MEMBERS}.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Change a member's role",
      description:
        "Change what someone may do in this workspace. Owners and admins can manage forms, " +
        "responses, integrations, and credentials; members cannot. This changes who has authority " +
        "over everything in here, so ASK THE HUMAN FIRST and pass confirm=true only once they " +
        "agree. You can never grant a role above the acting person's own. Identify the member by " +
        `id or email from fillo_list_members. Needs ${MEMBERS}.`,
      inputSchema: {
        member: z.string().trim().min(1).describe("Member id or email from fillo_list_members."),
        role: z.enum(["owner", "admin", "member"]).describe("The new role."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: OUTWARD_WRITE,
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
      title: "Remove a workspace member",
      description:
        "Remove someone from the workspace. They immediately lose access to every form, response, " +
        "and setting in it, and getting back in means a fresh invitation. `confirm` must be their " +
        "EMAIL exactly as fillo_list_members shows it — not their member id. Ask the human to " +
        `confirm the email before calling. Needs ${MEMBERS}.`,
      inputSchema: {
        member: z.string().trim().min(1).describe("Member id or email from fillo_list_members."),
        confirm: typedConfirm("member email address"),
      },
      annotations: DESTRUCTIVE,
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
      title: "List connector tokens",
      description:
        "List the CLI/connector tokens this workspace has issued, with when each was created and " +
        "last used. Only metadata — the bearer values are hashed and can never be listed. Use the " +
        `ids here with fillo_revoke_token. Needs ${WORKSPACE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Revoke a connector token",
      description:
        "Kill a CLI/connector token. Whatever is using it stops working immediately and it cannot " +
        "be restored — including, possibly, the credential this MCP server is running on. `confirm` " +
        `must be the token id exactly. Ask the human first. Needs ${WORKSPACE}.`,
      inputSchema: {
        id: z.string().trim().min(1).describe("Token id from fillo_list_tokens."),
        confirm: typedConfirm("token id"),
      },
      annotations: DESTRUCTIVE,
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
      title: "List form sync tokens",
      description:
        "List the `fsync_` tokens that may push code-defined form schemas into this project, with " +
        "when each was created and last used. Metadata only — the token values are hashed. Needs " +
        `${WORKSPACE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Create a form sync token",
      description:
        "Mint an `fsync_` token so a build or CI job can sync code-defined form schemas into this " +
        "project. The token value comes back in THIS RESPONSE ONLY — hand it to the human to put in " +
        "CI secrets or an environment variable, and never commit it. Minting one grants nothing " +
        `else: a sync token can push schemas and nothing more. Needs ${WORKSPACE}.`,
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .optional()
          .describe('What it is for, e.g. "GitHub Actions" (default "Form sync").'),
      },
      annotations: CREATE,
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
      title: "Revoke a form sync token",
      description:
        "Kill an `fsync_` token. Any build or CI job using it stops being able to sync schemas " +
        "immediately, and it cannot be restored — mint a new one and update the secret. `confirm` " +
        `must be the token id exactly. Ask the human first. Needs ${WORKSPACE}.`,
      inputSchema: {
        id: z.string().trim().min(1).describe("Sync token id from fillo_list_sync_tokens."),
        confirm: typedConfirm("sync token id"),
      },
      annotations: DESTRUCTIVE,
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
      title: "List project API keys",
      description:
        "List the `fsk_` project API keys, with their scopes, who created each, and whether it is " +
        "expired or revoked. Key material is hashed and never listed. Needs a LOGIN TOKEN " +
        "(FILLO_TOKEN or `npx @usefillo/cli login`) — a project API key may not enumerate keys, so " +
        "a leaked one cannot map the workspace's credentials.",
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Revoke a project API key",
      description:
        "Kill an `fsk_` project API key. Anything using it — a script, a CI job, another agent — " +
        "stops immediately and it cannot be restored; mint a new key and update the consumer. " +
        "`confirm` must be the key id exactly, from fillo_list_api_keys. Ask the human first. " +
        "Needs a LOGIN TOKEN, so a leaked key can never revoke the workspace's other keys.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Key id from fillo_list_api_keys."),
        confirm: typedConfirm("API key id"),
      },
      annotations: DESTRUCTIVE,
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
      title: "Read the code-sync policy",
      description:
        'Report what may sync code-defined form schemas into this project: "publishable_key" (the ' +
        'browser-safe `pk_` key may sync — convenient in development) or "trusted_only" (an ' +
        "`fsync_` token is required — what a production project should use). Read it before " +
        `changing it. Needs ${WORKSPACE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Set the code-sync policy",
      description:
        'Choose what may sync code-defined form schemas into this project. "publishable_key" lets ' +
        'the browser-safe `pk_` key sync, which is convenient in development; "trusted_only" ' +
        "requires an `fsync_` token, which is what a production project should use. Changing this " +
        "changes who may alter live form schemas, so ASK THE HUMAN FIRST and pass confirm=true only " +
        `once they agree. Needs ${WORKSPACE}.`,
      inputSchema: {
        policy: z
          .enum(["publishable_key", "trusted_only"])
          .describe("publishable_key (permissive) or trusted_only (production)."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: OUTWARD_WRITE,
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
      title: "Read the allowed embed origins",
      description:
        "List the origins allowed to render this project's forms with a publishable key. An empty " +
        "list means any origin. Read this before changing it — replacing the list is how an embed " +
        `silently stops working. Needs ${WORKSPACE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Set the allowed embed origins",
      description:
        "REPLACE the list of origins allowed to render this project's forms with a publishable key. " +
        "The list is not merged: anything you leave out stops being allowed, so a live embed can go " +
        "dark. Read the current list with fillo_get_origins, ASK THE HUMAN FIRST with the " +
        "exact new list, and pass confirm=true only once they agree. An empty array means any " +
        "origin. Entries " +
        `must be bare http(s) origins with no path. Needs ${WORKSPACE}.`,
      inputSchema: {
        origins: z
          .array(z.string().trim().min(1))
          .max(100)
          .describe(
            'The complete new list, e.g. ["https://app.example.com"]. [] means any origin.',
          ),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: OUTWARD_WRITE,
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
      title: "Read identity verification status",
      description:
        "Report whether this project signs respondent identities, and how many forms currently " +
        "require a verified respondent. The signing secret is never returned — it is shown once, " +
        `at mint. Needs ${WORKSPACE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Turn on identity verification",
      description:
        "Turn on signed respondent identities for this project and mint the signing secret. Once " +
        "any form requires verification, your app must sign every respondent with this secret or " +
        "those people cannot submit — so ASK THE HUMAN FIRST and pass confirm=true only once they " +
        "agree. The secret comes back in THIS RESPONSE ONLY; hand it to the human for their secret " +
        "store. Calling it again when verification is already on returns minted:false and NO " +
        `secret — enabling twice can never read an existing secret back. Needs ${WORKSPACE}.`,
      inputSchema: { confirm: OUTWARD_CONFIRM },
      annotations: OUTWARD_WRITE,
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
      title: "Turn off identity verification",
      description:
        "Turn off signed respondent identities and DESTROY the signing secret. Anything still " +
        "signing with it breaks, and turning verification back on mints a different secret you " +
        "would have to redeploy. Refused while any form still requires a verified respondent. " +
        "`confirm` must be the project's slug (from fillo_whoami); the server compares it. " +
        `Ask the human first. Needs ${WORKSPACE}.`,
      inputSchema: { confirm: typedConfirm("project slug") },
      annotations: DESTRUCTIVE,
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
      title: "List connected MCP clients",
      description:
        "List the coding agents and MCP clients that hold a grant on this workspace, with the " +
        "capabilities each was given, its approval policy, when it was last used, and whether it " +
        "has expired. Use it to audit what has access. Key material is never returned. Needs " +
        `${WORKSPACE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
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
      title: "Revoke an MCP client's access",
      description:
        "Cut off a connected MCP client. It loses access immediately and reconnecting means a fresh " +
        "consent screen in a browser. `confirm` must be the grant id exactly — the `id` from " +
        `fillo_list_agents, not the client's label. Ask the human first. Needs ${WORKSPACE}.`,
      inputSchema: {
        id: z.string().trim().min(1).describe("Grant id from fillo_list_agents."),
        confirm: typedConfirm("grant id"),
      },
      annotations: DESTRUCTIVE,
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
