import { confirmFlag, type Flags } from "./flags.js";
import { die, emitProgress, isInteractive, jsonMode, terminalText } from "./output.js";
import { confirmYes, readLine } from "./prompt.js";

/**
 * The CLI half of the human layer (docs/engineering/agent-parity.md).
 *
 * Every command that performs an outward (Tier B) or destructive (Tier C)
 * action calls `requireConfirm` before its write. This is the ONLY place the
 * rule is implemented — `fillo delete` keeps its own older copy of it, and
 * nothing else may fork it:
 *
 *   Tier B — reaches beyond the workspace (publish, unpublish, release held
 *   responses, enable an integration, change a member's role, …).
 *     • Human at a TTY: the consequences are printed and the command runs
 *       (`ttyIsConsent`) or a [Y/n] prompt asks — the human is the yes either
 *       way. `--confirm` takes no value here; a value means a positional was
 *       swallowed, which is named rather than read as agreement.
 *     • Agent mode (--json or FILLO_AGENT=1) or any non-interactive caller:
 *       refused unless a bare `--confirm` is present. The skill tells the
 *       agent to ask its human before passing it.
 *
 *   Tier C — irreversible or credential-revoking (delete, remove, revoke,
 *   disconnect). The confirmation is TYPED: `--confirm "<exact target>"`.
 *     • Human at a TTY: prompted to type the target's exact name/id.
 *     • Agent mode / non-interactive: `--confirm "<target>"` is mandatory and
 *       must match exactly. A bare `--confirm` and `--yes` never substitute —
 *       there is no confirmation-free destructive command.
 *
 * In both tiers a consent notice naming the effect is printed BEFORE the
 * write. A command that ships its own wording passes `notice`, which prints on
 * stdout for a human and as one `{"status":"notice"}` progress line under
 * --json so stdout stays a single result document; a command that has none
 * passes `describe` and the helper composes the line. The server enforces its
 * own typed match for Tier C, so the local check is UX.
 *
 * Usage:
 *   const confirm = await requireConfirm(flags, {
 *     tier: "C",
 *     target: form.name,                 // or resolveTarget: async () => …
 *     describe: `permanently deletes the form "${form.name}"`,
 *   });
 *   // Tier C resolves to the typed target string (send it as the body's
 *   // `confirm`); Tier B resolves to true.
 *
 * Flag placement: `--confirm` takes an optional value, so a bare Tier B
 * `--confirm` followed by a positional would swallow it. Put `--confirm`
 * last, or write `--confirm=` explicitly (help text for each command says so).
 */

export type ConfirmTier = "B" | "C";

interface ConfirmGate {
  tier: ConfirmTier;
  /** Tier C: the exact string the human must type / pass. Set it ONLY when the
   *  CLI can judge the match locally. Leave it out when the server verifies the
   *  typed value — the flag then passes through verbatim and the server's own
   *  mismatch message is what the caller sees. */
  target?: string;
  /** Tier C: resolve the prompt's target lazily (a network read) only when the
   *  human will be prompted, so agent-mode refusals stay offline. Unlike
   *  `target` it never judges a typed flag locally. */
  resolveTarget?: () => Promise<string>;
  /** What the flag should name in composed refusals ("the form's exact title"). */
  targetLabel?: string;
  /** The command's own refusal, for the few whose exact wording is load-bearing.
   *  In Tier C it answers both a missing flag and a bare one, because the
   *  remedy — type the target — is the same. */
  refusal?: string;
  /** Print the consent notice before the gate decides, so a refusal carries it
   *  too. Default: the notice prints only when the action proceeds, because the
   *  composed refusal already repeats what is at stake. */
  noticeFirst?: boolean;
  /** Tier B: a human at a TTY IS the yes, so run without a [Y/n] prompt — the
   *  way `fillo unpublish` and `fillo sheets enable` do. Without it the human
   *  is asked to confirm. */
  ttyIsConsent?: boolean;
  /** The command as it should be re-run, quoted in the "takes no value" error
   *  and the composed refusal: "fillo sheets enable contact". */
  command?: string;
}

/** Either give the helper one clause to compose the copy from, or give it the
 *  command's own consent line. Never a clause that nothing prints. */
type ConfirmCopy = { describe: string; notice?: string } | { describe?: undefined; notice: string };

export type ConfirmOptions = ConfirmGate & ConfirmCopy;

/**
 * Interactive prompting is refused for agents/JSON and non-TTY callers.
 *
 * Exported for `fillo delete` alone, which keeps its own older copy of the
 * typed-confirmation flow (its refusal wording and its name lookup predate this
 * helper) but must not keep its own idea of who can be prompted: a pipeline
 * with no terminal has to be told to pass --confirm, not handed a prompt that
 * reads whatever happens to be on stdin. Any other command that reaches for
 * this is about to fork a gate — call `requireConfirm` instead.
 */
export function promptsBlocked(flags: Flags): boolean {
  return jsonMode(flags) || !isInteractive();
}

/** The consent sentence in prose: the command's own wording, or one composed
 *  from its clause. */
function consentLine(opts: ConfirmOptions): string {
  return opts.notice ?? `This ${terminalText(opts.describe ?? "")}.`;
}

/** `: \`fillo sheets enable contact --confirm\`` — the exact re-run, when the
 *  command named itself. */
function rerunHint(opts: ConfirmOptions): string {
  return opts.command ? `: \`${opts.command} --confirm\`` : "";
}

function emitNotice(flags: Flags, tier: ConfirmTier, opts: ConfirmOptions): void {
  if (opts.notice !== undefined) {
    // Call sites sanitize the values they interpolate, so the line prints as
    // written: stdout for a human, one stderr JSON line under --json.
    if (jsonMode(flags)) emitProgress({ status: "notice", notice: opts.notice });
    else console.log(`  ${opts.notice}`);
    return;
  }
  if (jsonMode(flags)) {
    emitProgress({ status: "consent", tier, action: terminalText(opts.describe ?? "") });
    return;
  }
  console.error(
    `  ${tier === "C" ? "This cannot be undone:" : "Heads up:"} this ${terminalText(opts.describe ?? "")}.`,
  );
}

/**
 * Gate one outward or destructive write behind the human layer. Resolves to
 * `true` (Tier B) or the confirmed target string (Tier C); every refusal or
 * decline exits the process through `die`, so callers never see a falsy value.
 * The tier picks the return type, so a Tier C caller can send the result
 * straight on as the request body's `confirm` without a cast.
 */
export async function requireConfirm(
  flags: Flags,
  opts: ConfirmOptions & { tier: "B" },
): Promise<true>;
export async function requireConfirm(
  flags: Flags,
  opts: ConfirmOptions & { tier: "C" },
): Promise<string>;
export async function requireConfirm(flags: Flags, opts: ConfirmOptions): Promise<string | true> {
  const flag = confirmFlag(flags);
  let noticed = false;
  const printNotice = (): void => {
    if (noticed) return;
    emitNotice(flags, opts.tier, opts);
    noticed = true;
  };

  if (opts.tier === "B") {
    // A bare flag is the whole Tier B contract. A value means a positional was
    // swallowed (`--confirm yes`), so name it rather than read it as consent.
    if (flag.kind === "typed") {
      die(`--confirm takes no value here — pass it bare${rerunHint(opts)}.`);
    }
    if (opts.noticeFirst) printNotice();
    if (flag.kind === "bare") {
      printNotice();
      return true;
    }
    if (promptsBlocked(flags)) {
      die(
        opts.refusal ??
          `Refusing without confirmation. ${consentLine(opts)} ` +
            `Ask the human first, then re-run with --confirm${rerunHint(opts)}.`,
      );
    }
    printNotice();
    if (opts.ttyIsConsent) return true;
    if (!(await confirmYes("  Continue?"))) die("Cancelled — nothing changed.");
    return true;
  }

  // Tier C: typed target.
  const label = opts.targetLabel ?? "the exact name";
  if (opts.noticeFirst) printNotice();
  if (flag.kind === "typed") {
    if (opts.target !== undefined && flag.value !== opts.target) {
      die(
        `That does not match "${terminalText(opts.target)}" — nothing changed. Re-run with --confirm "${terminalText(opts.target)}".`,
      );
    }
    printNotice();
    return flag.value;
  }
  if (flag.kind === "bare") {
    die(
      opts.refusal ??
        `--confirm needs a value here: --confirm "<${label}>". ${consentLine(opts)} It cannot be undone.`,
    );
  }
  if (promptsBlocked(flags)) {
    die(
      opts.refusal ??
        `Refusing without typed confirmation: this ${terminalText(opts.describe ?? "")} and cannot be undone. ` +
          `Re-run with --confirm "<${label}>" after confirming with the person you are working for. --yes never skips this.`,
    );
  }
  const target = opts.target ?? (opts.resolveTarget ? await opts.resolveTarget() : undefined);
  if (target === undefined) die("Internal: Tier C confirmation needs a target.");
  printNotice();
  const typed = await readLine(`  Type ${terminalText(target)} to confirm: `);
  if (typed !== target) die(`That does not match "${terminalText(target)}" — nothing changed.`);
  return target;
}
