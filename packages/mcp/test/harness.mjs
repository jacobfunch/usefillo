import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * A mock Fillo HTTP API. `handler(req, body)` returns `{ status, json }` (or
 * `{ status, text }`). Every request is recorded so tests can assert the
 * injected `X-Fillo-Client` header, the auth mode, and the request body.
 */
export async function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? safeJson(raw) : undefined;
      requests.push({
        method: req.method,
        url: req.url,
        client: req.headers["x-fillo-client"],
        auth: req.headers["authorization"],
        contentType: req.headers["content-type"],
        body,
        raw,
      });
      const out = handler({ method: req.method, url: req.url, body }) ?? { status: 404, json: { error: "not found" } };
      res.statusCode = out.status;
      if (out.text !== undefined) {
        res.setHeader("content-type", "text/markdown");
        res.end(out.text);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.json ?? {}));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A fresh temp config dir; optionally seed it with a config.json. */
export function tempConfigDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "fillo-mcp-test-"));
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

/**
 * Spawn the built server against `origin`, complete the MCP handshake, and
 * return a minimal newline-delimited JSON-RPC client. `env` overlays the child
 * environment (FILLO_TOKEN / FILLO_PK / FILLO_API_KEY / FILLO_CONFIG_DIR, …).
 */
export async function startServer(origin, env = {}) {
  const child = spawn("node", [SERVER], {
    env: { ...process.env, FILLO_API: origin, FILLO_CONFIG_DIR: env.FILLO_CONFIG_DIR ?? tempConfigDir(), ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });

  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let id = 0;
  const rpc = (method, params) => {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 10_000);
      pending.set(msgId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params })}\n`);
    });
  };
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  notify("notifications/initialized", {});

  const listTools = async () => (await rpc("tools/list", {})).result.tools;

  const callTool = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    if (res.error) return { error: res.error };
    const content = res.result.content ?? [];
    const text = content.map((c) => c.text).join("\n");
    let data;
    for (const c of content) {
      if (c.type !== "text") continue;
      try {
        data = JSON.parse(c.text);
      } catch {
        /* not the JSON item */
      }
    }
    return { isError: !!res.result.isError, text, data };
  };

  return {
    init,
    rpc,
    notify,
    listTools,
    callTool,
    close: () => child.kill(),
  };
}
