import { connectViaBrowser } from "../lib/browser-connect.js";
import { requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  fetchConnections,
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
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo notion` — stream a form's responses into a Notion database.
 *
 * Connecting is a browser OAuth bounce (the human picks which page Fillo may
 * write under, and that consent only exists in their signed-in browser), so
 * `connect` prints the start URL and polls until the account appears.
 *
 * Enabling is Tier B (docs/engineering/agent-parity.md): Fillo creates a
 * database under that page and every answer starts landing in it, so an agent
 * must carry the human's yes as a bare `--confirm`.
 */

type NotionConfig = {
  databaseId?: string;
  databaseUrl?: string;
  titleFieldId?: string;
  properties?: Array<{ key: string; name: string }>;
};

function printStatus(body: IntegrationView) {
  const config = (body.config ?? {}) as NotionConfig;
  if (!body.enabled) {
    console.log(
      "  This form isn't streaming to Notion. Turn it on with `fillo notion enable <form>`.",
    );
    return;
  }
  console.log(`  ${okMark()} Adding every response as a page in Notion`);
  if (config.databaseUrl) {
    console.log(`  ${dim("Database:")}     ${terminalText(config.databaseUrl)}`);
  }
  console.log(
    `  ${dim("Page title:")}   ${config.titleFieldId ? terminalText(config.titleFieldId) : "first answer"}`,
  );
}

async function connect(flags: Flags) {
  const json = jsonMode(flags);
  const startUrl = await terminalConnectUrl("notion");
  await connectViaBrowser({
    json,
    what: "Notion",
    startUrl,
    poll: async () => {
      const connections = await fetchConnections();
      return typeof connections.selected?.notion === "string";
    },
    onConnected: () => ({
      result: { connected: true },
      lines: [
        `  ${okMark()} Notion connected.`,
        "  Turn a form on with `fillo notion enable <form> --confirm`.",
      ],
    }),
  });
}

const status = integrationStatus("notion", {
  usage: "Usage: fillo notion status <form> — a form id, slug, or push handle.",
  print: printStatus,
});

async function enable(form: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!form) die("Usage: fillo notion enable <form> [--title-field <fieldId>] [--confirm]");
  const titleField = flagString(flags, "title-field");

  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    command: `fillo notion enable ${form}`,
    notice:
      "Fillo will create a database in the connected Notion workspace and add every response to it as a page.",
  });

  const body = await putIntegration(form, "notion", {
    ...(titleField !== undefined
      ? { titleFieldId: titleField.toLowerCase() === "none" ? null : titleField }
      : {}),
  });
  if (json) return emitResult(body);
  printStatus(body);
}

const disable = integrationDisable("notion", {
  usage: "Usage: fillo notion disable <form> — a form id, slug, or push handle.",
  done: "This form no longer writes to Notion. The database stays where it is.",
});

async function notion(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "help") return notionHelp();
  if (subcommand === "connect") return connect(flags);
  if (subcommand === "status") return status(args[0], flags);
  if (subcommand === "enable") return enable(args[0], flags);
  if (subcommand === "disable") return disable(args[0], flags);
  die(
    `Unknown notion command: ${terminalText(subcommand)} ` +
      "(expected connect, status, enable, or disable).",
  );
}

function notionHelp() {
  console.log(`
  ${boldRaw("fillo notion")} — add every response to a Notion database

  ${boldRaw("Commands")}
    notion connect           Connect a Notion workspace (opens an OAuth URL to approve)
                       ${dimRaw("share a page with Fillo on Notion's consent screen")}
    notion status <form>     Whether this form writes pages, and to which database
    notion enable <form>     Create the database and start adding pages
                       ${dimRaw("--title-field <id>  which answer becomes the page title (none to clear)")}
                       ${dimRaw("--confirm           required for agents; ask the human first")}
    notion disable <form>    Stop writing (the database stays where it is)

  ${dimRaw("Enabling sends every answer to a Notion workspace, so agents (--json or")}
  ${dimRaw("FILLO_AGENT=1) must pass a bare --confirm.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const notionCommand: Command = {
  name: "notion",
  flags: ["title-field", "confirm"],
  run: (args, flags) => notion(args[0], args.slice(1), flags),
  help: notionHelp,
};
