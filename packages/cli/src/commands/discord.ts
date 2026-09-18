import { callApi, failed, requireToken } from "../lib/api.js";
import { connectViaBrowser } from "../lib/browser-connect.js";
import { promptsBlocked, requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
import { terminalConnectUrl } from "../lib/integration-client.js";
import {
  boldRaw,
  die,
  dim,
  dimRaw,
  emitProgress,
  emitResult,
  jsonMode,
  okMark,
  printTable,
  terminalText,
} from "../lib/output.js";
import { readSecret } from "../lib/prompt.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo discord` — the Discord destination from the terminal, end to end:
 * connect the channel, turn a form on, choose what the message carries, and
 * hand out a community role.
 *
 * Two rules shape the surface:
 *
 *   - A webhook URL is the whole credential, so `webhook` never takes it as an
 *     argument. Arguments land in shell history, `ps` output, and CI logs; the
 *     hidden prompt and FILLO_DISCORD_WEBHOOK_URL do not.
 *   - Early signal and auto-join are consent decisions (every answer into a
 *     channel; adding people to a server), so setting either prints a one-line
 *     notice saying what was agreed to. There is no confirmation prompt —
 *     agents run non-interactively, and the human's yes belongs upstream of the
 *     command, not inside it.
 */

const WEBHOOK_URL_ENV = "FILLO_DISCORD_WEBHOOK_URL";
const SNOWFLAKE = /^\d{17,20}$/;
const EARLY_SIGNAL_CHOICES = ["5", "10", "25", "off"] as const;

type DiscordConnection = {
  connected: boolean;
  webhookId: string | null;
  channelLabel: string | null;
  guildId: string | null;
  appConfigured: boolean;
  botConfigured: boolean;
  error?: string;
};

type DiscordRoleGrant = { guildId: string; roleId: string; autoJoin?: boolean };

type DiscordDestination = {
  enabled: boolean;
  webhookId: string | null;
  channelLabel: string | null;
  includedFieldIds: string[];
  earlySignalLimit: number | null;
  earlySignalDelivered: number;
  roleGrant: DiscordRoleGrant | null;
  appConfigured: boolean;
  botConfigured: boolean;
  connected: boolean;
  connectionWebhookId: string | null;
  connectionLabel: string | null;
  webhookMatches: boolean;
  /** Channel webhooks the workspace holds (paste lane). */
  channels?: Array<{ connectionId: string; webhookId: string; label: string }>;
  /** Servers the workspace connected (bot lane); `enable --channel` targets a
   *  channel id inside one of them. */
  servers?: Array<{ guildId: string; name: string | null }>;
  error?: string;
};

type GuildChoice = { id: string; name: string | null };
type GuildRole = { id: string; name: string; grantable: boolean };

/** One consent line the human (or the agent relaying to them) must see. */
function notice(json: boolean, line: string) {
  if (json) emitProgress({ status: "notice", notice: line });
  else console.log(`  ${line}`);
}

function fetchConnection(token: string): Promise<DiscordConnection> {
  return callApi<DiscordConnection>(
    "/cli/discord",
    { token },
    { fallback: failed("discord status") },
  );
}

/** The 404 every per-form Discord call answers the same way. */
function formDestination(
  form: string,
  init: { token: string; method?: string; body?: string },
  verb: "status" | "update",
): Promise<DiscordDestination> {
  return callApi<DiscordDestination>(`/cli/forms/${encodeURIComponent(form)}/discord`, init, {
    fallback: failed(`discord ${verb}`),
    on: (res, b) => {
      if (res.status === 404) die(b.error ?? "Form not found in the selected project.");
    },
  });
}

function fetchDestination(token: string, form: string): Promise<DiscordDestination> {
  return formDestination(form, { token }, "status");
}

function putDestination(
  token: string,
  form: string,
  patch: Record<string, unknown>,
): Promise<DiscordDestination> {
  return formDestination(form, { token, method: "PUT", body: JSON.stringify(patch) }, "update");
}

/**
 * Discord's own consent screen doubles as the channel picker: the human chooses
 * the server and channel there and Discord creates the webhook. It only exists
 * on a deploy with a Discord app, so that is checked BEFORE a URL is printed —
 * a start route that would answer 501 is worse than a sentence naming the
 * paste route that always works.
 */
async function connect(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();
  const connection = await fetchConnection(token);
  if (!connection.appConfigured) {
    die(
      "This Fillo deployment has no Discord app, so there's no one-click channel picker. " +
        "Run `fillo discord webhook` to paste a channel webhook URL instead.",
    );
  }
  const startUrl = await terminalConnectUrl("discord");
  let connected: DiscordConnection | null = null;
  await connectViaBrowser({
    json,
    what: "Discord",
    startUrl,
    poll: async () => {
      const snapshot = await fetchConnection(token);
      connected = snapshot;
      return snapshot.connected === true;
    },
    onConnected: () => {
      const label = connected?.channelLabel ?? null;
      return {
        result: {
          connected: true,
          webhookId: connected?.webhookId ?? null,
          channelLabel: label,
        },
        lines: [
          `  ${okMark()} Discord connected${label ? ` (${terminalText(label)})` : ""}.`,
          "  Turn a form on with `fillo discord enable <form>`.",
        ],
      };
    },
  });
}

/**
 * Paste lane. The URL is read from the hidden prompt or the environment and
 * goes straight into the request body: it is never an argument, never echoed,
 * and never printed back — not even on failure.
 */
async function webhook(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();
  let url = process.env[WEBHOOK_URL_ENV]?.trim() ?? "";
  if (!url) {
    if (promptsBlocked(flags)) {
      die(
        `Set ${WEBHOOK_URL_ENV} to the channel webhook URL and re-run. ` +
          "It is never accepted as an argument — arguments land in shell history and `ps` output.",
      );
    }
    url = await readSecret("  Discord webhook URL (hidden): ").catch(() => "");
    if (!url) {
      die(`No webhook URL entered. Paste it at the prompt, or set ${WEBHOOK_URL_ENV} and re-run.`);
    }
  }
  const label = flagString(flags, "label");
  const body = await callApi<{ webhookId: string; label?: string }>(
    "/cli/discord/webhook",
    { token, method: "POST", body: JSON.stringify({ url, ...(label ? { label } : {}) }) },
    {
      fallback: failed("discord webhook"),
      expect: (b) => Boolean(b.webhookId),
    },
  );
  if (json) return emitResult(body);
  console.log(
    `  ${okMark()} Connected Discord${body.label ? ` (${terminalText(body.label)})` : ""}.`,
  );
  console.log("  Turn a form on with `fillo discord enable <form>`.");
}

function printDestination(body: DiscordDestination) {
  if (!body.connected) {
    console.log(
      "  Discord is not connected to this project. Run `fillo discord connect` (or " +
        "`fillo discord webhook` to paste a channel URL).",
    );
    return;
  }
  if (!body.enabled) {
    console.log(
      `  Discord is connected${body.connectionLabel ? ` (${terminalText(body.connectionLabel)})` : ""} but this form isn't sending. ` +
        "Turn it on with `fillo discord enable <form>`.",
    );
    return;
  }
  console.log(
    `  ${okMark()} Sending to Discord${body.channelLabel ? ` — ${terminalText(body.channelLabel)}` : ""}`,
  );
  const fields = body.includedFieldIds ?? [];
  console.log(
    `  ${dim("Fields:")}        ${fields.length > 0 ? terminalText(fields.join(", ")) : "link only"}`,
  );
  console.log(
    `  ${dim("Early signal:")}  ${
      body.earlySignalLimit
        ? `first ${body.earlySignalLimit} responses in full (${body.earlySignalDelivered} sent)`
        : "off"
    }`,
  );
  const grant = body.roleGrant;
  console.log(
    `  ${dim("Role grant:")}    ${
      grant
        ? `${terminalText(grant.roleId)} in ${terminalText(grant.guildId)}${grant.autoJoin ? " (auto-join)" : ""}`
        : "off"
    }`,
  );
  if (!body.webhookMatches && body.connectionLabel) {
    // A form on its own channel is a normal state — say so without alarm.
    console.log(
      `\n  ${dim(
        `This form posts to its own channel; the project default is ${terminalText(body.connectionLabel)}. ` +
          "Re-point it with `fillo discord enable <form> --channel <channelId>`.",
      )}`,
    );
  }
  const servers = body.servers ?? [];
  if (servers.length > 0) {
    console.log("");
    printTable(
      ["SERVER", "ID"],
      servers.map((server) => [terminalText(server.name ?? "(name unavailable)"), server.guildId]),
    );
    console.log(`\n  ${dim("Aim a form: fillo discord enable <form> --channel <channelId>")}`);
  }
  const channels = body.channels ?? [];
  if (servers.length === 0 && channels.length > 1) {
    console.log("");
    printTable(
      ["CHANNEL", "WEBHOOK ID"],
      channels.map((channel) => [terminalText(channel.label), channel.webhookId]),
    );
  }
}

async function status(form: string | undefined, flags: Flags) {
  if (!form) die("Usage: fillo discord status <form> — a form id, slug, or push handle.");
  const body = await fetchDestination(requireToken(), form);
  if (jsonMode(flags)) return emitResult(body);
  printDestination(body);
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

/** `--role <guildId>/<roleId>` (or `none` to clear). Both halves are Discord
 *  snowflakes; the server re-proves the pair against Discord before storing it. */
function parseRole(raw: string): DiscordRoleGrant | null {
  if (raw.trim().toLowerCase() === "none") return null;
  const [guildId, roleId, ...extra] = raw.trim().split("/");
  if (
    extra.length > 0 ||
    !guildId ||
    !roleId ||
    !SNOWFLAKE.test(guildId) ||
    !SNOWFLAKE.test(roleId)
  ) {
    die(
      "--role must be <guildId>/<roleId> (Discord ids), or none to clear it. " +
        "List them with `fillo discord roles [guildId]`.",
    );
  }
  return { guildId, roleId };
}

async function enable(form: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!form)
    die(
      "Usage: fillo discord enable <form> [--channel <webhookId>] [--fields a,b,c] [--early-signal 5|10|25|off]",
    );
  const token = requireToken();
  const current = await fetchDestination(token, form);
  const channels = current.channels ?? [];
  if ((!current.connected || !current.connectionWebhookId) && channels.length === 0) {
    die(
      "Discord isn't connected to this project. Run `fillo discord connect`, or " +
        "`fillo discord webhook` to paste a channel URL.",
    );
  }

  // `--channel <channelId>` names the Discord channel this form posts to —
  // any channel in a connected server, so two forms can post to two rooms.
  // The server resolves it through the bot and mints the webhook. Without it,
  // a form being turned on gets the project's default channel.
  const rawChannel = flagString(flags, "channel");
  if (rawChannel !== undefined && !SNOWFLAKE.test(rawChannel.trim())) {
    die("--channel must be a Discord channel id (right-click the channel → Copy Channel ID).");
  }
  const targetChannelId = rawChannel?.trim() ?? null;
  const fallbackWebhookId =
    current.connectionWebhookId ??
    (channels.length === 1 ? (channels[0]?.webhookId ?? null) : null);
  if (!current.enabled && !targetChannelId && !fallbackWebhookId) {
    die(
      "Pass --channel <channelId> to pick where this form posts. " +
        "`fillo discord status <form>` lists the connected servers.",
    );
  }

  const patch: Record<string, unknown> = {};
  // Already live: leave the destination alone unless --channel deliberately
  // re-points it. Re-provisioning clears the early-signal window — consent
  // given for THIS channel — so it must never happen as a side effect.
  if (targetChannelId) {
    // An explicit --channel is always a deliberate aim, so it always ships;
    // the server reuses the channel's existing webhook on a re-pick.
    patch.enabled = true;
    patch.channelId = targetChannelId;
  } else if (!current.enabled && fallbackWebhookId) {
    patch.enabled = true;
    patch.webhookId = fallbackWebhookId;
  }

  const rawFields = flagString(flags, "fields");
  if (rawFields !== undefined) patch.includeFieldIds = parseFields(rawFields);

  const rawEarly = flagString(flags, "early-signal");
  if (rawEarly !== undefined) {
    if (!(EARLY_SIGNAL_CHOICES as readonly string[]).includes(rawEarly)) {
      die(`--early-signal must be one of: ${EARLY_SIGNAL_CHOICES.join(", ")}`);
    }
    patch.earlySignalLimit = rawEarly === "off" ? null : Number(rawEarly);
  }

  const rawRole = flagString(flags, "role");
  const autoJoin = flags["auto-join"] === true;
  if (rawRole !== undefined) {
    const grant = parseRole(rawRole);
    patch.roleGrant = grant ? { ...grant, ...(autoJoin ? { autoJoin: true } : {}) } : null;
  } else if (autoJoin) {
    die(
      "--auto-join needs --role <guildId>/<roleId> — it widens that grant, it isn't a setting on its own.",
    );
  }

  // Nothing left to apply means the form is already sending — to whichever
  // channel it pinned — and no option was passed. That is the state `enable`
  // asks for, so report it and succeed — an agent making sure Discord is on
  // must not read "already on" as a failure.
  if (Object.keys(patch).length === 0) {
    if (json) return emitResult(current);
    printDestination(current);
    return;
  }

  // Consent notices, printed before the write so they are visible even if the
  // server rejects it. No prompt: an agent runs non-interactively, and the
  // human's yes belongs upstream.
  if (typeof patch.earlySignalLimit === "number") {
    notice(
      json,
      `Early signal sends every answer to this channel for the first ${patch.earlySignalLimit} responses.`,
    );
  }
  if (patch.roleGrant && autoJoin) {
    notice(
      json,
      "Auto-join adds respondents to your Discord server with that role — Discord asks each person's permission first.",
    );
  } else if (patch.roleGrant) {
    notice(
      json,
      "Respondents who verify with Discord get that role once their response is accepted.",
    );
  }

  const body = await putDestination(token, form, patch);
  if (json) return emitResult(body);
  printDestination(body);
}

async function disable(form: string | undefined, flags: Flags) {
  if (!form) die("Usage: fillo discord disable <form> — a form id, slug, or push handle.");
  const token = requireToken();
  const body = await putDestination(token, form, { enabled: false });
  if (jsonMode(flags)) return emitResult(body);
  console.log(
    `  ${okMark()} This form no longer posts to Discord. The workspace's webhook stays connected.`,
  );
}

async function roles(guildId: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  const path = guildId
    ? `/cli/discord/roles?guildId=${encodeURIComponent(guildId)}`
    : "/cli/discord/roles";
  const body = await callApi<{
    guilds?: GuildChoice[];
    guildsUnavailable?: boolean;
    roles?: GuildRole[];
  }>(
    path,
    {},
    // 403 is the tenant boundary: the bot may be in that server, but this
    // workspace has no webhook posting into it.
    { fallback: failed("discord roles") },
  );
  if (json) return emitResult(body);

  if (!guildId) {
    const guilds = body.guilds ?? [];
    if (guilds.length === 0) {
      console.log(
        "  No Discord servers yet — connect a channel webhook first with `fillo discord connect`.",
      );
      return;
    }
    console.log("");
    printTable(
      ["SERVER", "ID"],
      guilds.map((guild) => [terminalText(guild.name ?? "(name unavailable)"), guild.id]),
    );
    if (body.guildsUnavailable === true) {
      console.log(
        `\n  ${dim("Discord didn't answer, so some names are missing. Ids still work.")}`,
      );
    }
    console.log(`\n  ${dim("List a server's roles: fillo discord roles <id>")}`);
    return;
  }

  const list = body.roles ?? [];
  if (list.length === 0) {
    console.log("  That server has no roles Fillo could list.");
    return;
  }
  console.log("");
  printTable(
    ["ROLE", "ID", "GRANTABLE"],
    list.map((role) => [terminalText(role.name), role.id, role.grantable ? "yes" : "no"]),
  );
  console.log(`\n  ${dim(`Use one: fillo discord enable <form> --role ${guildId}/<roleId>`)}`);
  console.log(
    `  ${dim("A role marked no sits above Fillo's own role, or belongs to another integration.")}`,
  );
}

/**
 * Name (or, with an empty value, un-name) one connected channel. The webhook
 * Discord creates through OAuth is named after the application, so without this
 * a channel reads as "Fillo" — meaningless to whoever picked #leads on
 * Discord's consent screen. Label only: nothing re-delivers, so no confirmation.
 */
async function rename(connectionId: string | undefined, args: string[], flags: Flags) {
  const json = jsonMode(flags);
  if (!connectionId) {
    die('Usage: fillo discord rename <connectionId> "<label>" — ids from `fillo connections`.');
  }
  // The label may be several words, so take the rest of the line, not args[0].
  const label = args.join(" ");
  const body = await callApi<{ id?: string; label?: string }>(
    `/cli/integrations/discord/accounts/${encodeURIComponent(connectionId)}`,
    { method: "PATCH", body: JSON.stringify({ label }) },
    { fallback: failed("discord rename") },
  );
  if (json) return emitResult(body);
  console.log(
    body.label
      ? `  ${okMark()} That channel now shows as ${terminalText(body.label)}.`
      : `  ${okMark()} Cleared that channel's name.`,
  );
}

/**
 * Disconnect a whole SERVER: its guild connection and every channel webhook
 * Fillo holds there go together, and the forms pinned to them stop posting.
 * Tier C, so the guild id must be typed back with --confirm. Removing the bot
 * from the server itself is done in Discord, by its owner.
 */
async function disconnectServer(guildId: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!guildId) {
    die("Usage: fillo discord disconnect-server <guildId> --confirm <guildId>");
  }
  // The server judges the typed id, so the flag travels verbatim.
  const confirm = await requireConfirm(flags, {
    tier: "C",
    resolveTarget: async () => guildId,
    notice:
      "This drops the guild connection and every channel webhook Fillo holds there; the forms pinned to them stop posting.",
    refusal:
      "Refusing to disconnect that Discord server without confirmation. Re-run with " +
      `--confirm "<exact value>": \`fillo discord disconnect-server ${guildId} --confirm ${guildId}\`. ` +
      "There is no confirmation-free removal (--yes never skips it).",
  });
  const body = await callApi<{ disconnected?: boolean; guildId?: string; name?: string | null }>(
    `/cli/integrations/discord/servers/${encodeURIComponent(guildId)}`,
    { method: "DELETE", body: JSON.stringify({ confirm }) },
    {
      fallback: failed("discord disconnect-server"),
      expect: (b) => b.disconnected === true,
      on: (res, b) => {
        if (res.status === 404) {
          die(
            "That server isn't connected to this workspace. Run `fillo connections` to list them.",
          );
        }
        if (res.status === 409) {
          die(
            b.error ?? "The confirm value did not match the server id — nothing was disconnected.",
          );
        }
      },
    },
  );
  if (json) return emitResult(body);
  console.log(
    `  ${okMark()} Disconnected ${terminalText(body.name ?? guildId)}. Its channels and the forms ` +
      "pinned to them have stopped posting.",
  );
  console.log(`  ${dim("Remove Fillo's bot from the server in Discord to finish the job.")}`);
}

async function discord(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "help") return discordHelp();
  if (subcommand === "connect") return connect(flags);
  if (subcommand === "webhook") return webhook(flags);
  if (subcommand === "status") return status(args[0], flags);
  if (subcommand === "enable") return enable(args[0], flags);
  if (subcommand === "disable") return disable(args[0], flags);
  if (subcommand === "roles") return roles(args[0], flags);
  if (subcommand === "rename") return rename(args[0], args.slice(1), flags);
  if (subcommand === "disconnect-server") return disconnectServer(args[0], flags);
  die(
    `Unknown discord command: ${terminalText(subcommand)} ` +
      "(expected connect, webhook, status, enable, disable, roles, rename, or disconnect-server).",
  );
}

function discordHelp() {
  console.log(`
  ${boldRaw("fillo discord")} — post responses to a Discord channel, from the terminal

  ${boldRaw("Commands")}
    discord connect          Let Discord pick the channel and create the webhook
                       ${dimRaw("opens an OAuth URL to approve; needs a Discord app on this deploy")}
    discord webhook          Connect a channel webhook you paste
                       ${dimRaw("--label <name>   what Fillo shows for this channel")}
                       ${dimRaw(`reads the URL from a hidden prompt, or ${WEBHOOK_URL_ENV}`)}
    discord status <form>    What this form sends, to where, with which extras
    discord enable <form>    Start sending — and set any of the options below
                       ${dimRaw("--channel <channelId>     which channel this form posts to (bot lane)")}
                       ${dimRaw("--fields a,b,c            up to three field ids (none = link only)")}
                       ${dimRaw("--early-signal 5|10|25    first N responses arrive in full (off to stop)")}
                       ${dimRaw("--role <guildId>/<roleId> grant that role on an accepted response")}
                       ${dimRaw("--auto-join               with --role: add non-members to the server")}
    discord disable <form>   Stop this form posting (the webhook stays connected)
    discord roles [guildId]  Your servers, or one server's roles and what Fillo can grant
    discord rename <id> <label>     Name one connected channel
                       ${dimRaw("ids come from `fillo connections`; an empty label clears the name")}
    discord disconnect-server <guildId>   Drop a whole server and its channels
                       ${dimRaw("--confirm <guildId>   required; every form pinned there stops posting")}

  ${dimRaw("The webhook URL is the whole credential, so it is NEVER an argument —")}
  ${dimRaw("arguments land in shell history and `ps` output. Paste it at the hidden")}
  ${dimRaw(`prompt, or set ${WEBHOOK_URL_ENV} for an unattended run.`)}
  ${dimRaw("--early-signal and --auto-join widen what leaves Fillo, so each prints a")}
  ${dimRaw("one-line notice saying what was agreed to. Ask the human before setting them.")}
  ${dimRaw("Re-enabling against a different webhook clears early signal — that consent")}
  ${dimRaw("was given for one channel and is never carried into another.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const discordCommand: Command = {
  name: "discord",
  flags: ["label", "channel", "fields", "early-signal", "role", "auto-join", "confirm", "yes"],
  run: (args, flags) => discord(args[0], args.slice(1), flags),
  help: discordHelp,
};
