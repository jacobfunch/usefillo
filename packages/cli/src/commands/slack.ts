import { API, api, readJson, requireToken } from "../lib/api.js";
import { connectViaBrowser } from "../lib/browser-connect.js";
import type { Flags } from "../lib/flags.js";
import {
  boldRaw,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
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
 */

type SlackChannel = { id: string; name: string; isPrivate: boolean };
type SlackStatus = {
  connected: boolean;
  accountLabel?: string;
  channels?: SlackChannel[];
  channelsSyncedAt?: string | null;
  error?: string;
};

async function slackStartUrl(token: string): Promise<string> {
  const res = await api("/cli/whoami", { token });
  const body = (await readJson(res)) as { projectId?: string; error?: string };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok || typeof body.projectId !== "string" || !body.projectId) {
    die(body.error ?? "Couldn't resolve the selected Fillo project.");
  }
  return `${API}/api/integrations/slack/start?return=terminal&project=${encodeURIComponent(body.projectId)}`;
}

async function refresh(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();
  const res = await api("/cli/slack?refresh=1", { token });
  const body = (await readJson(res)) as SlackStatus;
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 409) {
    // The install was revoked/expired — only a browser reconnect can fix it.
    const startUrl = await slackStartUrl(token);
    die(
      `${body.error ?? "Reconnect Slack in the browser to refresh channels."} Reconnect at ${startUrl}`,
    );
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    die(
      `${body.error ?? "Slack is rate-limiting channel refreshes."}` +
        (retryAfter ? ` (retry after ${retryAfter}s)` : ""),
    );
  }
  if (!res.ok) die(body.error ?? `slack refresh failed (${res.status}).`);
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
  const token = requireToken();
  const res = await api("/cli/slack", { token });
  const body = (await readJson(res)) as SlackStatus;
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok) die(body.error ?? `slack status failed (${res.status}).`);
  if (json) return emitResult(body);

  if (!body.connected) {
    console.log("  Slack is not connected. Run `fillo slack connect` to install the app.");
    return;
  }
  const channels = body.channels ?? [];
  console.log(
    `  ${okMark()} Connected to Slack${body.accountLabel ? ` (${terminalText(body.accountLabel)})` : ""} — ${channels.length} channel${channels.length === 1 ? "" : "s"} cached.`,
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
  const startUrl = await slackStartUrl(token);
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

async function slack(subcommand: string | undefined, flags: Flags) {
  if (subcommand === "help") return slackHelp();
  if (subcommand === "connect") return connect(flags);
  // `fillo slack`, `fillo slack --channels`, `fillo slack --refresh` are status.
  if (subcommand !== undefined && subcommand !== "status") {
    die(`Unknown slack command: ${terminalText(subcommand)} (expected status or connect).`);
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

  ${dimRaw("--refresh surfaces reconnect (409) and rate-limit (429) failures distinctly.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const slackCommand: Command = {
  name: "slack",
  flags: ["channels", "refresh"],
  run: (args, flags) => slack(args[0], flags),
  help: slackHelp,
};
