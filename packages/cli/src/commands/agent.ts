import { API, networkFailure, REQUEST_TIMEOUT_MS, requireTokenFor } from "../lib/api.js";
import { enumFlag, type Flags, flagString, optionalStringFlag } from "../lib/flags.js";
import {
  bold,
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
import { login } from "./auth.js";
import {
  previewLimitLine,
  printExistingWorkspaceGuard,
  type ProvisionedWorkspace,
  resolveWorkspaceIdentity,
} from "./init.js";
import { installSkill } from "./skill.js";

const BOOTSTRAP_USAGE =
  "To set up a workspace I need an email for your recovery link. Re-run: " +
  'npx @usefillo/cli@latest agent bootstrap --email you@company.com [--name "Your Name"]. ' +
  "(Already have an account? `fillo login`.)";

/**
 * Self-contained bootstrap — no browser handoff. Provisions a capped workspace
 * (same email flow as `fillo init`: git-identity confirm on a TTY, `--email`
 * for agents — anonymous provisioning is rejected server-side) and installs the
 * Build with Fillo skill, so `npx @usefillo/cli agent bootstrap` gets a human
 * or their agent all the way to "describe a form". The `--run --token` form
 * stays the browser-watched variant.
 */
async function bootstrapStandalone(flags: Flags, apiBase: string): Promise<void> {
  if (flags.account === true) {
    die(
      "--account is for the browser handoff: `fillo agent bootstrap --run <id> --token <token> --account`.",
    );
  }
  const json = jsonMode(flags);
  // Resolve — and echo — the workspace this run will use BEFORE installing the
  // skill or doing anything else, so an existing login can never silently
  // attach the run to a real workspace instead of a fresh preview.
  const identity = await resolveWorkspaceIdentity(flags, BOOTSTRAP_USAGE, apiBase);
  if (!json) {
    if (identity.existing) printExistingWorkspaceGuard(identity.workspace);
    else printNewWorkspace(identity);
  }
  const targets = installSkill(flags, { quiet: json });
  if (json) {
    return emitResult(
      identity.existing
        ? { existing: true, workspace: identity.workspace, skill: { installed: true, targets } }
        : {
            existing: false,
            workspace: identity.workspace,
            pk: identity.pk,
            email: identity.email,
            name: identity.name || null,
            limits: identity.limits ?? null,
            // The pre-authoring uploads signal for the fresh preview, so an
            // agent can decide on a `file_upload` field before authoring —
            // without a login (`whoami`/`storage status` need one). Omitted
            // when an older server didn't return it.
            ...(identity.canPublishFileFields === undefined
              ? {}
              : { canPublishFileFields: identity.canPublishFileFields }),
            skill: { installed: true, targets },
          },
    );
  }
  console.log(
    `\n  ${bold("Next:")} tell your agent what form to build${
      identity.existing ? ` in ${bold(terminalText(identity.workspace))}` : ""
    }, or push one directly:`,
  );
  console.log(`  ${dim("fillo push form.json --handle my-form")}\n`);
}

/** The NEW-workspace confirmation lines for a freshly provisioned preview. */
function printNewWorkspace(ws: ProvisionedWorkspace): void {
  console.log(`\n  ${okMark()} New workspace ${bold(terminalText(ws.workspace))} provisioned.`);
  console.log(
    `  ${dim(`A workspace link was sent to ${terminalText(ws.email)} — claim it anytime with \`fillo claim\`.`)}`,
  );
  const preview = previewLimitLine(ws.limits);
  if (preview) console.log(`  ${dim(preview)}`);
  // The pre-authoring uploads check, surfaced right where a first-timer starts:
  // on the unclaimed preview `whoami`/`storage status` are unreachable (no
  // login), so this is the only pre-authoring read of the signal available.
  if (ws.canPublishFileFields === true) {
    console.log(`  ${dim("File uploads: storage ready — a file field can publish now.")}`);
  } else if (ws.canPublishFileFields === false) {
    console.log(
      `  ${dim("File uploads: no destination yet — connect one (fillo storage connect) before publishing a file field.")}`,
    );
  }
}

const AGENT_ACTIONS = ["claim_required", "storage_required", "publish_required"] as const;
type AgentAction = (typeof AGENT_ACTIONS)[number];

// Statuses the CLI may post to an agent run. Keep in sync with
// AGENT_RUN_STATUSES in apps/web/src/lib/agent-runs.ts — that server enum also
// has "copied", which only the browser modal posts, never the CLI.
const AGENT_EVENT_STATUSES = [
  "created",
  "connected",
  "asking",
  "planning",
  "installing",
  "editing",
  "checking",
  "needs_action",
  "done",
  "error",
] as const;
type AgentEventStatus = (typeof AGENT_EVENT_STATUSES)[number];

const FORM_STATUSES = ["draft", "published"] as const;
type FormStatus = (typeof FORM_STATUSES)[number];

async function agent(subcommand: string | undefined, flags: Flags) {
  const apiBase = flagString(flags, "api")?.replace(/\/$/, "") ?? API;
  const run = flagString(flags, "run");
  const token = flagString(flags, "token");
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return agentHelp();
  }
  if (flags.account !== undefined && flags.account !== true) {
    die("--account does not take a value.");
  }

  if (subcommand === "bootstrap") {
    // No run/token → self-contained: provision + install the skill. This is the
    // path the landing's "paste to your agent" prompt uses; it needs no browser.
    if (!run || !token) return bootstrapStandalone(flags, apiBase);
    // With run/token → the browser-watched handoff: install the skill and
    // report progress into the run the browser is streaming.
    installSkill(flags);
    if (flags.account === true) {
      // The agent command stays human-only: shield the inner login from a
      // --json the caller may have passed so its output stays consistent.
      await login({ ...flags, json: false }, { continueToAgentRun: true });
    }
    return connectAgentRun(apiBase, run, token, flags.account === true);
  }

  if (!run || !token) {
    die("Usage: fillo agent <connect|event> --run <id> --token <token> [--api <url>]");
  }

  if (subcommand === "connect") {
    return connectAgentRun(apiBase, run, token, flags.account === true);
  }

  if (flags.account === true) {
    die("--account can only be used with `fillo agent bootstrap` or `fillo agent connect`.");
  }

  if (subcommand === "event") {
    const status = enumFlag(flags, "status", AGENT_EVENT_STATUSES);
    const message = flagString(flags, "message");
    if (!status)
      die('Usage: fillo agent event --status <status> --message "<what the human does next>"');
    const action = enumFlag(flags, "action", AGENT_ACTIONS);
    const formStatus = enumFlag(flags, "form-status", FORM_STATUSES);
    const formId = optionalStringFlag(flags, "form-id");
    if ((status === "done" || status === "needs_action") && !formId) {
      die(`--form-id is required when --status is ${status}.`);
    }
    if (status === "needs_action" && !action) {
      die("--action is required when --status is needs_action.");
    }
    await postAgentEvent(apiBase, run, token, {
      status,
      message,
      appUrl: flagString(flags, "app-url"),
      action,
      formId,
      formName: flagString(flags, "form-name"),
      formStatus,
    });
    console.log(`  ${okMark()} Progress sent.`);
    return;
  }

  die(`Unknown agent command: ${subcommand}`);
}

async function connectAgentRun(
  apiBase: string,
  run: string,
  token: string,
  attachAccount: boolean,
) {
  const account = attachAccount ? await attachAgentAccount(apiBase, run, token) : undefined;
  await postAgentEvent(apiBase, run, token, {
    status: "connected",
    message: "Agent connected. Reading the app now.",
  });
  console.log(`  ${okMark()} Live progress connected.`);
  if (account) {
    console.log(`  ${okMark()} ${bold(account.workspace)}`);
    console.log(`  ${dim("Publishable key:")} ${account.publishableKey}`);
  }
  console.log(`  ${dim("Report next steps with:")}`);
  console.log(
    `  fillo agent event --api ${terminalText(apiBase)} --run ${terminalText(run)} --token <same-token> --status editing --message "Editing the form screen"`,
  );
  console.log(
    `  ${dim("For needs_action or done, lead --message with what the human does next — max 180 chars, longer is cut off.")}`,
  );
}

async function postAgentEvent(
  apiBase: string,
  run: string,
  token: string,
  body: {
    status: AgentEventStatus;
    message?: string;
    appUrl?: string;
    action?: AgentAction;
    formId?: string;
    formName?: string;
    formStatus?: FormStatus;
  },
) {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/v1/agent-runs/${encodeURIComponent(run)}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkFailure(apiBase, error);
  }
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) die(payload.error ?? `agent progress failed (${res.status}).`);
}

async function attachAgentAccount(
  apiBase: string,
  run: string,
  progressToken: string,
): Promise<{ workspace: string; publishableKey: string }> {
  const accountToken = requireTokenFor(apiBase);
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/v1/agent-runs/${encodeURIComponent(run)}/account`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accountToken}`,
        "X-Fillo-Agent-Run-Token": progressToken,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkFailure(apiBase, error);
  }
  const payload = (await res.json().catch(() => ({}))) as {
    workspace?: unknown;
    publishableKey?: unknown;
    error?: string;
  };
  if (!res.ok) {
    const hint = res.status === 401 ? " Run `fillo login` and try again." : "";
    die(`${payload.error ?? `account connection failed (${res.status}).`}${hint}`);
  }
  if (
    typeof payload.workspace !== "string" ||
    !terminalText(payload.workspace) ||
    typeof payload.publishableKey !== "string" ||
    !/^pk_[A-Za-z0-9_-]{1,125}$/.test(payload.publishableKey)
  ) {
    die("Fillo returned an invalid workspace connection.");
  }
  return { workspace: terminalText(payload.workspace), publishableKey: payload.publishableKey };
}

function agentHelp() {
  console.log(`
  ${boldRaw("fillo agent")} — report live progress back to a Fillo prompt modal

  ${boldRaw("Commands")}
    agent bootstrap     Set up a workspace and install the Build with Fillo skill
                       ${dimRaw("--email you@company.com   provision a fresh workspace (a TTY confirms your git identity)")}
                       ${dimRaw('--name "Your Name"        optional display name')}
                       ${dimRaw("--workspace-name <name>   name the new workspace (default: this repo/directory)")}
                       ${dimRaw("--api <url>               target a different Fillo deployment (default: FILLO_API or https://fillo.so)")}
                       ${dimRaw("--run <id> --token <token>   instead: attach to an open browser modal")}
                       ${dimRaw("--account   with --run/--token: approve an existing workspace in the browser")}
                       ${dimRaw("A stored `fillo login` is reused as-is (and named) — run `fillo logout` first for an isolated preview.")}
    agent connect       Connect a coding-agent run to the open browser modal
                       ${dimRaw("--account   attach the workspace from `fillo login`")}
    agent event         Send a short progress update
                       ${dimRaw(`--status <${AGENT_EVENT_STATUSES.join("|")}>`)}
                       ${dimRaw('--message "What the human does next" (max 180 chars)')}
                       ${dimRaw("--form-id <id> --form-status <draft|published> --form-name <name>")}
                       ${dimRaw("--action <claim_required|storage_required|publish_required>")}
                       ${dimRaw("--app-url <localhost-url>")}
                       ${dimRaw("--run <id> --token <token> --api <url>")}

  ${dimRaw("For --status needs_action or done, lead the message with what the human does")}
  ${dimRaw('next, in one or two sentences, plus the form URL or form id — e.g. "Connect')}
  ${dimRaw('storage in Fillo, publish the form, then submit one test response".')}
  ${dimRaw("Max 180 characters — longer is cut off. Never list changed files in the message.")}
`);
}

export const agentCommand: Command = {
  name: "agent",
  flags: [
    "email",
    "name",
    "workspace-name",
    "run",
    "token",
    "api",
    "account",
    "status",
    "message",
    "app-url",
    "action",
    "form-id",
    "form-name",
    "form-status",
  ],
  run: (args, flags) => agent(args[0], flags),
  help: agentHelp,
};
