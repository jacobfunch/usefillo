import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural } from "../result.js";
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
      title: localCapability("fillo_get_integration").title,
      description: localCapability("fillo_get_integration").description,
      inputSchema: { form: FORM_ARG, provider: PROVIDER_ARG },
      annotations: localCapability("fillo_get_integration").annotations,
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
      title: localCapability("fillo_enable_integration").title,
      description: localCapability("fillo_enable_integration").description,
      inputSchema: {
        form: FORM_ARG,
        provider: PROVIDER_ARG,
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Provider config keys. Omit for providers that can create a destination."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: localCapability("fillo_enable_integration").annotations,
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
      title: localCapability("fillo_disable_integration").title,
      description: localCapability("fillo_disable_integration").description,
      inputSchema: { form: FORM_ARG, provider: PROVIDER_ARG },
      annotations: localCapability("fillo_disable_integration").annotations,
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
      title: localCapability("fillo_list_connections").title,
      description: localCapability("fillo_list_connections").description,
      inputSchema: {},
      annotations: localCapability("fillo_list_connections").annotations,
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
      title: localCapability("fillo_select_connection").title,
      description: localCapability("fillo_select_connection").description,
      inputSchema: {
        provider: z.enum(ACCOUNT_PROVIDERS).describe("notion, slack, hubspot, or discord."),
        connectionId: z.string().trim().min(1).describe("Account id from fillo_list_connections."),
      },
      annotations: localCapability("fillo_select_connection").annotations,
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
      title: localCapability("fillo_disconnect_integration").title,
      description: localCapability("fillo_disconnect_integration").description,
      inputSchema: {
        provider: z.enum(ACCOUNT_PROVIDERS).describe("notion, slack, hubspot, or discord."),
        confirm: typedConfirm("provider name"),
      },
      annotations: localCapability("fillo_disconnect_integration").annotations,
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
      title: localCapability("fillo_remove_connection_account").title,
      description: localCapability("fillo_remove_connection_account").description,
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
      annotations: localCapability("fillo_remove_connection_account").annotations,
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
      title: localCapability("fillo_rename_discord_channel").title,
      description: localCapability("fillo_rename_discord_channel").description,
      inputSchema: {
        accountId: z
          .string()
          .trim()
          .min(1)
          .describe("Discord account id from fillo_list_connections."),
        label: z.string().max(200).describe("New display name. Empty string clears it."),
      },
      annotations: localCapability("fillo_rename_discord_channel").annotations,
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
      title: localCapability("fillo_hubspot_properties").title,
      description: localCapability("fillo_hubspot_properties").description,
      inputSchema: {},
      annotations: localCapability("fillo_hubspot_properties").annotations,
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
      title: localCapability("fillo_hubspot_pipelines").title,
      description: localCapability("fillo_hubspot_pipelines").description,
      inputSchema: {},
      annotations: localCapability("fillo_hubspot_pipelines").annotations,
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
