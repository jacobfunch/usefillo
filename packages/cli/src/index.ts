import { readFileSync } from "node:fs";
import { agentCommand } from "./commands/agent.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { claimCommand } from "./commands/claim.js";
import { deleteCommand } from "./commands/delete.js";
import { discordCommand } from "./commands/discord.js";
import {
  listCommand,
  publishCommand,
  pushCommand,
  statusCommand,
  testResponseCommand,
} from "./commands/forms.js";
import { initCommand } from "./commands/init.js";
import { brandingCommand } from "./commands/branding.js";
import { keysCommand } from "./commands/keys.js";
import { membersCommand } from "./commands/members.js";
import { responsesCommand } from "./commands/responses.js";
import { settingsCommand } from "./commands/settings.js";
import { skillCommand } from "./commands/skill.js";
import { slackCommand } from "./commands/slack.js";
import { storageCommand } from "./commands/storage.js";
import { tokensCommand } from "./commands/tokens.js";
import { webhooksCommand } from "./commands/webhooks.js";
import { projectCommand } from "./commands/projects.js";
import { API, SYNC_TOKEN_ENV } from "./lib/api.js";
import { parseFlags, validateFlags } from "./lib/flags.js";
import { boldRaw, die, dimRaw, enableJsonOutput, terminalText } from "./lib/output.js";
import { closePrompts } from "./lib/prompt.js";
import type { Command } from "./lib/registry.js";

/**
 * The Fillo CLI. Authenticates the developer once (browser device-login) and
 * then creates/publishes real forms directly — no dashboard round-trip. Meant to
 * be run by humans or their coding agents: `npx @usefillo/cli <command>`.
 */

const REGISTRY: readonly Command[] = [
  initCommand,
  claimCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
  projectCommand,
  keysCommand,
  pushCommand,
  listCommand,
  statusCommand,
  publishCommand,
  testResponseCommand,
  responsesCommand,
  agentCommand,
  skillCommand,
  storageCommand,
  slackCommand,
  discordCommand,
  tokensCommand,
  webhooksCommand,
  settingsCommand,
  brandingCommand,
  membersCommand,
  deleteCommand,
];

const COMMANDS = new Map<string, Command>();
for (const command of REGISTRY) {
  COMMANDS.set(command.name, command);
  for (const alias of command.aliases ?? []) COMMANDS.set(alias, command);
}

function printVersion() {
  // Read at runtime from the package next to dist/ so it can't drift.
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
  } catch {
    console.log("unknown");
  }
}

function help() {
  console.log(`
  ${boldRaw("fillo")} — create Fillo forms from your terminal

  ${boldRaw("Commands")}
    init               Start a new workspace and email its workspace link
                       ${dimRaw("--email <addr>   defaults to git config user.email")}
                       ${dimRaw("--name <name>    defaults to git config user.name")}
    claim              Claim the provisioned workspace from this terminal
                       ${dimRaw("sends the claim email and waits for inbox approval")}
    login              Connect to an existing account (opens the browser)
                       ${dimRaw("--headless       approve a code instead of the local browser handoff")}
                       ${dimRaw("--run <id> --token <token>   bind a fresh agent handoff login")}
    logout             Forget the stored credentials
    whoami             Show the signed-in workspace and selected project
    project <cmd>      Isolated sites/apps: list, create, select
                       ${dimRaw("project create <name> · project select <id|slug|name>")}
    keys <cmd>         Project API keys for agents/CI: create, list, revoke
                       ${dimRaw("keys create --name <n> --preset read|agent|full")}
    push <file|->      Create/update a form from JSON (file or stdin)
                       ${dimRaw("--handle <name>  idempotent id for re-pushes")}
                       ${dimRaw("--stage          stage beside the live form for dashboard review")}
                       ${dimRaw("--draft          alias with a handle; legacy one-off draft without")}
                       ${dimRaw("--allow-code     allow a .mjs/.js schema (executes the file)")}
    list               List the project's forms and their live URLs
    status <form>      Show one form's status, live URL, and publish blockers
                       ${dimRaw("<form> is a form id or handle")}
    publish <form>     Publish staged changes (or a draft form) — prints the live URL
                       ${dimRaw("--allow-breaking  confirm removing/re-typing fields responses answered")}
    test-response <form> <file|->
                       Validate answers against staged changes without real delivery
    responses <cmd>    Read a form's responses: list, export (CSV), summary
                       ${dimRaw("responses list <form> · export <form> --out r.csv · summary <form>")}
    agent <cmd>        Prepare an agent run and report live progress
    skill install      Install the Build with Fillo Agent Skill

  ${boldRaw("Workspace")}
    storage <cmd>      Inspect/connect upload destinations (status, connect, disconnect)
                       ${dimRaw("storage connect s3 · connect drive|box · disconnect <p>")}
    slack <cmd>        Slack notifications: status, --channels, --refresh, connect
    discord <cmd>      Discord destination: connect, webhook, status, enable, disable, roles
                       ${dimRaw("discord enable <form> --fields a,b --early-signal 10 --role <g>/<r>")}
    tokens <cmd>       Connector credentials: create-connector --tool zapier|n8n
    webhooks <cmd>     A form's signed webhooks: list, add, set, remove
                       ${dimRaw("webhooks add <form> --url <u>   shows the signing secret once")}
    settings <cmd>     A form's operational settings: get, set key=value
    branding [on|off]  The workspace's "Powered by Fillo" badge (off needs Everything)
    members <cmd>      Workspace members: list, invite <email>, cancel-invite <id>
    delete <cmd>       Irreversible deletes: delete form <form> · delete workspace
                       ${dimRaw("typed confirmation required; --confirm for agents, --yes never skips")}

  ${dimRaw(`API: ${terminalText(API)}  ·  set FILLO_API to override`)}
  ${dimRaw(`${SYNC_TOKEN_ENV}: stage-only server/CI credential; requires --stage`)}
  ${dimRaw("--json on most commands prints machine-readable output: one final JSON")}
  ${dimRaw("object on stdout, progress as JSON lines on stderr. Commands without")}
  ${dimRaw("machine output (agent, skill, test-response) keep their human output.")}
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  // Before anything can print: --json switches the process to machine output
  // (JSON {error} from die, zero ANSI), including for flag-validation failures.
  if (flags.json === true) enableJsonOutput();
  const command = cmd ? COMMANDS.get(cmd) : undefined;
  validateFlags(cmd, flags, command?.flags);
  // Print our own version and exit before the command dispatch.
  if (
    cmd === "version" ||
    cmd === "--version" ||
    cmd === "-v" ||
    flags.version === true ||
    flags.v === true
  ) {
    return printVersion();
  }
  // `<command> --help` / `-h` must print help, never run the command — `init`
  // especially has a side effect (it provisions a workspace).
  if (flags.help === true || flags.h === true) {
    return (command?.help ?? help)();
  }
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    return help();
  }
  if (command) return command.run(positional, flags);
  // A typo must fail loudly — exit non-zero so scripts/agents don't read it
  // as success.
  console.error(`Unknown command: ${terminalText(cmd)}`);
  help();
  return process.exit(2);
}

main()
  .catch((e) => die(e instanceof Error ? e.message : String(e)))
  .finally(closePrompts);
