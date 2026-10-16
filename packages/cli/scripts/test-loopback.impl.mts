import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get } from "node:http";
import {
  browserCommand,
  chooseLoginMode,
  generatePkce,
  isSshSession,
  randomState,
  startLoopbackServer,
} from "../src/lib/loopback.ts";

/**
 * The CLI half of the loopback + PKCE lane: the code the shipped binary runs to
 * derive a PKCE pair, choose the login lane, and catch the state-checked code on
 * 127.0.0.1. Imported straight from source via Node type stripping.
 */

// 1. PKCE derivation: challenge === base64url(sha256(verifier)), both base64url.
for (let i = 0; i < 50; i++) {
  const { verifier, challenge } = generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/, "verifier is base64url");
  assert.match(challenge, /^[A-Za-z0-9_-]+$/, "challenge is base64url");
  assert.equal(verifier.length, 43, "32 random bytes → 43 base64url chars");
  assert.equal(
    challenge,
    createHash("sha256").update(verifier).digest("base64url"),
    "challenge is the S256 of the verifier",
  );
}
assert.notEqual(generatePkce().verifier, generatePkce().verifier, "verifiers are random");

// 2. Login router: loopback only for a same-machine interactive human; agents,
//    --headless/--device, --run/--token handoffs, and SSH sessions fall to the
//    device flow.
assert.equal(
  chooseLoginMode({ agent: false, headless: false, handoff: false, ssh: false }),
  "loopback",
);
assert.equal(
  chooseLoginMode({ agent: true, headless: false, handoff: false, ssh: false }),
  "headless",
);
assert.equal(
  chooseLoginMode({ agent: false, headless: true, handoff: false, ssh: false }),
  "headless",
);
assert.equal(
  chooseLoginMode({ agent: false, headless: false, handoff: true, ssh: false }),
  "headless",
);
// SSH alone forces the device flow — loopback's 127.0.0.1 callback can't reach a
// remote shell from the user's local browser.
assert.equal(
  chooseLoginMode({ agent: false, headless: false, handoff: false, ssh: true }),
  "headless",
);
assert.equal(
  chooseLoginMode({ agent: true, headless: true, handoff: true, ssh: true }),
  "headless",
);

// isSshSession keys off the vars sshd exports; a clean env is not SSH.
assert.equal(isSshSession({}), false, "empty env is not SSH");
assert.equal(isSshSession({ SSH_TTY: "/dev/pts/0" }), true, "SSH_TTY marks an SSH session");
assert.equal(
  isSshSession({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }),
  true,
  "SSH_CONNECTION marks an SSH session",
);
assert.equal(
  isSshSession({ SSH_CLIENT: "1.2.3.4 22 22" }),
  true,
  "SSH_CLIENT marks an SSH session",
);

// 3. Invalid callbacks must not consume the real browser handshake.
{
  const server = await startLoopbackServer();
  const state = randomState();
  const wait = server.waitForCode(state, 5_000);
  await hit(server.port, `/callback?code=the_code&state=${encodeURIComponent(state)}`);
  assert.equal(await wait, "the_code", "matching state yields the code");
}
{
  const server = await startLoopbackServer();
  const state = randomState();
  const wait = server.waitForCode(state, 5_000);
  await hit(server.port, "/callback?code=x&state=WRONG");
  await hit(server.port, "/callback?state=WRONG");
  await hit(server.port, "/favicon.ico");
  await hit(server.port, `/callback?code=valid&state=${encodeURIComponent(state)}`);
  assert.equal(await wait, "valid", "invalid callbacks leave the original approval usable");
}

console.log("loopback: PKCE derivation, login router, and state-checked callback all pass");

function hit(port: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
  });
}

for (const url of [
  "https://fillo.so/cli/authorize?state=first&challenge=second",
  "https://example.com/path?value=%25&more=hello;echo&quote=%22&pipe=|&caret=^",
]) {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const plan = browserCommand(url, platform)!;
    assert.equal(plan.args.at(-1), new URL(url).toString());
    assert.ok(!["cmd", "cmd.exe", "powershell", "sh"].includes(plan.command));
  }
}
assert.equal(browserCommand("file:///tmp/unsafe", "win32"), undefined);
assert.equal(browserCommand("invalid", "linux"), undefined);
