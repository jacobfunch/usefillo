import { API, api, readJson, requireTokenFor } from "../lib/api.js";
import { readConfig, writeConfig } from "../lib/config.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  chooseLoginMode,
  generatePkce,
  isSshSession,
  openBrowser,
  randomState,
  startLoopbackServer,
} from "../lib/loopback.js";
import {
  agentMode,
  bold,
  die,
  dim,
  emitProgress,
  emitResult,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fillo login` router. A human at a real terminal on the same machine gets the
 * zero-typing loopback + PKCE lane; agents/pipes, an explicit `--headless`/
 * `--device`, a `--run/--token` agent handoff, and SSH sessions take the
 * device-code flow (loopback's 127.0.0.1 callback can't reach a remote shell).
 * The loopback lane is also wrapped so a bind failure or approval timeout falls
 * back to the device-code flow — nobody is stranded on 127.0.0.1.
 */
export async function login(flags: Flags, options: { continueToAgentRun?: boolean } = {}) {
  const run = flagString(flags, "run");
  const progressToken = flagString(flags, "token");
  if (Boolean(run) !== Boolean(progressToken)) {
    die("--run and --token must be provided together for an agent handoff login.");
  }
  const apiBase = flagString(flags, "api")?.replace(/\/$/, "") ?? API;
  const headless = flags.headless === true || flags.device === true;
  const mode = chooseLoginMode({
    agent: agentMode(),
    headless,
    handoff: Boolean(run),
    ssh: isSshSession(),
  });
  if (mode === "loopback") {
    try {
      await loginLoopback(flags, apiBase);
      return;
    } catch (err) {
      // Only bind/timeout/state failures reach here (a real exchange failure
      // die()s inside loginLoopback). Never strand the user: fall through.
      if (!jsonMode(flags)) {
        const reason = err instanceof Error ? terminalText(err.message) : "loopback unavailable";
        console.log(`\n  ${dim(`Couldn't complete the browser handoff (${reason}).`)}`);
        console.log(`  ${dim("Falling back to the code flow.")}\n`);
      }
    }
  }
  await loginHeadless(flags, options);
}

/**
 * Same-machine loopback + PKCE lane: open a 127.0.0.1 listener, send the browser
 * to /cli/authorize, and catch the one-time code on the loopback — no code typed.
 * The verifier is exchanged for the bearer at /cli/token. Throws on bind/timeout
 * so the router can fall back; a genuine exchange failure die()s here.
 */
async function loginLoopback(flags: Flags, apiBase: string) {
  const json = jsonMode(flags);
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  // A bind failure throws to the router (fall back to the device-code flow).
  const server = await startLoopbackServer();
  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    // The consent screen is an app PAGE (not under /api/v1), so build its URL
    // directly rather than through api().
    const authorizeUrl = `${apiBase}/cli/authorize?${new URLSearchParams({
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      redirect_uri: redirectUri,
    }).toString()}`;

    // Throws on timeout/state mismatch → router falls back to the device flow.
    let code: string;
    if (json) {
      emitProgress({
        status: "awaiting_approval",
        url: authorizeUrl,
        note: "Approve in the browser; this command waits. Do not retry in a loop.",
      });
      openBrowser(authorizeUrl);
      code = await server.waitForCode(state, 5 * 60_000);
    } else {
      // Transient prompt + spinner while we wait; wiped on return so the success
      // line lands clean.
      code = await approveInBrowser(authorizeUrl, () => server.waitForCode(state, 5 * 60_000));
    }

    const res = await api(
      "/cli/token",
      {
        method: "POST",
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
      },
      apiBase,
    );
    const body = (await readJson(res)) as { access_token?: string; error?: string };
    // The human already approved in the browser — a failed exchange is a real
    // error the device-code flow can't fix, so die() rather than fall back.
    if (!res.ok || !body.access_token) {
      die(`\nLogin failed${body.error ? `: ${terminalText(body.error)}` : ` (${res.status}).`}`);
    }
    // Merge, don't replace. Keep any provisioned public key on the config.
    writeConfig({ ...readConfig(), token: body.access_token, tokenApi: apiBase });
    const workspace = await fetchWorkspaceName(apiBase);
    if (json) {
      emitResult({ connected: true, workspace });
      return;
    }
    // One obvious line — the transient approval prompt above is already wiped.
    console.log(`  ${okMark()} ${bold(`Connected to ${workspace}`)}`);
    console.log(`  ${dim("Next:")} fillo push form.json\n`);
  } finally {
    server.close();
  }
}

/**
 * Show the approval prompt with a spinner, open the browser, and wait for the
 * loopback callback — then wipe those transient lines so the caller lands on one
 * obvious success line. Clears only on a real TTY; degrades to plain prints when
 * piped. The spinner is stopped and the lines wiped on ANY exit (success or the
 * timeout/state-mismatch that sends the router to the device-code fallback).
 */
async function approveInBrowser(
  authorizeUrl: string,
  wait: () => Promise<string>,
): Promise<string> {
  const tty = process.stdout.isTTY === true;
  process.stdout.write(`\n  Approve this terminal in your browser — opening it now.\n`);
  process.stdout.write(`  ${dim(authorizeUrl)}\n`);
  openBrowser(authorizeUrl);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let spinner: ReturnType<typeof setInterval> | undefined;
  if (tty) {
    spinner = setInterval(() => {
      process.stdout.write(`\r  ${frames[frame++ % frames.length]} Waiting for approval…`);
    }, 90);
  } else {
    process.stdout.write("  Waiting for approval…\n");
  }
  try {
    return await wait();
  } finally {
    if (spinner) clearInterval(spinner);
    if (tty) {
      // Wipe the three transient lines (spinner, URL, prompt); a leading blank
      // stays above so the success line has breathing room.
      process.stdout.write("\r\x1b[K");
      process.stdout.write("\x1b[1A\x1b[2K");
      process.stdout.write("\x1b[1A\x1b[2K");
    } else {
      process.stdout.write("\n");
    }
  }
}

/**
 * Device-authorization (RFC 8628) fallback: print a short code + URL for a human
 * to approve in any browser, then poll for the grant. The headless/agent lane —
 * unchanged behavior — and the target of `--run/--token` agent handoffs.
 */
async function loginHeadless(flags: Flags, options: { continueToAgentRun?: boolean } = {}) {
  const json = jsonMode(flags);
  const apiBase = flagString(flags, "api")?.replace(/\/$/, "") ?? API;
  const run = flagString(flags, "run");
  const progressToken = flagString(flags, "token");
  const res = await api(
    "/device/code",
    {
      method: "POST",
      ...(run
        ? {
            body: JSON.stringify({
              agent_run_id: run,
              agent_run_token: progressToken,
            }),
          }
        : {}),
    },
    apiBase,
  );
  if (!res.ok) die(`Couldn't start login (${res.status}).`);
  const d = (await readJson(res)) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };

  if (json) {
    emitProgress({
      status: "awaiting_approval",
      code: d.user_code,
      url: d.verification_uri_complete,
      note: "Do not retry login in a loop; ask the human to complete the browser step. This command waits.",
    });
  } else if (agentMode()) {
    // An agent's terminal has no browser to open. Print everything the agent
    // needs to relay, then wait.
    console.log(`\n  Your code:  ${bold(d.user_code)}`);
    console.log(`  Ask the human to open ${terminalText(d.verification_uri_complete)}`);
    console.log(`  and approve code ${d.user_code} there.`);
    console.log(
      "  Do not retry login in a loop; ask the human to complete the browser step. This command waits.",
    );
  } else {
    console.log(`\n  Your code:  ${bold(d.user_code)}`);
    console.log(`  Approve it at ${terminalText(d.verification_uri)} — opening your browser…\n`);
    openBrowser(d.verification_uri_complete);
  }

  const deadline = Date.now() + d.expires_in * 1000;
  let interval = d.interval * 1000;
  const dots = !json && !agentMode();
  if (dots) process.stdout.write("  Waiting for approval");
  while (Date.now() < deadline) {
    await sleep(interval);
    if (dots) process.stdout.write(".");
    const r = await api(
      "/device/token",
      {
        method: "POST",
        body: JSON.stringify({ device_code: d.device_code }),
      },
      apiBase,
    );
    const body = (await readJson(r)) as { access_token?: string; error?: string };
    if (!r.ok && !body.error) die(`\nLogin failed (${r.status}).`);
    if (body.access_token) {
      // Merge, don't replace. Keep any provisioned public key on the config.
      writeConfig({ ...readConfig(), token: body.access_token, tokenApi: apiBase });
      const workspace = await fetchWorkspaceName(apiBase);
      if (json) {
        emitResult({ connected: true, workspace });
        return;
      }
      console.log(dots ? "\n" : "");
      printConnected(workspace);
      console.log(
        options.continueToAgentRun
          ? `\n  ${dim("Workspace approved. Connecting this setup...")}\n`
          : run
            ? `\n  ${dim("Return to the Fillo setup prompt and run its next command.")}\n`
            : `\n  ${dim("Now run:")} fillo push form.json\n`,
      );
      return;
    }
    if (body.error === "slow_down") interval += 2000;
    else if (body.error && body.error !== "authorization_pending")
      die(`\nLogin failed: ${body.error}`);
  }
  die("\nLogin timed out — run `fillo login` again.");
}

type WhoamiResult = {
  workspace: string;
  workspaceId?: string;
  workspaceSlug?: string;
  project?: string;
  projectId?: string;
  projectSlug?: string;
  canPublishFileFields?: boolean;
};

/** Resolve the signed-in workspace identity plus its pre-authoring storage
 *  signal (dying on any auth problem). `canPublishFileFields` is absent on
 *  older servers. */
export async function fetchWhoami(apiBase: string = API): Promise<WhoamiResult> {
  const res = await api("/cli/whoami", { token: requireTokenFor(apiBase) }, apiBase);
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (!res.ok) die(`whoami failed (${res.status}).`);
  const me = (await readJson(res)) as {
    workspace?: unknown;
    workspaceId?: unknown;
    workspaceSlug?: unknown;
    project?: unknown;
    projectId?: unknown;
    projectSlug?: unknown;
    canPublishFileFields?: unknown;
  };
  const workspace = typeof me.workspace === "string" ? terminalText(me.workspace) : "";
  if (!workspace) die("Fillo returned an invalid workspace identity.");
  return {
    workspace,
    ...(typeof me.workspaceId === "string" ? { workspaceId: terminalText(me.workspaceId) } : {}),
    ...(typeof me.workspaceSlug === "string"
      ? { workspaceSlug: terminalText(me.workspaceSlug) }
      : {}),
    ...(typeof me.project === "string" ? { project: terminalText(me.project) } : {}),
    ...(typeof me.projectId === "string" ? { projectId: terminalText(me.projectId) } : {}),
    ...(typeof me.projectSlug === "string" ? { projectSlug: terminalText(me.projectSlug) } : {}),
    canPublishFileFields:
      typeof me.canPublishFileFields === "boolean" ? me.canPublishFileFields : undefined,
  };
}

/** Resolve just the signed-in workspace name (the login flows need no more). */
export async function fetchWorkspaceName(apiBase: string = API): Promise<string> {
  return (await fetchWhoami(apiBase)).workspace;
}

function printConnected(workspace: string) {
  console.log(`  ${okMark()} Connected to ${bold(workspace)}`);
}

async function whoami(flags: Flags) {
  const me = await fetchWhoami(API);
  if (jsonMode(flags)) {
    return emitResult({
      connected: true,
      workspace: me.workspace,
      ...(me.workspaceId ? { workspaceId: me.workspaceId } : {}),
      ...(me.workspaceSlug ? { workspaceSlug: me.workspaceSlug } : {}),
      ...(me.project ? { project: me.project } : {}),
      ...(me.projectId ? { projectId: me.projectId } : {}),
      ...(me.projectSlug ? { projectSlug: me.projectSlug } : {}),
      ...(me.canPublishFileFields === undefined
        ? {}
        : { canPublishFileFields: me.canPublishFileFields }),
    });
  }
  printConnected(me.project ? `${me.workspace} / ${me.project}` : me.workspace);
  // The pre-authoring storage check, surfaced on the identity command an agent
  // already runs before building: decide whether a file_upload field can ship.
  if (me.canPublishFileFields === true) {
    console.log(`  ${dim("File uploads: storage ready — a file field can publish now.")}`);
  } else if (me.canPublishFileFields === false) {
    console.log(
      `  ${dim("File uploads: no destination yet — connect one (fillo storage connect) before publishing a file field.")}`,
    );
  }
}

function logout() {
  // Drop the account credential and its bound origin. Keep any provisioned
  // public key so a preview workspace is not lost locally.
  const { token, tokenApi, ...rest } = readConfig();
  writeConfig(rest);
  return console.log("  Logged out.");
}

export const loginCommand: Command = {
  name: "login",
  flags: ["api", "run", "token", "headless", "device"],
  run: (_args, flags) => login(flags),
};

export const logoutCommand: Command = {
  name: "logout",
  flags: [],
  run: () => logout(),
};

export const whoamiCommand: Command = {
  name: "whoami",
  flags: [],
  run: (_args, flags) => whoami(flags),
};
