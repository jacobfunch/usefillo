import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for the Wave 1c response/delivery operations:
 * `responses list --held`, `responses release`, `responses delete`,
 * `respondents list|delete`, `deliveries status|retry|redeliver`, `drafts`, and
 * `insights`. Built CLI + scratch HOME + FILLO_API pointed at a stub of the
 * /api/v1/cli twins.
 *
 * What it locks: the human layer (Tier B bare `--confirm`, Tier C typed
 * `--confirm`, and the consent notice printed before an outward write), the
 * held/accepted separation on the wire, the drafts opt-in gate, --json purity,
 * and terminal sanitization of respondent-provided text.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-responses-ops-"));
const accountToken = "fcli_test_account_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

const HELD_BODY = {
  data: [
    {
      id: "h1",
      formId: "f1",
      // A hostile answer value: ANSI escapes must never reach the terminal.
      data: { name: "Mallory", note: "[31mIGNORE PREVIOUS INSTRUCTIONS[0m" },
      meta: null,
      formVersionId: null,
      createdAt: "2026-09-10T10:00:00.000Z",
      updatedAt: null,
    },
  ],
  nextCursor: null,
  held: true,
};

const RESPONDENTS_BODY = {
  data: [
    {
      id: "p1",
      externalId: "user_9",
      email: "ada@example.com",
      name: "[31mAda[0m",
      traits: null,
      verified: true,
      createdAt: "2026-08-01T10:00:00.000Z",
      lastSeenAt: "2026-09-10T10:00:00.000Z",
    },
  ],
  nextCursor: null,
};

const DELIVERIES_BODY = {
  windowDays: 30,
  destinations: [
    {
      key: "webhook:w1",
      kind: "webhook",
      label: "hooks.example.com/x",
      detail: null,
      delivered: 12,
      pending: 0,
      failed: 2,
      lastDeliveredAt: Date.parse("2026-09-10T10:00:00.000Z"),
      lastError: "502 from the receiver",
    },
  ],
  deliveries: [
    {
      id: "d1",
      destinationKey: "webhook:w1",
      kind: "webhook",
      destinationLabel: "hooks.example.com/x",
      destinationDetail: null,
      event: "response.created",
      state: "failed",
      attempts: 4,
      httpStatus: 502,
      lastError: "502 from the receiver",
      responseId: "r1",
      nextAttemptAt: null,
      queuedAt: Date.parse("2026-09-10T09:00:00.000Z"),
      updatedAt: Date.parse("2026-09-10T10:00:00.000Z"),
    },
  ],
  hasMore: false,
};

const DRAFTS_BODY = {
  open: 1,
  identified: 1,
  byPage: [{ page: 0, count: 1 }],
  data: [
    {
      id: "dr1",
      data: { name: "Bo", note: "[31mhalf typed[0m" },
      page: 0,
      updatedAt: Date.parse("2026-09-10T10:00:00.000Z"),
      expiresAt: Date.parse("2026-09-17T10:00:00.000Z"),
      respondent: { externalId: "user_9", email: "ada@example.com", name: "Ada" },
    },
  ],
};

const INSIGHTS_BODY = {
  range: "all",
  total: 42,
  firstAt: Date.parse("2026-08-01T10:00:00.000Z"),
  lastAt: Date.parse("2026-09-10T10:00:00.000Z"),
  medianDurationMs: 95_000,
  durationCount: 40,
  lastSevenDays: 12,
  previousSevenDays: 8,
  sevenDayChange: 50,
  sampled: false,
  versionCount: 2,
  legacyHistoryIncomplete: false,
  timeline: [{ day: "2026-09-10", count: 3 }],
  sources: [
    { key: "__unknown__", label: "Direct or unknown", count: 20, pct: 47.6 },
    { key: "newsletter", label: "newsletter", count: 22, pct: 52.4 },
  ],
  surfaces: [],
  funnel: {
    started: 60,
    completed: 42,
    excluded: 0,
    completionRate: 70,
    multiPage: true,
    pages: [
      { index: 0, title: "About you", reached: 60, pct: 100 },
      { index: 1, title: "Feedback", reached: 44, pct: 73.3 },
    ],
  },
  drafts: { open: 3, identified: 1, byPage: [] },
  fields: [
    {
      id: "nps",
      label: "How likely are you to recommend us?",
      kind: "linear_scale",
      inCurrentSchema: true,
      answered: 40,
      skipped: 2,
      fillRate: 0.95,
      summary: {
        type: "scale",
        min: 0,
        max: 10,
        avg: 8.1,
        median: 8,
        histogram: [],
        metric: { kind: "nps", score: 35, promoters: 22, passives: 10, detractors: 8 },
      },
    },
    {
      id: "csat",
      label: "How was it?",
      kind: "rating",
      inCurrentSchema: true,
      answered: 38,
      skipped: 4,
      fillRate: 0.9,
      summary: {
        type: "scale",
        min: 1,
        max: 5,
        avg: 4.2,
        median: 4,
        histogram: [],
        metric: { kind: "csat", score: 80, satisfied: 30, neutral: 5, dissatisfied: 3 },
      },
    },
  ],
  segment: null,
  segmentIgnored: false,
};

let api = "";
let requests = [];
let releaseAllCalls = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, api || "http://127.0.0.1");
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : undefined,
    });
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${accountToken}`) {
      return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
    }
    const body = raw ? JSON.parse(raw) : {};

    if (url.pathname === "/api/v1/cli/forms/f1/responses" && req.method === "GET") {
      return send(200, url.searchParams.get("held") ? HELD_BODY : { data: [], nextCursor: null });
    }
    if (url.pathname === "/api/v1/cli/forms/f1/responses/release") {
      if (!body.all) return send(200, { released: (body.responseIds ?? []).length, remaining: 0 });
      // The server caps a release at 200 rows and reports what is still held;
      // the first `--all` call leaves two behind so the CLI must call again.
      releaseAllCalls += 1;
      return send(
        200,
        releaseAllCalls === 1 ? { released: 3, remaining: 2 } : { released: 2, remaining: 0 },
      );
    }
    if (url.pathname === "/api/v1/cli/forms/f1/responses/r1" && req.method === "DELETE") {
      if (body.confirm !== "r1") {
        return send(409, {
          error: "The confirm value did not match the response id — nothing was deleted.",
          code: "confirm_mismatch",
        });
      }
      return send(200, { id: "r1", deleted: true });
    }
    if (url.pathname === "/api/v1/cli/respondents" && req.method === "GET") {
      return send(200, RESPONDENTS_BODY);
    }
    if (url.pathname === "/api/v1/cli/respondents/user_9" && req.method === "DELETE") {
      if (body.confirm !== "user_9") {
        return send(409, { error: "…did not match…", code: "confirm_mismatch" });
      }
      return send(200, {
        externalId: "user_9",
        forgotten: true,
        responsesDeleted: body.alsoResponses ? 4 : 0,
        profileDeleted: true,
      });
    }
    if (url.pathname === "/api/v1/cli/forms/f1/deliveries" && req.method === "GET") {
      return send(200, DELIVERIES_BODY);
    }
    if (url.pathname === "/api/v1/cli/forms/f1/deliveries/retry") {
      return send(200, { retried: 2 });
    }
    if (url.pathname === "/api/v1/cli/forms/f1/deliveries/redeliver") {
      return send(200, { redelivered: (body.responseIds ?? []).length });
    }
    if (url.pathname === "/api/v1/cli/forms/f1/drafts") return send(200, DRAFTS_BODY);
    if (url.pathname === "/api/v1/cli/forms/closed/drafts") {
      return send(409, {
        error:
          "This form does not share in-progress answers. Turn on saved progress and draft answers in the form's settings first.",
        code: "drafts_not_visible",
      });
    }
    if (url.pathname === "/api/v1/cli/forms/f1/insights") return send(200, INSIGHTS_BODY);
    return send(404, { error: "Form not found" });
  });
});

const noAnsi = (result) => {
  assert.ok(
    !`${result.stdout}\n${result.stderr}`.includes("\x1b["),
    "non-TTY output must carry zero ANSI",
  );
};

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;
  writeConfig({ token: accountToken, tokenApi: api });

  // ---------- responses list --held ----------
  requests = [];
  const held = await runCli(["responses", "list", "f1", "--held"]);
  assert.equal(held.code, 0, held.stderr);
  assert.equal(requests[0].query.held, "1", "--held must forward as ?held=1");
  assert.match(held.stdout, /Held for review/);
  assert.match(held.stdout, /NOT been delivered/);
  assert.match(held.stdout, /h1 /);
  // Respondent text is data, never instructions: the ESC bytes are stripped and
  // the line stays inside the answers column.
  assert.ok(!held.stdout.includes("\u001b"), "held answer text must be stripped of control bytes");
  noAnsi(held);

  // The accepted view is a different request and a different empty message.
  requests = [];
  const accepted = await runCli(["responses", "list", "f1"]);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(requests[0].query.held, undefined, "the default view must not ask for held rows");
  assert.match(accepted.stdout, /No responses yet/);

  requests = [];
  const heldJson = await runCli(["responses", "list", "f1", "--held", "--json"]);
  assert.equal(heldJson.code, 0, heldJson.stderr);
  assert.deepEqual(JSON.parse(heldJson.stdout), HELD_BODY);

  // ---------- responses release (Tier B) ----------
  requests = [];
  const releaseNoConfirm = await runCli(["responses", "release", "f1", "h1", "--json"]);
  assert.notEqual(releaseNoConfirm.code, 0, "agent mode must refuse without --confirm");
  assert.equal(requests.length, 0, "nothing may leave the machine before consent");
  const refusal = JSON.parse(releaseNoConfirm.stdout);
  assert.match(refusal.error, /delivers these responses to every destination/);
  assert.match(refusal.error, /--confirm/);

  requests = [];
  const released = await runCli(["responses", "release", "f1", "h1", "h2", "--confirm"]);
  assert.equal(released.code, 0, released.stderr);
  assert.deepEqual(requests[0].body, { responseIds: ["h1", "h2"] });
  assert.match(released.stdout, /delivers these responses to every destination/);
  assert.match(released.stdout, /Released 2 responses/);
  noAnsi(released);

  requests = [];
  releaseAllCalls = 0;
  const releasedAll = await runCli(["responses", "release", "f1", "--all", "--confirm", "--json"]);
  assert.equal(releasedAll.code, 0, releasedAll.stderr);
  assert.deepEqual(requests[0].body, { all: true });
  // Two calls: the CLI loops while the server reports held responses remaining.
  assert.equal(requests.filter((r) => r.path.endsWith("/responses/release")).length, 2);
  assert.deepEqual(JSON.parse(releasedAll.stdout), { released: 5, remaining: 0 });
  // The consent notice rides stderr as a JSON line, keeping stdout one document.
  assert.match(releasedAll.stderr, /"status":"notice"/);

  requests = [];
  const releaseBoth = await runCli(["responses", "release", "f1", "h1", "--all", "--confirm"]);
  assert.notEqual(releaseBoth.code, 0);
  assert.match(releaseBoth.stderr, /not both/);
  assert.equal(requests.length, 0, "local validation must not call the server");

  // ---------- responses delete (Tier C) ----------
  requests = [];
  const deleteNoConfirm = await runCli(["responses", "delete", "f1", "r1", "--json"]);
  assert.notEqual(deleteNoConfirm.code, 0);
  assert.equal(requests.length, 0);
  assert.match(JSON.parse(deleteNoConfirm.stdout).error, /--confirm "r1"/);

  requests = [];
  const deleteWrong = await runCli(["responses", "delete", "f1", "r1", "--confirm", "r2"]);
  assert.notEqual(deleteWrong.code, 0);
  assert.deepEqual(requests[0].body, { confirm: "r2" });
  assert.match(deleteWrong.stderr, /did not match the response id/);

  requests = [];
  const deleted = await runCli(["responses", "delete", "f1", "r1", "--confirm", "r1"]);
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.equal(requests[0].method, "DELETE");
  assert.match(deleted.stdout, /Deleted response r1/);

  // A bare --confirm never satisfies a typed (Tier C) confirmation.
  requests = [];
  const bareOnDelete = await runCli(["responses", "delete", "f1", "r1", "--confirm", "--json"]);
  assert.notEqual(bareOnDelete.code, 0, "Tier C needs the typed target, not a bare flag");
  assert.equal(requests.length, 0);

  // ---------- respondents ----------
  requests = [];
  const people = await runCli(["respondents", "list"]);
  assert.equal(people.code, 0, people.stderr);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    ["GET /api/v1/cli/respondents"],
  );
  assert.match(people.stdout, /EXTERNAL ID +EMAIL +NAME +VERIFIED +LAST SEEN/);
  // Sanitized text keeps the visible characters, so assert around the stripped
  // escape rather than pinning the exact column width of a hostile value.
  assert.match(people.stdout, /user_9 +ada@example\.com .*yes +2026-09-10/);
  assert.match(people.stdout, /Ada/);
  assert.ok(!people.stdout.includes("\u001b"), "profile text must be stripped of control bytes");
  noAnsi(people);

  requests = [];
  const peopleFiltered = await runCli(["respondents", "list", "--email", "ada@example.com"]);
  assert.equal(peopleFiltered.code, 0, peopleFiltered.stderr);
  assert.equal(requests[0].query.email, "ada@example.com");

  requests = [];
  const forgetNoConfirm = await runCli(["respondents", "delete", "user_9", "--json"]);
  assert.notEqual(forgetNoConfirm.code, 0);
  assert.equal(requests.length, 0);
  assert.match(JSON.parse(forgetNoConfirm.stdout).error, /--confirm "user_9"/);

  requests = [];
  const forgot = await runCli([
    "respondents",
    "delete",
    "user_9",
    "--also-responses",
    "--confirm",
    "user_9",
  ]);
  assert.equal(forgot.code, 0, forgot.stderr);
  assert.deepEqual(requests[0].body, { confirm: "user_9", alsoResponses: true });
  assert.match(forgot.stdout, /Forgot user_9 and deleted 4 responses/);

  requests = [];
  const deidentified = await runCli(["respondents", "delete", "user_9", "--confirm", "user_9"]);
  assert.equal(deidentified.code, 0, deidentified.stderr);
  assert.deepEqual(requests[0].body, { confirm: "user_9" });
  assert.match(deidentified.stdout, /answers remain, with the identity stripped/);

  // ---------- deliveries ----------
  requests = [];
  const status = await runCli(["deliveries", "status", "f1"]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Destinations +last 30 days/);
  assert.match(status.stdout, /webhook:w1/);
  assert.match(status.stdout, /502 from the receiver/);
  assert.match(status.stdout, /fillo deliveries retry <form> --all/);
  assert.match(status.stdout, /Recent/);
  noAnsi(status);

  requests = [];
  const statusJson = await runCli(["deliveries", "status", "f1", "--json"]);
  assert.equal(statusJson.code, 0, statusJson.stderr);
  assert.deepEqual(JSON.parse(statusJson.stdout), DELIVERIES_BODY);

  requests = [];
  const retried = await runCli(["deliveries", "retry", "f1", "--all"]);
  assert.equal(retried.code, 0, retried.stderr);
  assert.deepEqual(requests[0].body, { all: true });
  assert.match(retried.stdout, /Re-queued 2 deliveries/);

  requests = [];
  const retryDest = await runCli(["deliveries", "retry", "f1", "--destination", "webhook:w1"]);
  assert.equal(retryDest.code, 0, retryDest.stderr);
  assert.deepEqual(requests[0].body, { destinationKey: "webhook:w1" });

  requests = [];
  const retryRow = await runCli([
    "deliveries",
    "retry",
    "f1",
    "--delivery",
    "d1",
    "--kind",
    "webhook",
  ]);
  assert.equal(retryRow.code, 0, retryRow.stderr);
  assert.deepEqual(requests[0].body, { deliveryId: "d1", deliveryKind: "webhook" });

  requests = [];
  const retryTwoTargets = await runCli([
    "deliveries",
    "retry",
    "f1",
    "--all",
    "--destination",
    "webhook:w1",
  ]);
  assert.notEqual(retryTwoTargets.code, 0);
  assert.match(retryTwoTargets.stderr, /exactly one of/);
  assert.equal(requests.length, 0);

  requests = [];
  const retryHalfTarget = await runCli(["deliveries", "retry", "f1", "--delivery", "d1"]);
  assert.notEqual(retryHalfTarget.code, 0);
  assert.match(retryHalfTarget.stderr, /--kind webhook\|integration/);

  // redeliver is Tier B: agent mode needs a bare --confirm, and the duplicate
  // warning must be printed before the write either way.
  requests = [];
  const redeliverNoConfirm = await runCli(["deliveries", "redeliver", "f1", "r1", "--json"]);
  assert.notEqual(redeliverNoConfirm.code, 0);
  assert.equal(requests.length, 0);
  assert.match(JSON.parse(redeliverNoConfirm.stdout).error, /duplicate row/);

  requests = [];
  const redelivered = await runCli(["deliveries", "redeliver", "f1", "r1", "r2", "--confirm"]);
  assert.equal(redelivered.code, 0, redelivered.stderr);
  assert.deepEqual(requests[0].body, { responseIds: ["r1", "r2"] });
  assert.match(redelivered.stdout, /duplicate row/);
  assert.match(redelivered.stdout, /Re-sending 2 responses/);

  // ---------- drafts ----------
  requests = [];
  const drafts = await runCli(["drafts", "f1"]);
  assert.equal(drafts.code, 0, drafts.stderr);
  assert.match(drafts.stdout, /1 in progress +1 identified/);
  assert.match(drafts.stdout, /dr1 +1 +ada@example\.com/);
  assert.ok(
    !drafts.stdout.includes("\u001b"),
    "draft answer text must be stripped of control bytes",
  );
  assert.match(drafts.stdout, /not submissions/);
  noAnsi(drafts);

  requests = [];
  const draftsJson = await runCli(["drafts", "f1", "--json"]);
  assert.equal(draftsJson.code, 0, draftsJson.stderr);
  assert.deepEqual(JSON.parse(draftsJson.stdout), DRAFTS_BODY);

  requests = [];
  const draftsClosed = await runCli(["drafts", "closed"]);
  assert.notEqual(draftsClosed.code, 0);
  assert.match(draftsClosed.stderr, /does not share in-progress answers/);

  // ---------- insights ----------
  requests = [];
  const insights = await runCli(["insights", "f1", "--range", "30d"]);
  assert.equal(insights.code, 0, insights.stderr);
  assert.equal(requests[0].query.range, "30d");
  assert.match(insights.stdout, /42 responses/);
  assert.match(insights.stdout, /7-day change \+50% \(12 vs 8\)/);
  assert.match(insights.stdout, /Median time 1m 35s across 40 timed responses/);
  assert.match(insights.stdout, /Journey +42\/60 completed \(70%\)/);
  assert.match(insights.stdout, /About you +60 +100/);
  assert.match(insights.stdout, /3 drafts still open/);
  // "Direct or unknown" is not a real source and stays out of the table.
  assert.match(insights.stdout, /newsletter +22 +52\.4/);
  assert.ok(!insights.stdout.includes("Direct or unknown"), "unknown sources stay hidden");
  assert.match(insights.stdout, /NPS 35 \(22 promoters, 10 passives, 8 detractors\)/);
  assert.match(insights.stdout, /CSAT 80% \(30 satisfied, 5 neutral, 3 dissatisfied\)/);
  noAnsi(insights);

  requests = [];
  const insightsJson = await runCli(["insights", "f1", "--json"]);
  assert.equal(insightsJson.code, 0, insightsJson.stderr);
  assert.deepEqual(JSON.parse(insightsJson.stdout), INSIGHTS_BODY);

  requests = [];
  const segmented = await runCli(["insights", "f1", "--by", "nps", "--eq", "10"]);
  assert.equal(segmented.code, 0, segmented.stderr);
  assert.equal(requests[0].query.by, "nps");
  assert.equal(requests[0].query.eq, "10");

  requests = [];
  const badRange = await runCli(["insights", "f1", "--range", "yesterday"]);
  assert.notEqual(badRange.code, 0);
  assert.match(badRange.stderr, /--range must be one of/);
  assert.equal(requests.length, 0);

  // ---------- dispatch + auth ----------
  for (const [args, pattern] of [
    [["respondents", "purge"], /Unknown respondents command: purge/],
    [["deliveries", "flush"], /Unknown deliveries command: flush/],
    [["responses", "purge"], /Unknown responses command: purge/],
  ]) {
    const unknown = await runCli(args);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, pattern);
  }
  for (const args of [["respondents"], ["deliveries"], ["drafts", "--help"], ["insights", "-h"]]) {
    const help = await runCli(args);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /fillo /);
  }

  requests = [];
  writeConfig({ token: "fcli_wrong_token", tokenApi: api });
  const rejected = await runCli(["deliveries", "status", "f1"]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /Token invalid — run `fillo login` again\./);

  requests = [];
  writeConfig({});
  const loggedOut = await runCli(["insights", "f1"]);
  assert.notEqual(loggedOut.code, 0);
  assert.match(loggedOut.stderr, /Not logged in/);
  assert.equal(requests.length, 0, "no request may leave the machine when logged out");

  console.log(
    "responses ops (held/release/delete, respondents, deliveries, drafts, insights) checks passed",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function writeConfig(config) {
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
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
