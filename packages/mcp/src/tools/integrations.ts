import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural } from "../result.js";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, OUTWARD_WRITE, READ_ONLY } from "./annotations.js";
import { OUTWARD_CONFIRM, blockOutward, mismatch, typedConfirm } from "./confirm.js";
import {
  FORM_ARG,
  laneCall,
  laneFetch,
  laneProblem,
  noCredential,
  noForm,
  resolveLane,
} from "./lane.js";

/**
 * Wave 1b: where a form's answers go after Fillo accepts them, and which
 * connected account each project sends through.
 *
 * Turning a destination ON is Tier B on purpose — from that moment every answer
 * leaves Fillo for somebody else's system, which is not something an agent gets
 * to decide. Turning one off is Tier A: it only stops the flow.
 */

const PROVIDERS = ["google_sheets", "notion", "slack", "hubspot", "discord"] as const;
const ACCOUNT_PROVIDERS = ["notion", "slack", "hubspot", "discord"] as const;

const PROVIDER_ARG = z
  .enum(PROVIDERS)
  .describe("Which destination: google_sheets, notion, slack, hubspot, or discord.");

const SCOPE = "integrations:manage";

/** Discord's per-form destination is richer than the shared provider shape
 *  (channel pinning, early-signal windows, role grants), so it has its own
 *  route — at the same path on both mounts, like every other provider. */
function integrationPath(form: string, provider: string): { path: string } {
  return { path: `/forms/${encodeURIComponent(form)}/integrations/${provider}` };
}

/** The config keys each provider's PUT accepts, quoted in the tool description
 *  so a model does not have to guess and eat a 400. */
const CONFIG_KEYS = [
  "google_sheets: spreadsheetId, sheetTabId (omit both to create a new spreadsheet)",
  "notion: titleFieldId (omit to create a new database)",
  "slack: slackChannelId (required to start), slackIncludeFieldIds (max 3)",
  "hubspot: hubspotEmailFieldId (required), hubspotMappings, hubspotCreateMarketableContact, hubspotCompany, hubspotDeal",
  "discord: enabled, channelId or webhookId, includeFieldIds (max 3), earlySignalLimit (5|10|25|null), roleGrant",
].join("; ");

export function registerIntegrations(server: McpServer): void {
  registerGetFormIntegration(server);
  registerSetFormIntegration(server);
  registerDisableFormIntegration(server);
  registerListConnections(server);
  registerSelectConnection(server);
  registerDisconnectIntegration(server);
  registerRemoveIntegrationAccount(server);
  registerRenameDiscordAccount(server);
  registerHubSpotProperties(server);
  registerHubSpotPipelines(server);
}

// ------------------------------------------------------- per-form destinations ---

function registerGetFormIntegration(server: McpServer): void {
  server.registerTool(
    "fillo_get_integration",
    {
      title: "Read a form's destination for one provider",
      description:
        "Report whether one form sends its answers to a provider, and the stored configuration if " +
        "it does. Credentials are never returned. Call this before changing anything so you know " +
        `what is already wired up. Needs ${SCOPE}.`,
      inputSchema: { form: FORM_ARG, provider: PROVIDER_ARG },
      annotations: READ_ONLY,
    },
    async ({ form, provider }) => {
      const call = await laneCall(integrationPath(form, provider), {
        scope: SCOPE,
        fallback: `Couldn't read the ${provider} destination`,
        missing: noForm(form),
      });
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        res.json?.enabled
          ? `"${form}" sends answers to ${provider}.`
          : `"${form}" does not send answers to ${provider}.`,
        res.json,
      );
    },
  );
}

function registerSetFormIntegration(server: McpServer): void {
  server.registerTool(
    "fillo_enable_integration",
    {
      title: "Start or reconfigure a form's destination",
      description:
        "Turn on — or reconfigure — where one form's answers go. From the moment this succeeds, " +
        "every response leaves Fillo for a third-party system the workspace connected, so ASK THE " +
        "HUMAN FIRST and pass confirm=true only once they have agreed. The provider account must " +
        `already be connected (see fillo_list_connections). Config keys by provider — ${CONFIG_KEYS}. ` +
        "Unknown keys are rejected rather than ignored. This tool only turns a destination ON — to " +
        `stop one, use fillo_disable_integration. Needs ${SCOPE}.`,
      inputSchema: {
        form: FORM_ARG,
        provider: PROVIDER_ARG,
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Provider config keys. Omit for providers that can create a destination."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: OUTWARD_WRITE,
    },
    async ({ form, provider, config, confirm }) => {
      const blocked = blockOutward(confirm, `Sending "${form}" answers to ${provider}`);
      if (blocked) return blocked;

      // Discord's mount takes the patch flat and needs an explicit `enabled`;
      // the shared providers take their config flat too, and enabling is implied.
      // `enabled: true` goes LAST: this tool turns a destination on, and a
      // config that said otherwise would have it report the opposite of what
      // happened. Turning one off is fillo_disable_integration.
      const body = provider === "discord" ? { ...(config ?? {}), enabled: true } : (config ?? {});
      const call = await laneCall(
        {
          ...integrationPath(form, provider),
          method: "PUT",
          body,
        },
        {
          scope: SCOPE,
          fallback: `Couldn't start the ${provider} destination`,
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`"${form}" now sends its answers to ${provider}.`, res.json);
    },
  );
}

function registerDisableFormIntegration(server: McpServer): void {
  server.registerTool(
    "fillo_disable_integration",
    {
      title: "Stop a form's destination",
      description:
        "Stop sending one form's answers to a provider. Reversible — the configuration is dropped " +
        "but the connected account stays, and fillo_enable_integration can start it again. " +
        "Already-delivered rows are not recalled. Responses Fillo holds keep accumulating in the " +
        `responses grid. Needs ${SCOPE}.`,
      inputSchema: { form: FORM_ARG, provider: PROVIDER_ARG },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form, provider }) => {
      const lane = resolveLane();
      if (!lane) return noCredential(SCOPE);

      const res = await laneFetch(lane, {
        ...integrationPath(form, provider),
        method: "DELETE",
      });
      const problem = laneProblem(lane, res, {
        scope: SCOPE,
        fallback: `Couldn't stop the ${provider} destination`,
        missing: noForm(form),
      });
      if (problem) return problem;

      return ok(`"${form}" no longer sends its answers to ${provider}.`, res.json);
    },
  );
}

// --------------------------------------------------- workspace-level accounts ---

function registerListConnections(server: McpServer): void {
  server.registerTool(
    "fillo_list_connections",
    {
      title: "List connected integration accounts",
      description:
        "List the Notion, Slack, HubSpot, and Discord accounts this workspace has connected, which " +
        "one each project currently sends through, and how many forms depend on each. Each " +
        "account's `label` is the exact string fillo_remove_integration_account needs as its " +
        `confirm value. Tokens are never returned. Needs ${SCOPE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const call = await laneCall(
        { path: "/integrations/connections" },
        {
          scope: SCOPE,
          fallback: "Couldn't list connected accounts",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const accounts = Array.isArray(res.json?.accounts) ? (res.json.accounts as unknown[]) : [];
      return ok(`${plural(accounts.length, "connected account")}.`, res.json);
    },
  );
}

function registerSelectConnection(server: McpServer): void {
  server.registerTool(
    "fillo_select_connection",
    {
      title: "Choose which account a project sends through",
      description:
        "Point this project at one of the workspace's connected accounts for a provider. It changes " +
        "which workspace/team/portal new destinations are created in; forms already wired to a " +
        "different account keep sending where they were sending. Get ids from " +
        `fillo_list_connections. Needs ${SCOPE}.`,
      inputSchema: {
        provider: z.enum(ACCOUNT_PROVIDERS).describe("notion, slack, hubspot, or discord."),
        connectionId: z.string().trim().min(1).describe("Account id from fillo_list_connections."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ provider, connectionId }) => {
      const call = await laneCall(
        {
          path: `/integrations/connections/${provider}`,
          method: "PUT",
          body: { connectionId },
        },
        {
          scope: SCOPE,
          fallback: "Couldn't select that account",
          missing: `No integration account "${connectionId}" in this workspace. List them with fillo_list_connections.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`This project now uses that ${provider} account for new destinations.`, res.json);
    },
  );
}

function registerDisconnectIntegration(server: McpServer): void {
  server.registerTool(
    "fillo_disconnect_integration",
    {
      title: "Disconnect a provider from this project",
      description:
        "Detach THIS PROJECT's Notion, Slack, HubSpot, or Discord account: every form in the " +
        "project that sends to it stops. The workspace account itself stays, and other projects " +
        "keep using it — to remove the account everywhere, use fillo_remove_connection_account. " +
        "Irreversible for this project (the per-form destinations are gone, not paused), so " +
        "`confirm` must be the provider name typed exactly. Ask the human first. " +
        `Needs ${SCOPE}.`,
      inputSchema: {
        provider: z.enum(ACCOUNT_PROVIDERS).describe("notion, slack, hubspot, or discord."),
        confirm: typedConfirm("provider name"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ provider, confirm }) => {
      const wrong = mismatch(confirm, provider, "provider name");
      if (wrong) return wrong;

      const call = await laneCall(
        {
          path: `/integrations/connections/${provider}`,
          method: "DELETE",
        },
        {
          scope: SCOPE,
          fallback: `Couldn't disconnect ${provider} from this project`,
          missing: `This project has no ${provider} account selected.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const removed = Number(res.json?.removedDestinations ?? 0);
      return ok(
        `Disconnected ${provider} from this project` +
          (removed
            ? `; ${plural(removed, "form destination")} stopped.`
            : "; no form was sending to it."),
        res.json,
      );
    },
  );
}

function registerRemoveIntegrationAccount(server: McpServer): void {
  server.registerTool(
    "fillo_remove_connection_account",
    {
      title: "Remove a connected account from the workspace",
      description:
        "Permanently remove one provider account from the WHOLE workspace — by `connectionId` from " +
        "fillo_list_connections, or a whole Discord server by `guildId`. Pass exactly one. Every " +
        "project and form using it loses that destination, stored credentials are deleted, and " +
        "reconnecting means a fresh OAuth consent (or re-inviting the bot). This cannot be undone " +
        "from here. `confirm` must be the exact account label from fillo_list_connections, or the " +
        "Discord server id when removing a server. fillo_list_connections also shows how many " +
        `forms depend on each. Ask the human first. Needs ${SCOPE}.`,
      inputSchema: {
        connectionId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Account id from fillo_list_connections."),
        guildId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Discord server id to disconnect instead."),
        confirm: typedConfirm("account label, or the Discord server id for a guildId removal"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ connectionId, guildId, confirm }) => {
      if (Boolean(connectionId) === Boolean(guildId)) {
        return fail("Provide connectionId or guildId, not both.");
      }
      const call = await laneCall(
        {
          path: guildId
            ? `/integrations/discord/servers/${encodeURIComponent(guildId)}`
            : `/integrations/accounts/${encodeURIComponent(connectionId ?? "")}`,
          method: "DELETE",
          body: { confirm },
        },
        {
          scope: SCOPE,
          fallback: guildId
            ? "Couldn't disconnect that Discord server"
            : "Couldn't remove that account",
          missing: guildId
            ? `Discord server "${guildId}" isn't connected to this workspace.`
            : `No integration account "${connectionId}" in this workspace.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        guildId
          ? `Disconnected Discord server "${res.json?.name ?? guildId}".`
          : `Removed the ${res.json?.provider ?? ""} account "${res.json?.label ?? connectionId}".`.trim(),
        res.json,
      );
    },
  );
}

function registerRenameDiscordAccount(server: McpServer): void {
  server.registerTool(
    "fillo_rename_discord_channel",
    {
      title: "Rename a connected Discord channel",
      description:
        "Change the display name Fillo shows for a connected Discord channel webhook. Cosmetic and " +
        "local to Fillo: nothing in Discord changes and no form's destination moves. An empty label " +
        `clears the custom name and falls back to the channel's own. Needs ${SCOPE}.`,
      inputSchema: {
        accountId: z
          .string()
          .trim()
          .min(1)
          .describe("Discord account id from fillo_list_connections."),
        label: z.string().max(200).describe("New display name. Empty string clears it."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ accountId, label }) => {
      const call = await laneCall(
        {
          path: `/integrations/discord/accounts/${encodeURIComponent(accountId)}`,
          method: "PATCH",
          body: { label },
        },
        {
          scope: SCOPE,
          fallback: "Couldn't rename that Discord channel",
          missing: `No Discord account "${accountId}" in this workspace.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        res.json?.label ? `Renamed it to "${res.json.label}".` : "Cleared the custom name.",
        res.json,
      );
    },
  );
}

// --------------------------------------------------------------- HubSpot ---

function registerHubSpotProperties(server: McpServer): void {
  server.registerTool(
    "fillo_hubspot_properties",
    {
      title: "List HubSpot contact properties",
      description:
        "List every standard and custom Contact property the connected HubSpot account offers, with " +
        "its type and enumeration options. Use it to build the hubspotMappings you pass to " +
        `fillo_enable_integration — a mapping naming a property that does not exist is rejected. Needs ${SCOPE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const call = await laneCall(
        { path: "/integrations/hubspot/properties" },
        {
          scope: SCOPE,
          fallback: "Couldn't list HubSpot properties",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.properties) ? (res.json.properties as unknown[]) : [];
      return ok(`${rows.length} HubSpot contact properties.`, res.json);
    },
  );
}

function registerHubSpotPipelines(server: McpServer): void {
  server.registerTool(
    "fillo_hubspot_pipelines",
    {
      title: "List HubSpot deal pipelines",
      description:
        "List the connected HubSpot account's deal pipelines and their stages. Use it to fill " +
        "hubspotDeal.pipelineId and hubspotDeal.stageId when wiring a form that should create " +
        `deals. Needs ${SCOPE}.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const call = await laneCall(
        { path: "/integrations/hubspot/pipelines" },
        {
          scope: SCOPE,
          fallback: "Couldn't list HubSpot pipelines",
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.pipelines) ? (res.json.pipelines as unknown[]) : [];
      return ok(`${plural(rows.length, "HubSpot deal pipeline")}.`, res.json);
    },
  );
}

/** The providers these tools will act on, exported so a test can assert the
 *  set rather than re-listing it. */
export const MANAGED_PROVIDERS: readonly string[] = PROVIDERS;
