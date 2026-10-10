import test from "node:test";
import assert from "node:assert/strict";
import { isBuildTimeDevEnv, isLikelyDevEnv } from "../dist/index.js";

/** Run `fn` with NODE_ENV set (or deleted) and a stubbed browser window whose
 *  location reports `hostname` (undefined = SSR/Node, no window at all). */
function inEnv({ nodeEnv, hostname }, fn) {
  const prevEnv = process.env.NODE_ENV;
  const hadWindow = Object.hasOwn(globalThis, "window");
  const prevWindow = globalThis.window;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (hostname === undefined) delete globalThis.window;
  else globalThis.window = { location: { hostname } };
  try {
    return fn();
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
}

test("a development build is development regardless of hostname", () => {
  assert.equal(inEnv({ nodeEnv: "development", hostname: "myapp.com" }, isLikelyDevEnv), true);
  // An unset NODE_ENV (bundlers that never define it) also reads as dev.
  assert.equal(inEnv({ nodeEnv: undefined, hostname: "myapp.com" }, isLikelyDevEnv), true);
});

test("a production build on a local hostname still counts as development", () => {
  const local = [
    "localhost",
    "LOCALHOST",
    "myapp.localhost",
    "127.0.0.1",
    "127.10.20.30", // whole 127.0.0.0/8 loopback block
    "::1",
    "[::1]", // how location.hostname reports IPv6 loopback
    "0.0.0.0",
  ];
  for (const hostname of local) {
    assert.equal(inEnv({ nodeEnv: "production", hostname }, isLikelyDevEnv), true, hostname);
  }
});

test("a production build on real or private-LAN hostnames stays production", () => {
  const remote = [
    "myapp.com",
    "www.example.org",
    "fillo.so",
    // Private-LAN ranges are real deployments (kiosks, intranets) — NOT dev.
    "192.168.1.10",
    "10.0.0.5",
    // mDNS/Bonjour: every macOS host advertises <name>.local and intranet
    // kiosks resolve it — a real production surface, NOT dev.
    "myapp.local",
    "kiosk-frontdesk.local",
    // Lookalikes must not match the local patterns.
    "notlocalhost",
    "mylocalhost.com",
    "localhost.example.com",
    "127.0.0.1.nip.io",
    "local.example.com",
    "",
  ];
  for (const hostname of remote) {
    assert.equal(
      inEnv({ nodeEnv: "production", hostname }, isLikelyDevEnv),
      false,
      hostname || "(empty hostname)",
    );
  }
});

test("SSR without a window falls back to the NODE_ENV check alone", () => {
  assert.equal(inEnv({ nodeEnv: "production", hostname: undefined }, isLikelyDevEnv), false);
  assert.equal(inEnv({ nodeEnv: "development", hostname: undefined }, isLikelyDevEnv), true);
});

test("isBuildTimeDevEnv ignores the hostname — the SSR/hydration snapshot", () => {
  // Server HTML and the hydration pass must agree, so the build-time half
  // never widens on a local hostname the way isLikelyDevEnv does.
  assert.equal(inEnv({ nodeEnv: "production", hostname: "localhost" }, isBuildTimeDevEnv), false);
  assert.equal(inEnv({ nodeEnv: "production", hostname: "127.0.0.1" }, isBuildTimeDevEnv), false);
  assert.equal(inEnv({ nodeEnv: "development", hostname: "myapp.com" }, isBuildTimeDevEnv), true);
  // An unset NODE_ENV (bundlers that never define it) still reads as dev.
  assert.equal(inEnv({ nodeEnv: undefined, hostname: undefined }, isBuildTimeDevEnv), true);
});
