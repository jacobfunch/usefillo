import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for `fillo billing`: the read-only plan and usage report.
 *
 * What it locks, beyond "the request was made":
 *   - it is one GET and nothing else — no plan change or checkout call.
 *   - each plan state reads correctly: Free, a yearly subscription, a failed
 *     payment, a pending cancellation, a complimentary plan, and a server
 *     without billing.
 *   - an older server's trial fields degrade gracefully: an unused trial is
 *     never offered, and a trial already running reads back plainly.
 *   - the soft limit is stated as such: over the allowance, forms keep
 *     collecting, and the only next step is the fitting volume plus the
 *     Manage link a human opens — the CLI never offers to buy anything.
 *   - --json is the raw server document, and an unexpected manage link from
 *     the server is never printed.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-billing-"));
const accountToken = "fcli_test_billing_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

let api = "";
let requests = [];
let fixture = {};

const DAY = 86_400_000;
const MANAGE = "https://fillo.test/settings/plan";

function billingBody(overrides = {}) {
  return {
    billingEnabled: true,
    plan: "free",
    tier: null,
    interval: null,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    trialAvailable: false,
    allowance: 200,
    usage: { period: "2026-09", responses: 12, resetsAt: "2026-10-01T00:00:00.000Z" },
    history: [
      { period: "2026-09", responses: 12 },
      { period: "2026-08", responses: 40 },
      { period: "2026-07", responses: 0 },
    ],
    manageUrl: MANAGE,
    ...overrides,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, api || "http://127.0.0.1");
  requests.push({ method: req.method, path: url.pathname });
  res.setHeader("Content-Type", "application/json");
  const send = (status, payload) => {
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  };
  if (req.headers.authorization !== `Bearer ${accountToken}`) {
    return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
  }
  if (url.pathname === "/api/v1/cli/workspace/billing" && req.method === "GET") {
    return send(200, fixture);
  }
  return send(404, { error: "not found" });
});

async function report(body) {
  requests = [];
  fixture = body;
  const result = await runCli(["billing"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    ["GET /api/v1/cli/workspace/billing"],
    "billing must be exactly one read",
  );
  // Never an offer to buy: no checkout, no "upgrade now", and no URL but Manage.
  assert.doesNotMatch(result.stdout, /checkout|upgrade|buy|subscribe now/i);
  const urls = result.stdout.match(/https?:\/\/\S+/g) ?? [];
  assert.ok(
    urls.every((u) => u === MANAGE),
    `only the Manage link may be printed, got: ${urls.join(", ")}`,
  );
  return result.stdout;
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;
  writeFileSync(configPath, JSON.stringify({ token: accountToken, tokenApi: api }), {
    mode: 0o600,
  });

  // ================= Free ==================================================
  const free = await report(billingBody());
  assert.match(free, /Plan: +Free · 200 responses a month/);
  assert.match(free, /Usage: +12 of 200 responses this month \(6%\) · resets 1 Oct/);
  assert.match(free, /Earlier: +Aug 40 · Jul 0/);
  assert.match(free, /Manage: +https:\/\/fillo\.test\/settings\/plan \(owner or admin\)/);
  assert.doesNotMatch(free, /trial/i);
  assert.doesNotMatch(free, /Forms keep collecting/, "no limit note under 80%");

  // An older server may still say a trial is available: it is never offered.
  const freeOlder = await report(billingBody({ trialAvailable: true }));
  assert.match(freeOlder, /Plan: +Free · 200 responses a month/);
  assert.doesNotMatch(freeOlder, /trial|no card/i);

  // A quiet history stays off.
  const freeQuiet = await report(
    billingBody({
      history: [
        { period: "2026-08", responses: 0 },
        { period: "2026-07", responses: 0 },
      ],
    }),
  );
  assert.doesNotMatch(freeQuiet, /Earlier:/);

  // ================= an older server's running trial =======================
  const trial = await report(
    billingBody({
      plan: "trial",
      tier: "5k",
      allowance: 5000,
      trialEndsAt: new Date(Date.now() + 12 * DAY - 3_600_000).toISOString(),
      usage: { period: "2026-09", responses: 300, resetsAt: "2026-10-01T00:00:00.000Z" },
    }),
  );
  assert.match(
    trial,
    /Plan: +Everything trial · 5,000 responses · ends \d{1,2} [A-Z][a-z]{2} \d{4} \(12 days left\)\n/,
  );
  assert.match(trial, /300 of 5,000 responses this month \(6%\)/);
  assert.match(
    trial,
    /When the trial ends without a subscription, the workspace returns to Free\./,
  );

  // ================= a yearly subscription =================================
  const yearly = await report(
    billingBody({
      plan: "subscribed",
      tier: "25k",
      interval: "year",
      status: "active",
      currentPeriodEnd: "2027-09-26T10:00:00.000Z",
      allowance: 25000,
      usage: { period: "2026-09", responses: 1234, resetsAt: "2026-10-01T00:00:00.000Z" },
      history: [
        { period: "2026-09", responses: 1234 },
        { period: "2026-08", responses: 980 },
        { period: "2025-12", responses: 5 },
      ],
    }),
  );
  assert.match(yearly, /Plan: +Everything 25k · billed yearly · renews 26 Sep 2027/);
  assert.match(yearly, /Usage: +1,234 of 25,000 responses this month \(4%\) · resets 1 Oct/);
  assert.match(yearly, /Earlier: +Aug 980 · Dec 2025 5/, "another year's month carries its year");
  assert.doesNotMatch(yearly, /\n {2}\S.*\n\n {2}\S/, "a healthy plan prints no notes block");

  // ================= a failed payment ======================================
  const pastDue = await report(
    billingBody({
      plan: "subscribed",
      tier: "5k",
      interval: "month",
      status: "past_due",
      currentPeriodEnd: "2026-10-03T00:00:00.000Z",
      allowance: 5000,
      usage: { period: "2026-09", responses: 900, resetsAt: "2026-10-01T00:00:00.000Z" },
    }),
  );
  assert.match(pastDue, /Plan: +Everything 5k · billed monthly · payment failed/);
  assert.doesNotMatch(pastDue, /renews/, "a failed payment never reads as a renewal");
  assert.match(
    pastDue,
    /The last payment failed\. Stripe is retrying it, and Everything stays on meanwhile\./,
  );
  assert.match(pastDue, /updates the card from Manage billing/);

  // ================= a pending cancellation, and a complimentary plan ======
  const canceling = await report(
    billingBody({
      plan: "subscribed",
      tier: "5k",
      interval: "month",
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-10-14T00:00:00.000Z",
      allowance: 5000,
    }),
  );
  assert.match(canceling, /Plan: +Everything 5k · billed monthly · cancels 14 Oct 2026/);
  assert.match(canceling, /returns to Free after that/);

  const comp = await report(billingBody({ plan: "complimentary", tier: "5k", allowance: 5000 }));
  assert.match(comp, /Plan: +Everything 5k · complimentary \(no charge, no renewal date\)/);

  // ================= near and over the soft limit ==========================
  const near = await report(
    billingBody({
      usage: { period: "2026-09", responses: 170, resetsAt: "2026-10-01T00:00:00.000Z" },
    }),
  );
  assert.match(
    near,
    /85% of this month's allowance is used\. Forms keep collecting if it runs over\./,
  );
  assert.match(near, /The next volume is Everything 5k \(5,000 a month\)\./);

  const over = await report(
    billingBody({
      plan: "subscribed",
      tier: "5k",
      interval: "month",
      status: "active",
      currentPeriodEnd: "2026-10-03T00:00:00.000Z",
      allowance: 5000,
      usage: { period: "2026-09", responses: 31000, resetsAt: "2026-10-01T00:00:00.000Z" },
    }),
  );
  assert.match(over, /31,000 of 5,000 responses this month \(620%\)/);
  assert.match(
    over,
    /Past this month's allowance\. Forms keep collecting and nothing is dropped\./,
  );
  assert.match(
    over,
    /The volume that fits is Everything 100k \(100,000 a month\)\./,
    "the suggestion skips a volume that would still be too small",
  );

  const overTop = await report(
    billingBody({
      plan: "subscribed",
      tier: "100k",
      interval: "year",
      status: "active",
      currentPeriodEnd: "2027-01-05T00:00:00.000Z",
      allowance: 100000,
      usage: { period: "2026-09", responses: 100000, resetsAt: "2026-10-01T00:00:00.000Z" },
    }),
  );
  assert.match(overTop, /Forms keep collecting and nothing is dropped/);
  assert.match(overTop, /For steady volume above 100,000 a month, write to hello@fillo\.so\./);

  // ================= a server without billing ==============================
  const noBilling = await report(
    billingBody({
      billingEnabled: false,
      plan: "trial",
      tier: "5k",
      allowance: 5000,
      trialEndsAt: null,
      manageUrl: null,
      usage: { period: "2026-09", responses: 5200, resetsAt: "2026-10-01T00:00:00.000Z" },
    }),
  );
  assert.match(noBilling, /Plan: +Everything\n/);
  assert.match(noBilling, /5,200 of 5,000 responses this month \(104%\)/);
  assert.match(noBilling, /Forms keep collecting and nothing is dropped/);
  assert.doesNotMatch(noBilling, /Manage:|volume|trial/i, "no billing means no billing steps");
  assert.match(noBilling, /Billing isn't enabled on this Fillo server\./);

  // ================= --json, hostile links, and dispatch ===================
  requests = [];
  fixture = billingBody({ plan: "subscribed", tier: "25k", interval: "year", status: "active" });
  const json = await runCli(["billing", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const lines = json.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be one JSON line, got:\n${json.stdout}`);
  assert.deepEqual(JSON.parse(lines[0]), fixture);

  fixture = billingBody({ manageUrl: "javascript:alert(1)" });
  const hostile = await runCli(["billing"]);
  assert.equal(hostile.code, 0, hostile.stderr);
  assert.doesNotMatch(hostile.stdout, /javascript:/);
  assert.match(hostile.stdout, new RegExp(`Manage: +${api.replace(/[.]/g, "\\.")}/settings/plan`));

  fixture = { error: "nope" };
  const malformed = await runCli(["billing"]);
  assert.notEqual(malformed.code, 0, "a 2xx without plan and usage is a failure");

  requests = [];
  const unknown = await runCli(["billing", "upgrade"]);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown billing command: upgrade/);
  assert.deepEqual(requests, [], "an unknown subcommand never reaches the server");

  const help = await runCli(["billing", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Read-only/);
  assert.match(help.stdout, /Settings → Billing & plan/);
  assert.doesNotMatch(help.stdout, /trial/i, "help never offers a trial");

  console.log("billing checks passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env,
        FILLO_API: api,
        CI: "true",
        HOME: home,
        USERPROFILE: home,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
