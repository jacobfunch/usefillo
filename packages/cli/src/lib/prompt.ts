import { type Interface, createInterface } from "node:readline";

/**
 * Interactive prompts for a human at the terminal. Destructive commands and
 * `storage connect s3` reach these only when NOT in --json/agent mode — an
 * agent or pipe is required to pass the value as a flag instead, so these
 * paths never run unattended.
 *
 * All visible prompts share ONE readline interface with an explicit line
 * queue. Two piped-stdin failure modes forced this shape (both found live in
 * `init`'s decline-then-ask flow): a per-question interface discards whatever
 * the pipe delivered beyond the first answer, and even a shared interface
 * drops lines that arrive BETWEEN questions (readline emits them with no
 * pending asker). Queued lines are served to later prompts in order; EOF only
 * answers a prompt when nothing is queued. The dispatcher calls closePrompts()
 * when the command finishes so the open interface never holds the process
 * alive.
 */

type PromptAnswer = { line: string } | { eof: true };

let shared: Interface | null = null;
let sharedClosed = false;
/** Lines that arrived while no prompt was pending — a fast pipe delivers the
 *  whole heredoc up front. Served to later prompts in order. */
const lineQueue: string[] = [];
let pending: ((answer: PromptAnswer) => void) | null = null;

function promptInterface(): Interface | null {
  if (sharedClosed) return null;
  if (!shared) {
    shared = createInterface({ input: process.stdin, output: process.stdout });
    shared.on("line", (line) => {
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ line });
      } else {
        lineQueue.push(line);
      }
    });
    // Ctrl-C at ANY prompt aborts the whole command, immediately. Without this
    // listener readline just closes the interface, which reads as EOF — and an
    // OPTIONAL prompt treats EOF as "skipped", so the command would continue
    // and e.g. provision a workspace the user was trying to escape (found live
    // by the founder). 130 = 128 + SIGINT, the shell convention.
    shared.on("SIGINT", () => {
      process.stdout.write("\n");
      process.exit(130);
    });
    // EOF: readline flushes remaining complete lines before close, so anything
    // queued stays servable; only a prompt with nothing queued resolves EOF.
    shared.on("close", () => {
      sharedClosed = true;
      shared = null;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ eof: true });
      }
    });
  }
  return shared;
}

/** Release stdin at command end so a finished CLI process can exit. */
export function closePrompts(): void {
  sharedClosed = true;
  shared?.close();
  shared = null;
}

/** One prompt: serve the next line — from the queue when a pipe raced ahead,
 *  else from the next entered line; EOF when neither can ever answer. The live
 *  path hands the prompt text to READLINE (setPrompt/prompt), never raw
 *  stdout: readline's line editing is anchored to its own prompt, and a
 *  manually printed one sits outside that math — backspace then redraws over
 *  the question and visibly eats it (found live by the founder). */
function ask(promptText: string): Promise<PromptAnswer> {
  const queued = lineQueue.shift();
  if (queued !== undefined) {
    process.stdout.write(`${promptText}\n`);
    return Promise.resolve({ line: queued });
  }
  const rl = promptInterface();
  if (!rl) return Promise.resolve({ eof: true });
  rl.setPrompt(promptText);
  rl.prompt();
  return new Promise((resolve) => {
    pending = (answer) => {
      // Stop a later stray redraw from re-printing this question.
      rl.setPrompt("");
      resolve(answer);
    };
  });
}

/** Pause/resume the shared interface around raw-mode input. While readSecret
 *  owns stdin in raw mode, a live readline interface would still process and
 *  ECHO keypresses — leaking the secret to the screen. */
export function suspendPrompts(): void {
  shared?.pause();
}

export function resumePrompts(): void {
  shared?.resume();
}

/** Read one line of visible input (used for typed-name delete confirmations
 *  and non-secret S3 fields). Resolves the trimmed answer; "" for a blank
 *  Enter AND for EOF, so absent input always fails closed at the caller. */
export async function readLine(promptText: string): Promise<string> {
  const answer = await ask(promptText);
  return "eof" in answer ? "" : answer.line.trim();
}

/**
 * A `[Y/n]` confirmation for a human at the terminal. Enter or y/yes accepts;
 * anything else typed declines. EOF — no line can ever arrive — FAILS CLOSED
 * (declines), so an unattended run that slipped past the interactivity gate
 * can never be read as a silent "yes".
 */
export async function confirmYes(promptText: string): Promise<boolean> {
  const answer = await ask(`${promptText} [Y/n] `);
  if ("eof" in answer) return false;
  const a = answer.line.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

// Control bytes handled by the masked reader (built from char codes so no raw
// control characters live in the source).
const ENTER = new Set(["\r", "\n"]);
const EOT = String.fromCharCode(4); // Ctrl-D
const ETX = String.fromCharCode(3); // Ctrl-C
const DEL = String.fromCharCode(127); // backspace on many terminals
const BACKSPACE = "\b";

/**
 * Read a secret without echoing it, using raw mode so the key material never
 * lands on screen or in scrollback. Only invoked on a real TTY (the caller
 * dies with the flag/env name to use when there is no interactive terminal),
 * so a missing setRawMode simply means we are not in a spot that prompts.
 */
export function readSecret(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (typeof input.setRawMode !== "function") {
      reject(new Error("No interactive terminal to read a secret from."));
      return;
    }
    suspendPrompts();
    process.stdout.write(promptText);
    let value = "";
    const cleanup = () => {
      input.setRawMode?.(false);
      input.pause();
      input.removeListener("data", onData);
      resumePrompts();
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ENTER.has(ch) || ch === EOT) {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === ETX) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("aborted"));
          return;
        }
        if (ch === DEL || ch === BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        // Keep only printable input; drop stray control bytes.
        if (ch >= " ") value += ch;
      }
    };
    input.resume();
    input.setRawMode(true);
    input.on("data", onData);
  });
}
