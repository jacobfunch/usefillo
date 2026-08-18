import type { Flags } from "./flags.js";

/** Strip terminal control characters from server/file/argv text before print. */
export function terminalText(value: string): string {
  return value
    .replace(/\b(?:fcli|fsync)_[A-Za-z0-9._~-]+\b/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Agent mode: the CLI is being driven by a coding agent or a pipe, not a human
 * at a terminal. No ANSI, no spinners, and never auto-open a browser — print
 * the URL instead so the agent can relay it to the human.
 */
export function agentMode(): boolean {
  return process.env.FILLO_AGENT === "1" || !process.stdout.isTTY;
}

/**
 * Whether we may show an interactive confirmation to a human at the terminal.
 * FILLO_AGENT and pipes/redirects (no TTY) both return false: agents and
 * automation must pass values as explicit flags, never be prompted. FILLO_TTY=1
 * is a test-only seam that forces the interactive path on under a piped stdin;
 * FILLO_AGENT still wins over it, so it can never re-enable prompting for an
 * agent run.
 */
export function isInteractive(): boolean {
  if (process.env.FILLO_AGENT === "1") return false;
  if (process.env.FILLO_TTY === "1") return true;
  return Boolean(process.stdout.isTTY);
}

let jsonOutput = false;

/** Flip the whole process into machine-readable output. Called once from main
 *  when --json is present, before any command (or flag validation) can print. */
export function enableJsonOutput(): void {
  jsonOutput = true;
}

/** Per-command check for the --json convention. A pure flag read: commands
 *  without machine output (agent, skill, test-response) never consult it and
 *  keep human output, even though the global switch still strips ANSI. */
export function jsonMode(flags: Flags): boolean {
  return flags.json === true;
}

/**
 * --json convention: progress/info lines are one JSON object per line on
 * stderr ({"status": ...} shape); stdout stays reserved for the single final
 * result object. No-op outside --json so waypoints can emit unconditionally.
 */
export function emitProgress(event: Record<string, unknown>): void {
  if (!jsonOutput) return;
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/** The final machine-readable result: exactly one JSON document on stdout. */
export function emitResult(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Whether ANSI styling is allowed: never under --json or in agent mode. */
export const ansiEnabled = () => !jsonOutput && !agentMode();

export const bold = (s: string) =>
  ansiEnabled() ? `\x1b[1m${terminalText(s)}\x1b[0m` : terminalText(s);
export const dim = (s: string) =>
  ansiEnabled() ? `\x1b[2m${terminalText(s)}\x1b[0m` : terminalText(s);

/**
 * ANSI styling for TRUSTED, author-written LAYOUT text — help screens and fixed
 * labels whose exact spacing carries meaning (aligned columns, indented
 * continuation lines). Unlike bold/dim these do NOT pass through terminalText,
 * so multi-space alignment survives instead of collapsing to single spaces and
 * whitespace-only continuation lines keep their indent instead of snapping to
 * the left margin (where they misread as standalone flags).
 *
 * Use ONLY on string literals written in this source. NEVER pass server, argv,
 * config, or respondent text here — those go through bold/dim (or terminalText),
 * which strip control characters and collapse whitespace.
 */
export const boldRaw = (s: string) => (ansiEnabled() ? `\x1b[1m${s}\x1b[0m` : s);
export const dimRaw = (s: string) => (ansiEnabled() ? `\x1b[2m${s}\x1b[0m` : s);

/**
 * The strongest warning style — bold plus the same red as the ✗ fail mark — for
 * the single line a reader must not miss (e.g. minting a key that holds
 * irreversible :delete scopes). terminalText-sanitized like bold/dim, since the
 * text it wraps can interpolate server-derived values (the granted scopes).
 */
export const danger = (s: string) =>
  ansiEnabled() ? `\x1b[1;31m${terminalText(s)}\x1b[0m` : terminalText(s);

/** Leading success/failure marks — green/red only when a human TTY is watching. */
export const okMark = () => (ansiEnabled() ? "\x1b[32m✓\x1b[0m" : "✓");
export const failMark = () => (ansiEnabled() ? "\x1b[31m✗\x1b[0m" : "✗");

/**
 * Fixed-width table in the CLI's house style: two-space indent, every column
 * padded to its widest cell, and a PLAIN (unstyled) header — bold/dim collapse
 * whitespace via terminalText and would break the padding. Cells are printed
 * verbatim, so callers sanitize server/respondent text with terminalText first.
 */
export function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((cells) => (cells[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ")}`;
  console.log(line(header));
  for (const cells of rows) console.log(line(cells));
}

export function die(msg: string): never {
  // In --json mode the contract is "stdout parses as one JSON document", even
  // on failure — emit the stable {error} shape there, human text on stderr.
  if (jsonOutput) emitResult({ error: terminalText(msg) });
  console.error(`${failMark()} ${terminalText(msg)}`);
  process.exit(1);
}
