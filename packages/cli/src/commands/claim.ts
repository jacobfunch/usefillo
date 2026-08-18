import { API, api, readJson } from "../lib/api.js";
import { readConfig, writeConfig } from "../lib/config.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  agentMode,
  bold,
  boldRaw,
  die,
  dim,
  dimRaw,
  emitProgress,
  emitResult,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";
import { fetchWorkspaceName } from "./auth.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AGENT_WAIT_LINE =
  "Do not retry claim in a loop. Tell the human to open the claim email; this command waits.";

/** Hardcoded cadences honor FILLO_POLL_INTERVAL_MS only when it is set. */
function pollIntervalMs(): number | undefined {
  const raw = process.env.FILLO_POLL_INTERVAL_MS;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

type DeviceGrant = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
};

/**
 * How the claim email went out, which decides the guidance:
 * - "page": the device code is attached to the provision, so the claim page
 *   itself offers "Approve terminal" after claiming.
 * - "device": the email carries only the claim link — the human approves this
 *   terminal afterwards on the /device page.
 */
type ApprovalPath = "page" | "device";

async function claim(flags: Flags) {
  const json = jsonMode(flags);
  const cfg = readConfig();
  if (!cfg.pk) {
    die(
      "Nothing to claim here — run `fillo init --email you@company.com` or the agent bootstrap first. " +
        "Already have an account? Run `fillo login`.",
    );
  }

  // A working login means the workspace is already claimed and connected.
  if (cfg.token && cfg.tokenApi?.replace(/\/$/, "") === API) {
    const probe = await api("/cli/whoami", { token: cfg.token }).catch(() => null);
    if (probe?.ok) {
      const me = (await probe.json().catch(() => ({}))) as { workspace?: unknown };
      const workspace = typeof me.workspace === "string" ? terminalText(me.workspace) : "";
      if (json) return emitResult({ connected: true, workspace, alreadyConnected: true });
      console.log(
        `  ${okMark()} Already connected${workspace ? ` to ${bold(workspace)}` : ""} — this workspace is claimed.`,
      );
      return;
    }
  }

  // Device code FIRST, so the claim email can carry the terminal approval.
  const codeRes = await api("/device/code", { method: "POST" });
  if (!codeRes.ok) die(`Couldn't start the claim (${codeRes.status}).`);
  const grant = (await readJson(codeRes)) as DeviceGrant;

  const emailFlag = flagString(flags, "email");
  const savedEmail = cfg.email;
  const { approval, sentTo, notice } = await sendClaimEmail(
    grant,
    cfg.claimToken,
    emailFlag,
    savedEmail,
  );

  const alreadyClaimed = approval === "device" && notice === "already_claimed";
  if (json) {
    emitProgress({
      status: "awaiting_claim",
      code: grant.user_code,
      ...(sentTo ? { email: sentTo } : {}),
      verification_uri: grant.verification_uri,
      approval,
      ...(notice ? { notice } : {}),
      note: AGENT_WAIT_LINE,
    });
  } else {
    printGuidance(grant, approval, sentTo, notice);
  }

  await pollForGrant(grant, cfg.pk, approval, alreadyClaimed, json);
}

/**
 * Get the claim email (with the device code attached when possible) into the
 * owner's inbox. Prefers the claim token `fillo init` saved — the cookie-keyed
 * endpoints attach the user code to the provision so the claim page can offer
 * terminal approval. Falls back to the email-keyed resend (fresh claim link,
 * no attach) for configs that predate the saved token.
 */
async function sendClaimEmail(
  grant: DeviceGrant,
  claimToken: string | undefined,
  emailFlag: string | undefined,
  savedEmail: string | undefined,
): Promise<{ approval: ApprovalPath; sentTo?: string; notice?: string }> {
  const email = emailFlag ?? savedEmail;
  if (claimToken) {
    const cookie = { Cookie: `fillo_claim=${claimToken}` };
    const res = await api("/workspaces/resend-claim", {
      method: "POST",
      headers: cookie,
      body: JSON.stringify({ user_code: grant.user_code }),
    });
    const body = (await readJson(res)) as { ok?: boolean; outcome?: string; error?: string };
    if (!res.ok) die(body.error ?? `Couldn't send the claim email (${res.status}).`);
    const outcome = body.ok === true ? (body.outcome ?? "invalid") : "invalid";
    if (outcome === "sent") return { approval: "page", sentTo: savedEmail ?? emailFlag };
    if (outcome === "rate_limited") {
      // The code was still attached (the server attaches before the mail cap),
      // and the previously sent link stays valid — same page, same approval.
      return { approval: "page", sentTo: savedEmail ?? emailFlag, notice: "recent_email" };
    }
    if (outcome === "claimed") return { approval: "device", notice: "already_claimed" };
    if (outcome === "no_email") {
      if (!email) {
        die("Fillo has no email on file for this workspace. Re-run with --email you@company.com.");
      }
      const linkRes = await api("/workspaces/claim-link", {
        method: "POST",
        headers: cookie,
        body: JSON.stringify({ email, user_code: grant.user_code }),
      });
      const linkBody = (await readJson(linkRes)) as { ok?: boolean; error?: string };
      if (!linkRes.ok) die(linkBody.error ?? `Couldn't send the claim email (${linkRes.status}).`);
      return { approval: "page", sentTo: email };
    }
    // "invalid": the saved claim link was rotated or expired — try the
    // email-keyed fallback below.
  }

  if (!email) {
    die(
      claimToken
        ? "The saved claim link is no longer valid. Re-run with --email you@company.com (the address from setup) to get a fresh one."
        : "This setup predates terminal claim. Re-run with --email you@company.com — the address given to `fillo init`.",
    );
  }
  // Email-keyed resend: sends a fresh claim link but cannot attach the device
  // code, so approval happens on the /device page after the claim.
  const res = await api("/workspaces/resend-workspace-link", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  const body = (await readJson(res)) as { ok?: boolean; error?: string };
  if (!res.ok) die(body.error ?? `Couldn't send the claim email (${res.status}).`);
  return { approval: "device", sentTo: email };
}

function printGuidance(
  grant: DeviceGrant,
  approval: ApprovalPath,
  sentTo: string | undefined,
  notice: string | undefined,
) {
  if (notice === "already_claimed") {
    console.log("\n  This workspace is already claimed.");
  } else if (notice === "recent_email") {
    console.log(
      `\n  A claim email was already sent recently${sentTo ? ` to ${bold(terminalText(sentTo))}` : ""} — open that one.`,
    );
  } else {
    console.log(
      `\n  Claim email sent${sentTo ? ` to ${bold(terminalText(sentTo))}` : " to the address from your setup"}.`,
    );
  }
  console.log(`\n  Your code:  ${bold(grant.user_code)}\n`);
  if (notice === "already_claimed") {
    console.log(`  Sign in at ${terminalText(grant.verification_uri)} and enter the code`);
    console.log("  to approve this terminal.");
  } else if (approval === "page") {
    console.log("  Open the claim link in your inbox — the page will show this code.");
    console.log("  Approve only if it matches.");
  } else {
    console.log("  Open the claim link in your inbox to claim the workspace, then");
    console.log(`  approve this terminal at ${terminalText(grant.verification_uri)} (same code).`);
  }
  if (agentMode()) console.log(`  ${AGENT_WAIT_LINE}`);
}

async function pollForGrant(
  grant: DeviceGrant,
  pk: string,
  approval: ApprovalPath,
  alreadyClaimed: boolean,
  json: boolean,
) {
  const deadline = Date.now() + grant.expires_in * 1000;
  let interval = grant.interval * 1000;
  const statusEvery = pollIntervalMs() ?? 5000;
  let nextStatusAt = Date.now() + statusEvery;
  let claimedAnnounced = alreadyClaimed;
  const dots = !json && !agentMode();
  if (dots) process.stdout.write("\n  Waiting for the claim");

  // Ctrl-C means this terminal stopped waiting — deny the code (best-effort, a
  // second interrupt or a 1.5s cap forces the exit) so the browser won't offer
  // to connect a terminal that's gone; the claim page then just shows "Save
  // workspace". Cleaned up on any normal exit below.
  let interrupting = false;
  const onSigint = () => {
    if (interrupting) process.exit(130);
    interrupting = true;
    setTimeout(() => process.exit(130), 1500).unref();
    void api("/device/cancel", {
      method: "POST",
      body: JSON.stringify({ device_code: grant.device_code }),
    })
      .catch(() => {})
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", onSigint);
  try {
    return await pollLoop();
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  async function pollLoop() {
  while (Date.now() < deadline) {
    await sleep(interval);
    if (dots) process.stdout.write(".");
    const res = await api("/device/token", {
      method: "POST",
      body: JSON.stringify({ device_code: grant.device_code }),
    });
    const body = (await readJson(res)) as { access_token?: string; error?: string };
    if (!res.ok && !body.error) die(`\nClaim failed (${res.status}).`);
    if (body.access_token) {
      return connected(body.access_token, json, dots);
    }
    if (body.error === "slow_down") interval += 2000;
    else if (body.error === "access_denied") return declined(json, dots);
    else if (body.error === "expired_token") break;
    else if (body.error && body.error !== "authorization_pending") {
      die(`\nClaim failed: ${body.error}`);
    }

    // Informational side-channel: tell the human the claim landed while the
    // terminal approval is still pending. Never fatal, and stops once seen.
    if (!claimedAnnounced && Date.now() >= nextStatusAt) {
      nextStatusAt = Date.now() + statusEvery;
      const status = await api(`/workspaces/claim-status?key=${encodeURIComponent(pk)}`).catch(
        () => null,
      );
      if (status?.ok) {
        const state = (await status.json().catch(() => ({}))) as { claimed?: boolean };
        if (state.claimed === true) {
          claimedAnnounced = true;
          if (json) {
            emitProgress({ status: "claimed_pending_approval", code: grant.user_code });
          } else if (approval === "page") {
            console.log(
              `${dots ? "\n" : ""}  Workspace claimed — approve the terminal step on the same page (code ${grant.user_code}).`,
            );
          } else {
            console.log(
              `${dots ? "\n" : ""}  Workspace claimed — approve this terminal at ${terminalText(grant.verification_uri)} (code ${grant.user_code}).`,
            );
          }
        }
      }
    }
  }

  const minutes = Math.max(1, Math.round(grant.expires_in / 60));
  if (json) {
    emitResult({ connected: false, error: "expired" });
    process.exit(1);
  }
  console.log(`\n  The code expired (${minutes} minutes). Run \`fillo claim\` again.`);
  process.exit(1);
  }
}

async function connected(token: string, json: boolean, dots: boolean) {
  // Upgrade the config in place: keep the pk (and email), retire the spent
  // claim token — it is single-use server-side once the workspace is claimed.
  const { claimToken: _spent, ...rest } = readConfig();
  writeConfig({ ...rest, token, tokenApi: API });
  const workspace = await fetchWorkspaceName(API);
  if (json) {
    emitProgress({ status: "connected" });
    emitResult({ connected: true, workspace });
    return;
  }
  console.log(
    `${dots ? "\n" : ""}\n  ${okMark()} Workspace claimed — connected to ${bold(workspace)}.`,
  );
  console.log(`\n  ${bold("Next:")}`);
  console.log(
    `    fillo keys create --name agent --preset agent   ${dim("mint a scoped key for your coding agent")}`,
  );
  console.log(
    `    fillo push form.json --handle my-form           ${dim("create or update a form")}`,
  );
  console.log(`    fillo publish my-form                           ${dim("take it live")}\n`);
}

function declined(json: boolean, dots: boolean): void {
  if (json) {
    emitResult({ connected: false, error: "access_denied" });
    process.exit(1);
  }
  console.log(
    `${dots ? "\n" : ""}  Approval declined from the browser. Run \`fillo claim\` again when ready.`,
  );
  process.exit(1);
}

function claimHelp() {
  console.log(`
  ${boldRaw("fillo claim")} — claim the provisioned workspace from your terminal

  Sends the claim email (with this terminal's approval code attached), then
  waits. Open the claim link in your inbox: the page claims the workspace and
  offers to approve this terminal — approve only if the code matches.

  ${boldRaw("Flags")}
    --email <addr>   only needed when the setup predates the saved claim info
                     ${dimRaw("(use the address given to `fillo init`)")}

  ${dimRaw("On success the login is stored and the publishable key is kept.")}
  ${dimRaw("--json prints progress on stderr and one final JSON object on stdout.")}
`);
}

export const claimCommand: Command = {
  name: "claim",
  flags: ["email"],
  run: (_args, flags) => claim(flags),
  help: claimHelp,
};
