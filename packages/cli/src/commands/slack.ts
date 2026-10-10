import { api, callApi, failed, readJson, requireToken } from "../lib/api.js";
import { connectViaBrowser } from "../lib/browser-connect.js";
import { requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  getIntegration,
  type IntegrationView,
  integrationDisable,
  integrationStatus,
  putIntegration,
  terminalConnectUrl,
} from "../lib/integration-client.js";
import {
  boldRaw,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  plural,
  printTable,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo slack` — Slack notification wiring from the terminal. Status and the
 * channel list are read-only over the human's project-pinned `fcli_` credential
 * (held by a workspace manager, so private channel names are safe to show).
 * Connecting installs the Slack app through the human's signed-in browser, so `connect` prints the
 * OAuth URL and polls until the app appears. `--refresh` is the one call that
 * reaches Slack, so its reconnect/rate-limit failures surface distinctly.
 *
 * `enable|disable|status <form>` aim one form at a channel. Enabling is Tier B
 * (docs/engineering/agent-parity.md): responses start appearing in a Slack
 * workspace, so an agent must carry the human's yes as a bare `--confirm`.
 * Bare `fillo slack status` (no form) still reports the connection itself.
 */

type SlackChannel = { id: string; name: string; isPrivate: boolean };
type SlackStatus = {
  connected: boolean;
  accountLabel?: string;
  channels?: SlackChannel[];
  channelsSyncedAt?: string | null;
  error?: string;
};

async function refresh(flags: Flags) {
  const json = jsonMode(flags);
  const body = await callApi<SlackStatus>(
    "/cli/slack?refresh=1",
    {},
    {
      fallback: failed("slack refresh"),
      on: async (res, b) => {
        if (res.status === 409) {
          // The install was revoked/expired — only a browser reconnect fixes it.
          const startUrl = await terminalConnectUrl("slack");
          die(
            `${b.error ?? "Reconnect Slack in the browser to refresh channels."} Reconnect at ${startUrl}`,
          );
        }
        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          die(
            `${b.error ?? "Slack is rate-limiting channel refreshes."}` +
              (retryAfter ? ` (retry after ${retryAfter}s)` : ""),
          );
        }
      },
    },
  );
  if (json) return emitResult(body);
  const channels = body.channels ?? [];
  console.log(
    `  ${okMark()} Refreshed Slack channels${body.accountLabel ? ` for ${terminalText(body.accountLabel)}` : ""} — ${channels.length} cached.`,
  );
  printChannels(channels);
}

function printChannels(channels: SlackChannel[]) {
  if (channels.length === 0) {
    console.log(
      `  ${dim("No channels cached. Invite the Fillo app to a channel, then --refresh.")}`,
    );
    return;
  }
  const rows = channels.map((c) => [
    terminalText(c.name),
    c.id,
    c.isPrivate ? "private" : "public",
  ]);
  console.log("");
  printTable(["NAME", "ID", "VISIBILITY"], rows);
}

async function status(flags: Flags) {
  const json = jsonMode(flags);
  const showChannels = flags.channels === true;
  const body = await callApi<SlackStatus>("/cli/slack", {}, { fallback: failed("slack status") });
  if (json) return emitResult(body);

  if (!body.connected) {
    console.log("  Slack is not connected. Run `fillo slack connect` to install the app.");
    return;
  }
  const channels = body.channels ?? [];
  console.log(
    `  ${okMark()} Connected to Slack${body.accountLabel ? ` (${terminalText(body.accountLabel)})` : ""} — ${plural(channels.length, "channel")} cached.`,
  );
  if (showChannels) {
    printChannels(channels);
  } else {
    console.log(
      `  ${dim("Run `fillo slack --channels` to list them, or --refresh to re-pull from Slack.")}`,
    );
  }
}

async function connect(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();
  const startUrl = await terminalConnectUrl("slack");
  await connectViaBrowser({
    json,
    what: "Slack",
    startUrl,
    poll: async () => {
      const res = await api("/cli/slack", { token });
      if (res.status === 401) die("Token invalid — run `fillo login` again.");
      const body = (await readJson(res)) as SlackStatus;
      if (!res.ok) return false;
      return body.connected === true;
    },
    onConnected: () => ({
      result: { connected: true },
      lines: [
        `  ${okMark()} Slack connected.`,
        "  Run `fillo slack --channels` to pick a destination in a form's settings.",
      ],
    }),
  });
}

/* ---------------------------------------------------- one form's channel ---*/

type SlackFormConfig = {
  slackChannelId?: string;
  slackChannelLabel?: string;
  slackChannelIsPrivate?: boolean;
  slackIncludeFieldIds?: string[];
};

function printDestination(body: IntegrationView) {
  const config = (body.config ?? {}) as SlackFormConfig;
  if (!body.enabled) {
    console.log(
      "  This form isn't posting to Slack. Turn it on with `fillo slack enable <form> --channel <channelId>`.",
    );
    return;
  }
  console.log(
    `  ${okMark()} Posting every response to Slack${
      config.slackChannelLabel ? ` — ${terminalText(config.slackChannelLabel)}` : ""
    }`,
  );
  const fields = config.slackIncludeFieldIds ?? [];
  console.log(
    `  ${dim("Fields:")}   ${fields.length > 0 ? terminalText(fields.join(", ")) : "link only"}`,
  );
}

/** `--fields a,b,c` (or `none` to clear). The server re-checks every id against
 *  the form's schema and caps the list at three. */
function parseFields(raw: string): string[] {
  if (raw.trim().toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

const formStatus = integrationStatus("slack", {
  usage: "Usage: fillo slack status <form> — a form id, slug, or push handle.",
  print: printDestination,
});

async function enable(form: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!form) {
    die("Usage: fillo slack enable <form> --channel <channelId> [--fields a,b,c] [--confirm]");
  }
  const channel = flagString(flags, "channel");
  const rawFields = flagString(flags, "fields");
  const current = await getIntegration(form, "slack");
  if (!channel && !current.enabled) {
    die(
      "Pass --channel <channelId> to pick where this form posts. " +
        "`fillo slack --channels` lists the cached channels with their ids.",
    );
  }

  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    command: `fillo slack enable ${form}${channel ? ` --channel ${channel}` : ""}`,
    notice: rawFields
      ? "Every response will post to that Slack channel, carrying the answers you listed."
      : "Every response will post a notification to that Slack channel.",
  });

  const body = await putIntegration(form, "slack", {
    ...(channel ? { slackChannelId: channel } : {}),
    ...(rawFields !== undefined ? { slackIncludeFieldIds: parseFields(rawFields) } : {}),
  });
  if (json) return emitResult(body);
  printDestination(body);
}

const disable = integrationDisable("slack", {
  usage: "Usage: fillo slack disable <form> — a form id, slug, or push handle.",
  done: "This form no longer posts to Slack. The workspace's Slack app stays installed.",
});

async function slack(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === "help") return slackHelp();
  if (subcommand === "connect") return connect(flags);
  if (subcommand === "enable") return enable(args[0], flags);
  if (subcommand === "disable") return disable(args[0], flags);
  // `fillo slack status <form>` reports one form's destination; bare
  // `fillo slack`, `--channels`, `--refresh`, and `status` report the
  // connection itself, exactly as they did before forms joined this family.
  if (subcommand === "status" && args[0]) return formStatus(args[0], flags);
  if (subcommand !== undefined && subcommand !== "status") {
    die(
      `Unknown slack command: ${terminalText(subcommand)} ` +
        "(expected status, connect, enable, or disable).",
    );
  }
  if (flags.refresh === true) return refresh(flags);
  return status(flags);
}

function slackHelp() {
  console.log(`
  ${boldRaw("fillo slack")} — Slack notifications from the terminal

  ${boldRaw("Commands")}
    slack                Connection status and cached channel count
                       ${dimRaw("--channels   list the cached channels with a private marker")}
                       ${dimRaw("--refresh    re-pull the channel cache from Slack")}
    slack connect        Install the Slack app (opens an OAuth URL to approve)
    slack status <form>  What this form posts, and to which channel
    slack enable <form>  Start posting responses to a channel
                       ${dimRaw("--channel <channelId>   which channel this form posts to")}
                       ${dimRaw("--fields a,b,c          up to three field ids (none = link only)")}
                       ${dimRaw("--confirm               required for agents; ask the human first")}
    slack disable <form> Stop posting (the Slack app stays installed)

  ${dimRaw("--refresh surfaces reconnect (409) and rate-limit (429) failures distinctly.")}
  ${dimRaw("Enabling sends answers into a Slack workspace, so agents (--json or")}
  ${dimRaw("FILLO_AGENT=1) must pass a bare --confirm.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const slackCommand: Command = {
  name: "slack",
  flags: ["channels", "refresh", "channel", "fields", "confirm"],
  run: (args, flags) => slack(args[0], args.slice(1), flags),
  help: slackHelp,
};
