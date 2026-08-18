import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * RFC 8252 loopback + PKCE plumbing for a same-machine `fillo login`. Kept to
 * node built-ins only so the derivation and router are unit-testable in isolation.
 */

/** PKCE (S256): a random verifier and base64url(sha256(verifier)) challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Anti-forgery state echoed through the browser and re-checked on the loopback. */
export function randomState(): string {
  return randomBytes(32).toString("base64url");
}

export type LoginMode = "loopback" | "headless";

/**
 * Which login lane to run. Loopback is the same-machine interactive lane: a
 * human at a real terminal with a browser and no agent handoff. Everything else
 * takes the device-code fallback so nobody waits on a 127.0.0.1 callback that
 * can't arrive: an agent/pipe (agentMode), an explicit `--headless`/`--device`,
 * a `--run/--token` agent handoff, or an SSH session — where the browser opens
 * on the user's *local* machine and its loopback redirect can never reach the
 * listener on the *remote* box. (VS Code Remote forwards ports and would
 * technically work, but it still sets the SSH vars; device-code is the safe,
 * always-correct choice for the ambiguous remote case.)
 */
export function chooseLoginMode(opts: {
  agent: boolean;
  headless: boolean;
  handoff: boolean;
  ssh: boolean;
}): LoginMode {
  return opts.agent || opts.headless || opts.handoff || opts.ssh ? "headless" : "loopback";
}

/** True in an interactive SSH session (sshd sets these). The loopback lane's
 *  127.0.0.1 callback can't cross from the user's local browser to the remote
 *  shell, so these sessions must take the device-code flow. */
export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT);
}

function resultPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fillo CLI</title></head><body style="font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#0b0b0f;color:#e7e7ea"><main style="text-align:center;padding:2rem;max-width:26rem"><p style="font-weight:600">${message}</p></main></body></html>`;
}

export type LoopbackServer = {
  /** The ephemeral 127.0.0.1 port the browser will be redirected back to. */
  port: number;
  /** Resolve with the authorization code once the browser hits /callback with a
   *  matching state; reject on a state mismatch or after timeoutMs. */
  waitForCode(state: string, timeoutMs: number): Promise<string>;
  close(): void;
};

/**
 * Bind an http listener on 127.0.0.1:0 (loopback only, ephemeral port) that
 * serves exactly one authorization callback. A bind failure rejects so the
 * caller can fall back to the device-code flow.
 */
export async function startLoopbackServer(): Promise<LoopbackServer> {
  let expectedState: string | null = null;
  let handler: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null;
  let served = false;

  const server = createServer((req, res) => {
    const respond = (status: number, message: string) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(resultPage(message));
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      respond(400, "Invalid request.");
      return;
    }
    // Ignore anything but the callback (favicon probes, reloads after success)
    // so they can't consume the one real handshake or trip the state check.
    if (url.pathname !== "/callback" || served) {
      respond(served ? 200 : 404, "You can close this tab and return to your terminal.");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || expectedState === null || state !== expectedState) {
      served = true;
      respond(400, "This login could not be verified. Return to your terminal and run fillo login again.");
      handler?.reject(new Error("state mismatch on loopback callback"));
      return;
    }
    served = true;
    respond(200, "You can close this tab and return to your terminal.");
    handler?.resolve(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  const close = () => {
    try {
      server.close();
    } catch {
      /* already closing */
    }
  };

  const waitForCode = (state: string, timeoutMs: number): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      expectedState = state;
      const timer = setTimeout(() => {
        handler = null;
        close();
        reject(new Error("timed out waiting for browser approval"));
      }, timeoutMs);
      handler = {
        resolve: (code) => {
          clearTimeout(timer);
          close();
          resolve(code);
        },
        reject: (err) => {
          clearTimeout(timer);
          close();
          reject(err);
        },
      };
    });

  return { port, waitForCode, close };
}

/** Open a real web URL in the OS browser. Best-effort and never throws: a
 *  missing opener (headless Linux/CI/WSL) or CI just leaves the printed URL. */
export function openBrowser(url: string): void {
  let safeUrl: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    safeUrl = parsed.toString();
  } catch {
    return;
  }
  // CI and test runners cannot complete a local browser handoff. The printed
  // approval URL remains available for a human to open elsewhere.
  if (process.env.CI === "true") return;
  try {
    // A missing opener (ENOENT on headless Linux/CI/WSL) fires 'error' async —
    // the try/catch can't see it, so swallow it on the child or Node crashes.
    if (process.platform === "win32") {
      // No shell: the empty "" title keeps `start` from reading the URL as a
      // window title, and avoids cmd.exe metacharacter injection on the URL.
      const child = spawn("cmd", ["/c", "start", "", safeUrl], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } else {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(cmd, [safeUrl], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    /* the printed URL is the fallback */
  }
}
