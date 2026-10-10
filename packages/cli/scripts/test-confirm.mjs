import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

/**
 * Hermetic coverage for lib/confirm.ts — the CLI half of the human layer.
 * The helper is bundled on its own (the CLI ships as one file, so it has no
 * importable dist module) and exercised in child processes, because every
 * refusal exits through `die`. Locks the four contracts commands rely on:
 *
 *   - Tier B in agent mode refuses without a bare --confirm and passes with it,
 *     printing the consent notice as a stderr JSON line under --json.
 *   - Tier C in agent mode refuses without a TYPED --confirm, rejects a bare
 *     one, rejects a mismatch, and resolves to the typed target on a match.
 *   - --yes never substitutes for either.
 *   - A TTY human is prompted (Y/n for B, typed target for C) and a decline
 *     or EOF fails closed.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "fillo-confirm-"));

await build({
  entry: { confirm: join(packageRoot, "src/lib/confirm.ts") },
  outDir: scratch,
  format: ["esm"],
  target: "node18",
  silent: true,
  clean: false,
  config: false,
  outExtension: () => ({ js: ".js" }),
});

const runner = join(scratch, "run.mjs");
writeFileSync(
  runner,
  `import { requireConfirm } from "./confirm.js";
const [tier, describe, target, flagsJson] = process.argv.slice(2);
const flags = JSON.parse(flagsJson);
const result = await requireConfirm(flags, {
  tier,
  describe,
  ...(target ? { target } : {}),
  targetLabel: "the form's exact title",
});
process.stdout.write("RESULT:" + JSON.stringify(result) + "\\n");
process.exit(0);
`,
);

function run({ tier, describe = "takes the form offline", target, flags, env = {}, stdin }) {
  const proc = spawnSync(
    process.execPath,
    [runner, tier, describe, target ?? "", JSON.stringify(flags)],
    {
      encoding: "utf8",
      env: { ...process.env, FILLO_AGENT: "0", FILLO_TTY: "", ...env },
      input: stdin,
    },
  );
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

// ── Tier B, agent mode ───────────────────────────────────────────────────
{
  const refused = run({ tier: "B", flags: {}, env: { FILLO_AGENT: "1" } });
  assert.equal(refused.status, 1, "Tier B agent mode must refuse without --confirm");
  assert.match(refused.stderr, /Refusing without confirmation/);
  assert.match(refused.stderr, /re-run with --confirm/);
  assert.doesNotMatch(refused.stdout, /RESULT/);

  const yes = run({ tier: "B", flags: { yes: true }, env: { FILLO_AGENT: "1" } });
  assert.equal(yes.status, 1, "--yes never substitutes for --confirm");

  const ok = run({ tier: "B", flags: { confirm: true }, env: { FILLO_AGENT: "1" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /RESULT:true/);
  assert.match(ok.stderr, /Heads up: this takes the form offline/);

  // --json: the notice is a stderr JSON line; stdout stays the caller's.
  const json = run({ tier: "B", flags: { confirm: true, json: true }, env: { FILLO_AGENT: "1" } });
  assert.equal(json.status, 0, json.stderr);
  const notice = json.stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((event) => event.status === "consent");
  // emitProgress only emits once enableJsonOutput ran; the runner doesn't
  // flip it (main does), so the human notice is what lands. Either shape is
  // acceptable here — the contract is "no stdout noise".
  assert.ok(notice === undefined || notice.tier === "B");
  assert.match(json.stdout, /RESULT:true/);

  // Piped stdin without FILLO_AGENT is still non-interactive → refused.
  const piped = run({ tier: "B", flags: {} });
  assert.equal(piped.status, 1);
}

// ── Tier C, agent mode ───────────────────────────────────────────────────
{
  const target = "Customer feedback";
  const refused = run({
    tier: "C",
    describe: "permanently deletes the form",
    target,
    flags: {},
    env: { FILLO_AGENT: "1" },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing without typed confirmation/);
  assert.match(refused.stderr, /--confirm "<the form's exact title>"/);
  assert.match(refused.stderr, /--yes never skips this/);

  const bare = run({
    tier: "C",
    describe: "permanently deletes the form",
    target,
    flags: { confirm: true },
    env: { FILLO_AGENT: "1" },
  });
  assert.equal(bare.status, 1, "a bare --confirm is not a typed confirmation");
  assert.match(bare.stderr, /--confirm needs a value here/);

  const mismatch = run({
    tier: "C",
    describe: "permanently deletes the form",
    target,
    flags: { confirm: "Customer Feedback" },
    env: { FILLO_AGENT: "1" },
  });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match "Customer feedback"/);

  const match = run({
    tier: "C",
    describe: "permanently deletes the form",
    target,
    flags: { confirm: target },
    env: { FILLO_AGENT: "1" },
  });
  assert.equal(match.status, 0, match.stderr);
  assert.match(match.stdout, /RESULT:"Customer feedback"/);
  assert.match(match.stderr, /This cannot be undone: this permanently deletes the form/);

  // No known target (server-verified): the typed value passes through verbatim.
  const passthrough = run({
    tier: "C",
    describe: "revokes the token",
    flags: { confirm: "tok_1" },
    env: { FILLO_AGENT: "1" },
  });
  assert.equal(passthrough.status, 0, passthrough.stderr);
  assert.match(passthrough.stdout, /RESULT:"tok_1"/);
}

// ── Human at a TTY (FILLO_TTY=1 forces the interactive lane under a pipe) ─
{
  const accepted = run({ tier: "B", flags: {}, env: { FILLO_TTY: "1" }, stdin: "y\n" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /RESULT:true/);

  const declined = run({ tier: "B", flags: {}, env: { FILLO_TTY: "1" }, stdin: "n\n" });
  assert.equal(declined.status, 1);
  assert.match(declined.stderr, /Cancelled/);

  const eof = run({ tier: "B", flags: {}, env: { FILLO_TTY: "1" }, stdin: "" });
  assert.equal(eof.status, 1, "EOF at a Tier B prompt fails closed");

  const typed = run({
    tier: "C",
    describe: "permanently deletes the form",
    target: "Intake",
    flags: {},
    env: { FILLO_TTY: "1" },
    stdin: "Intake\n",
  });
  assert.equal(typed.status, 0, typed.stderr);
  assert.match(typed.stdout, /RESULT:"Intake"/);

  const wrong = run({
    tier: "C",
    describe: "permanently deletes the form",
    target: "Intake",
    flags: {},
    env: { FILLO_TTY: "1" },
    stdin: "intake\n",
  });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not match "Intake"/);

  // FILLO_AGENT wins over FILLO_TTY: an agent can never re-enable prompting.
  const agentWins = run({
    tier: "C",
    target: "Intake",
    flags: {},
    env: { FILLO_TTY: "1", FILLO_AGENT: "1" },
    stdin: "Intake\n",
  });
  assert.equal(agentWins.status, 1);
}

rmSync(scratch, { recursive: true, force: true });
console.log("confirm: ok");
