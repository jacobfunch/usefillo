import { assertMintedSecret, callApi, failed } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import { type Flags, flagString } from "../lib/flags.js";
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

/**
 * `fillo developers` — the project's code-sync settings: who may write schemas
 * from a browser, which origins may do it, and whether respondent identities
 * must be signed.
 *
 * Everything here changes how UNTRUSTED callers are treated, so all three
 * mutations sit in the human layer (docs/engineering/agent-parity.md):
 *
 *   - `policy` and `origins --set/--clear` are Tier B: an agent must pass a
 *     bare --confirm, and a one-line notice always says what changed.
 *   - `identity enable` is Tier B and prints the secret ONCE, exactly like the
 *     dashboard. `identity status` never prints it; there is no way to read it
 *     back, and enabling twice reports "already enabled" rather than echoing
 *     the existing secret.
 *   - `identity disable` is Tier C: every verified-only form starts accepting
 *     unverified claims, so the confirmation is typed: --confirm <project slug>,
 *     the slug `fillo whoami` prints (a value you have to look up, never a word
 *     the command already knows).
 *
 * All four go through `requireConfirm` (lib/confirm.ts), the one implementation
 * of those gates.
 */

const POLICIES = ["publishable_key", "trusted_only"] as const;

/** The typed Tier C target for `identity disable`: the selected project's slug,
 *  read from whoami so the value is looked up rather than guessed. */
async function projectSlug(): Promise<string> {
  const body = await callApi<{ projectSlug: string }>(
    "/cli/whoami",
    {},
    { fallback: "Couldn't read the selected project.", expect: (b) => Boolean(b.projectSlug) },
  );
  return body.projectSlug;
}

/**
 * The Tier B gate: a human at a terminal runs it directly; an agent or a pipe
 * must carry --confirm, having asked the human first. The notice prints either
 * way, and before the write, so it is visible even when the server refuses.
 * Every rule here belongs to `requireConfirm` — this only names the line.
 */
function requireOutwardConfirm(flags: Flags, line: string): Promise<true> {
  return requireConfirm(flags, { tier: "B", ttyIsConsent: true, notice: line });
}

/* ------------------------------------------------------------------ policy -- */

async function policy(value: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!value || !(POLICIES as readonly string[]).includes(value)) {
    die(`Usage: fillo developers policy ${POLICIES.join("|")}`);
  }
  await requireOutwardConfirm(
    flags,
    value === "publishable_key"
      ? "Allowing publishable-key sync lets any browser holding your pk_ key stage schema changes for review."
      : "Requiring a trusted token stops browser-side schema staging — deployments must use a sync token.",
  );

  const body = await callApi<{ policy: string }>(
    "/cli/project/code-sync",
    { method: "PATCH", body: JSON.stringify({ policy: value }) },
    { fallback: failed("developers policy"), expect: (b) => Boolean(b.policy) },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Code sync authorization is now ${bold(terminalText(body.policy))}.`);
}

/* ----------------------------------------------------------------- origins -- */

async function origins(subcommand: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  const set = flagString(flags, "set");
  const clear = flags.clear === true;
  if (set && clear) die("Provide either --set or --clear, not both.");

  if (!set && !clear) {
    if (subcommand !== undefined && subcommand !== "list") {
      die("Usage: fillo developers origins [list] [--set a,b] [--clear]");
    }
    const body = await callApi<{ origins: string[] }>(
      "/cli/project/origins",
      {},
      {
        fallback: failed("developers origins"),
        expect: (b) => Array.isArray(b.origins),
      },
    );
    if (json) return emitResult(body);
    if (body.origins.length === 0) {
      console.log(
        `  ${dim("No allowed origins — publishable-key syncs are accepted from any origin.")}`,
      );
      return;
    }
    console.log("");
    for (const origin of body.origins) console.log(`  ${terminalText(origin)}`);
    console.log("");
    return;
  }

  const next = clear
    ? []
    : (set ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  await requireOutwardConfirm(
    flags,
    next.length === 0
      ? "Clearing the allow-list accepts publishable-key syncs from ANY origin."
      : `Only these origins will be able to stage schemas with the publishable key: ${next.join(", ")}.`,
  );

  const body = await callApi<{ origins: string[] }>(
    "/cli/project/origins",
    { method: "PUT", body: JSON.stringify({ origins: next }) },
    {
      fallback: failed("developers origins"),
      expect: (b) => Array.isArray(b.origins),
    },
  );
  if (json) return emitResult(body);
  console.log(
    body.origins.length === 0
      ? `  ${okMark()} Cleared the allow-list — any origin may stage with the publishable key.`
      : `  ${okMark()} Allowed origins: ${terminalText(body.origins.join(", "))}.`,
  );
}

/* ---------------------------------------------------------------- identity -- */

type IdentityStatus = { enabled: boolean; protectedFormCount: number };

function printProtectedForms(count: number) {
  if (count === 0) return;
  console.log(
    `  ${dim(`${count} ${count === 1 ? "form requires" : "forms require"} verified respondents.`)}`,
  );
}

async function identityStatus(flags: Flags) {
  const body = await callApi<IdentityStatus>(
    "/cli/project/identity",
    {},
    { fallback: failed("developers identity") },
  );
  if (jsonMode(flags)) return emitResult(body);
  // The secret is deliberately absent: it exists in exactly one response, the
  // one that mints it. Status reports only whether enforcement is on.
  console.log(
    body.enabled
      ? `  ${okMark()} Identity verification is ${bold("on")} — respondent claims need a signature.`
      : `  Identity verification is ${bold("off")} — respondent IDs are accepted unsigned.`,
  );
  printProtectedForms(body.protectedFormCount ?? 0);
  if (body.enabled) {
    console.log(
      `  ${dim("The secret is shown only when it is created. Fillo cannot show it again.")}`,
    );
  }
}

async function identityEnable(flags: Flags) {
  const json = jsonMode(flags);
  await requireOutwardConfirm(
    flags,
    "Turning identity verification on means respondent IDs are only trusted when your server signs them — unsigned claims are recorded unverified or held, per each form's policy.",
  );

  const body = await callApi<{
    enabled?: boolean;
    minted?: boolean;
    secret?: string;
    protectedFormCount?: number;
  }>(
    "/cli/project/identity",
    { method: "POST", body: JSON.stringify({}) },
    {
      fallback: failed("developers identity enable"),
      expect: (b) => b.enabled === true,
    },
  );
  if (body.secret) assertMintedSecret(body.secret, "is_", "secret");

  if (json) return emitResult(body);
  if (body.minted !== true) {
    console.log(`  ${okMark()} Identity verification was already on — nothing changed.`);
    console.log(
      `  ${dim("The existing secret can't be shown again. Disable and re-enable to mint a new one.")}`,
    );
    printProtectedForms(body.protectedFormCount ?? 0);
    return;
  }
  console.log(`\n  ${okMark()} Identity verification is on`);
  console.log(`\n  ${body.secret}\n`);
  console.log(`  ${bold("Store it now")} — Fillo cannot show this secret again.`);
  console.log("  Keep it on your server: sign each respondent id with HMAC-SHA256 and pass");
  console.log("  the hash to identify(). Never ship it in client code.\n");
}

async function identityDisable(flags: Flags) {
  const json = jsonMode(flags);

  // Tier C: every verified-only form starts accepting unverified claims. The
  // target is the project slug; the server compares it too and 409s on a
  // mismatch, so a typed value is passed through rather than judged here.
  const confirm = await requireConfirm(flags, {
    tier: "C",
    resolveTarget: projectSlug,
    targetLabel: "the project slug",
    notice: "This stops verifying respondent IDs and destroys the signing secret.",
    refusal:
      "Refusing to disable identity verification without confirmation. Re-run with " +
      '--confirm "<project slug>" (the slug `fillo whoami` prints). A bare --confirm never substitutes.',
  });

  const body = await callApi<{ disabled?: boolean; code?: string }>(
    "/cli/project/identity",
    { method: "DELETE", body: JSON.stringify({ confirm }) },
    {
      // A 409 without `confirm_mismatch` means forms still require verification.
      fallback: failed("developers identity disable"),
      expect: (b) => b.disabled === true,
      on: (res, b) => {
        if (res.status === 409 && b.code === "confirm_mismatch") {
          die(b.error ?? "Pass --confirm with the project slug — nothing was changed.");
        }
      },
    },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Identity verification is off. Respondent IDs are now unverified.`);
  console.log(
    `  ${dim("Re-enabling mints a NEW secret — your servers must be updated to use it.")}`,
  );
}

async function identity(action: string | undefined, flags: Flags) {
  if (!action || action === "status") return identityStatus(flags);
  if (action === "enable") return identityEnable(flags);
  if (action === "disable") return identityDisable(flags);
  die(`Unknown identity command: ${terminalText(action)} (expected status, enable, or disable).`);
}

async function developers(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return developersHelp();
  if (subcommand === "policy") return policy(args[0], flags);
  if (subcommand === "origins") return origins(args[0], flags);
  if (subcommand === "identity") return identity(args[0], flags);
  die(
    `Unknown developers command: ${terminalText(subcommand)} (expected policy, origins, or identity).`,
  );
}

function developersHelp() {
  console.log(`
  ${boldRaw("fillo developers")} — code sync, allowed origins, and identity verification

  ${boldRaw("Commands")}
    developers policy ${POLICIES.join("|")}
                       Who may stage code-defined schemas for this project
                       ${dimRaw("--confirm   required for agents/pipes; the human agrees first")}
    developers origins [list]        Show the publishable key's allowed origins
    developers origins --set a,b     Replace the allow-list (bare https origins)
    developers origins --clear       Accept publishable-key syncs from any origin
                       ${dimRaw("--confirm   required for agents/pipes on --set and --clear")}
    developers identity status       Is verification on, and what depends on it
    developers identity enable       Turn it on — the secret prints once, store it
                       ${dimRaw("--confirm   required for agents/pipes")}
    developers identity disable      Turn it off — claims are unverified again
                       ${dimRaw('--confirm "<project slug>"   required (see `fillo whoami`); a bare --confirm never substitutes')}

  ${dimRaw("The identity secret is shown ONLY when it is created, here and in the")}
  ${dimRaw("dashboard. `identity status` never prints it and enabling twice never")}
  ${dimRaw("echoes it back — disable and re-enable to mint a new one.")}
  ${dimRaw("--json prints the raw server response on stdout, secret included at mint.")}
`);
}

export const developersCommand: Command = {
  name: "developers",
  aliases: ["dev"],
  flags: ["confirm", "set", "clear"],
  run: (args, flags) => developers(args[0], args.slice(1), flags),
  help: developersHelp,
};
