import { requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  type IntegrationView,
  integrationDisable,
  integrationStatus,
  putIntegration,
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
 * `fillo sheets` — stream a form's responses into Google Sheets from the
 * terminal. Enabling without `--sheet` creates a new spreadsheet in the
 * workspace's connected Drive; `--sheet` streams into one the workspace already
 * owns (the link's `#gid` picks the tab).
 *
 * Enabling is Tier B (docs/engineering/agent-parity.md): every answer starts
 * landing in a Google account, so an agent must carry the human's yes as a bare
 * `--confirm`. Disabling is Tier A — the spreadsheet stays exactly where it is.
 */

type SheetsConfig = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  spreadsheetTitle?: string;
  sheetTab?: string;
  sheetTabId?: number;
};

/**
 * A pasted Sheets link or a bare spreadsheet id. Mirrors the server's
 * `parseSheetRef` so a bad paste fails here, before a round trip — the server
 * validates it again against the live spreadsheet either way.
 */
function parseSheetFlag(raw: string): { spreadsheetId: string; sheetTabId?: number } {
  const value = raw.trim();
  const gid = value.match(/[#&?]gid=(\d+)/)?.[1];
  const urlId = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  let spreadsheetId: string | undefined;
  if (urlId) spreadsheetId = urlId;
  else if (/^https?:\/\//i.test(value) || value.includes("/")) {
    die(
      "--sheet isn't a Google Sheets link. Open the sheet and copy its URL from the address bar.",
    );
  } else if (/^[a-zA-Z0-9_-]{10,}$/.test(value)) spreadsheetId = value;
  if (!spreadsheetId) die("--sheet must be a Google Sheets link or spreadsheet id.");
  return { spreadsheetId, ...(gid ? { sheetTabId: Number(gid) } : {}) };
}

function printStatus(body: IntegrationView) {
  const config = (body.config ?? {}) as SheetsConfig;
  if (!body.enabled) {
    console.log(
      "  This form isn't streaming to Google Sheets. Turn it on with `fillo sheets enable <form>`.",
    );
    return;
  }
  console.log(
    `  ${okMark()} Appending every response to ${terminalText(config.spreadsheetTitle ?? "a Google Sheet")}`,
  );
  if (config.spreadsheetUrl)
    console.log(`  ${dim("Sheet:")}  ${terminalText(config.spreadsheetUrl)}`);
  if (config.sheetTab) console.log(`  ${dim("Tab:")}    ${terminalText(config.sheetTab)}`);
}

const status = integrationStatus("google_sheets", {
  usage: "Usage: fillo sheets status <form> — a form id, slug, or push handle.",
  print: printStatus,
});

async function enable(form: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!form) die("Usage: fillo sheets enable <form> [--sheet <url|id>] [--confirm]");
  const raw = flagString(flags, "sheet");
  const target = raw === undefined ? null : parseSheetFlag(raw);

  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    command: `fillo sheets enable ${form}`,
    notice: target
      ? "Every response to this form will be appended to that Google Sheet, in the workspace's connected Google account."
      : "Fillo will create a spreadsheet in the workspace's connected Google account and append every response to it.",
  });

  const body = await putIntegration(form, "google_sheets", target ?? {});
  if (json) return emitResult(body);
  printStatus(body);
}

const disable = integrationDisable("google_sheets", {
  usage: "Usage: fillo sheets disable <form> — a form id, slug, or push handle.",
  done: "This form no longer appends to Google Sheets. The spreadsheet stays where it is.",
});

async function sheets(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "help") return sheetsHelp();
  if (subcommand === "status") return status(args[0], flags);
  if (subcommand === "enable") return enable(args[0], flags);
  if (subcommand === "disable") return disable(args[0], flags);
  die(`Unknown sheets command: ${terminalText(subcommand)} (expected status, enable, or disable).`);
}

function sheetsHelp() {
  console.log(`
  ${boldRaw("fillo sheets")} — stream responses into Google Sheets

  ${boldRaw("Commands")}
    sheets status <form>     Whether this form appends, and to which sheet
    sheets enable <form>     Start appending every response
                       ${dimRaw("--sheet <url|id>   use a sheet you already own (#gid picks the tab)")}
                       ${dimRaw("--confirm          required for agents; ask the human first")}
                       ${dimRaw("without --sheet, Fillo creates a new spreadsheet in Drive")}
    sheets disable <form>    Stop appending (the spreadsheet stays where it is)

  ${dimRaw("Enabling sends every answer to a Google account, so agents (--json or")}
  ${dimRaw("FILLO_AGENT=1) must pass a bare --confirm. Connect Google Drive first with")}
  ${dimRaw("`fillo storage connect drive`. --json prints the raw server response on stdout.")}
`);
}

export const sheetsCommand: Command = {
  name: "sheets",
  flags: ["sheet", "confirm"],
  run: (args, flags) => sheets(args[0], args.slice(1), flags),
  help: sheetsHelp,
};
