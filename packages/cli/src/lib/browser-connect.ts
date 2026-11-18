import { agentMode, emitProgress, emitResult, terminalText } from "./output.js";

/**
 * The browser-OAuth-then-poll flow shared by `storage connect drive|box` and
 * `slack connect`. Connecting these providers must happen in the human's
 * already-signed-in browser (the OAuth session lives there), so the CLI never
 * opens a browser: it prints the start URL, then polls a `fcli_` status
 * endpoint until the provider flips connected. Agent mode adds the "don't loop"
 * relay line; --json emits progress on stderr and one final object on stdout.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FILLO_POLL_INTERVAL_MS overrides the cadence (tests, impatient humans). */
function pollIntervalMs(fallback: number): number {
  const raw = process.env.FILLO_POLL_INTERVAL_MS;
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export type BrowserConnectOptions = {
  json: boolean;
  /** Human label, e.g. "Google Drive". */
  what: string;
  /** OAuth start URL to open in the signed-in browser. */
  startUrl: string;
  /** One poll: resolve true once the provider is connected. Transient network
   *  errors should reject; they are swallowed and retried until the deadline. */
  poll: () => Promise<boolean>;
  /** Build the success output once connected. */
  onConnected: () => { result: Record<string, unknown>; lines: string[] };
  intervalMs?: number;
  timeoutMs?: number;
};

/**
 * Print the URL, wait for the connection, then emit success — or time out and
 * exit non-zero. Never returns on timeout (calls process.exit(1)).
 */
export async function connectViaBrowser(opts: BrowserConnectOptions): Promise<void> {
  const interval = pollIntervalMs(opts.intervalMs ?? 5000);
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const dots = !opts.json && !agentMode();

  if (opts.json) {
    emitProgress({
      status: "awaiting_connect",
      provider: opts.what,
      url: opts.startUrl,
      note: "Open the URL in your signed-in browser; this command waits. Do not retry in a loop.",
    });
  } else {
    console.log(`\n  Connect ${terminalText(opts.what)} in your signed-in browser:\n`);
    console.log(`  ${terminalText(opts.startUrl)}\n`);
    console.log("  Open in your signed-in browser and approve access — this command waits.");
    if (agentMode()) {
      console.log(
        "  Do not retry in a loop; ask the human to complete the browser step. This command waits.",
      );
    }
  }
  if (dots) process.stdout.write("  Waiting for the connection");

  for (;;) {
    let connected = false;
    try {
      connected = await opts.poll();
    } catch {
      // Transient — keep polling until the deadline.
    }
    if (connected) {
      const { result, lines } = opts.onConnected();
      if (opts.json) {
        emitProgress({ status: "connected" });
        emitResult(result);
        return;
      }
      if (dots) process.stdout.write("\n");
      for (const line of lines) console.log(line);
      return;
    }
    if (Date.now() >= deadline) break;
    if (dots) process.stdout.write(".");
    await sleep(interval);
  }

  if (opts.json) {
    emitResult({ connected: false, error: "timeout" });
    process.exit(1);
  }
  if (dots) process.stdout.write("\n");
  console.log(
    `  Timed out waiting for ${terminalText(opts.what)} to connect. ` +
      "Finish the browser step, then re-run this command.",
  );
  process.exit(1);
}
