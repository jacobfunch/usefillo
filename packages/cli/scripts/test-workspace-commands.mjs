import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic coverage for the Workspace command group (workspace lifecycle,
 * storage, slack, webhooks, settings, members, delete): built CLI + scratch HOME + FILLO_API pointed at a
 * stub of the /api/v1/cli/* management twins. Locks the --json single-document
 * contract, the S3 flags/env/prompt resolution, the browser-connect poll, the
 * secret-shown-once webhook, settings key=value parsing, invite failures, and
 * the typed-confirmation delete guards (interactive prompt vs required flag).
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-workspace-"));
const accountToken = "fcli_test_account_secret";

mkdirSync(join(home, ".fillo"), { recursive: true });
const configPath = join(home, ".fillo", "config.json");

let api = "";
let requests = [];
let state = {};

function resetState(overrides = {}) {
  requests = [];
  state = {
    storage: {
      providers: {
        s3: {
          connected: true,
          detail: {
            endpoint: "s3.example.com",
            bucket: "uploads",
            region: "auto",
            forcePathStyle: false,
          },
        },
        gdrive: { connected: false, detail: null },
        box: { connected: false, detail: null },
      },
      transit: { active: true, accessUntil: "2026-08-01T00:00:00.000Z" },
      implicitStorageProvider: null,
      defaultStorageProvider: "s3",
      canPublishFileFields: true,
    },
    storagePolls: 0,
    driveConnectAt: Number.POSITIVE_INFINITY,
    s3Connect: {
      status: 200,
      body: {
        connected: true,
        detail: {
          endpoint: "s3.example.com",
          bucket: "uploads",
          region: "auto",
          forcePathStyle: false,
        },
      },
    },
    s3Disconnect: { status: 200, body: { ok: true, provider: "s3", connected: false } },
    providerDisconnect: { status: 200 },
    slack: {
      connected: true,
      accountLabel: "Acme",
      channels: [
        { id: "C1", name: "general", isPrivate: false },
        { id: "C2", name: "vip", isPrivate: true },
      ],
      channelsSyncedAt: "2026-07-25T10:00:00.000Z",
    },
    slackRefresh: null,
    webhooksList: {
      webhooks: [
        {
          id: "wh1",
          url: "https://a.test/hook",
          events: ["response.created"],
          createdAt: "2026-07-20T10:00:00.000Z",
        },
      ],
    },
    webhookAdd: {
      status: 201,
      body: {
        id: "wh2",
        url: "https://b.test/hook",
        events: ["response.created", "draft.abandoned"],
        secret: "whsec_test_shown_once",
      },
    },
    webhookPatch: {
      status: 200,
      body: { id: "wh2", events: ["response.created", "draft.abandoned"] },
    },
    webhookDelete: { status: 200, body: { id: "wh2", deleted: true } },
    settings: {
      notifyEmail: "team@acme.test",
      sendReceipt: true,
      saveProgress: false,
      draftAnswersVisible: false,
      resumeEmails: false,
      resumeUrl: null,
      draftDigest: false,
      responseLimit: null,
      trust: null,
    },
    settingsPatchError: null,
    members: {
      members: [
        {
          id: "m1",
          userId: "u1",
          email: "owner@acme.test",
          name: "Ada Owner",
          role: "owner",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "m2",
          userId: "u2",
          email: "bo@acme.test",
          name: "Bo Member",
          role: "member",
          createdAt: "2026-06-15T00:00:00.000Z",
        },
      ],
      invitations: [
        {
          id: "inv1",
          email: "cy@acme.test",
          role: "member",
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    },
    invite: {
      status: 201,
      body: {
        invitation: {
          id: "inv2",
          email: "new@acme.test",
          role: "member",
          status: "pending",
          expiresAt: "2026-08-10T00:00:00.000Z",
        },
      },
    },
    cancelInvite: { status: 200, body: { id: "inv1", cancelled: true } },
    form: { id: "f1", name: "Contact Form", status: "draft", slug: "contact" },
    formMissing: false,
    workspaceName: "Acme Inc",
    currentWorkspaceId: "org_acme",
    currentProjectId: "project_main",
    projects: [
      {
        id: "project_main",
        organizationId: "org_acme",
        name: "Main site",
        slug: "main-site-a1b2c3",
      },
      {
        id: "project_docs",
        organizationId: "org_acme",
        name: "Docs Site",
        slug: "docs-site-d4e5f6",
      },
    ],
    workspaceForce403: false,
    workspacePurgeAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, api || "http://127.0.0.1");
  requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    authorization: req.headers.authorization,
    body,
  });
  res.setHeader("Content-Type", "application/json");
  const send = (status, payload, headers = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(payload));
  };
  if (req.headers.authorization !== `Bearer ${accountToken}`) {
    return send(401, { error: "Invalid or missing CLI token — run `fillo login`" });
  }

  const segs = url.pathname.split("/").filter(Boolean).slice(3); // after api/v1/cli
  const [a, b, c, d] = segs;

  // ---- project lifecycle ----
  if (a === "projects" && b === undefined && req.method === "GET") {
    return send(200, {
      projects: state.projects.map((project) => ({
        ...project,
        current: project.id === state.currentProjectId,
      })),
    });
  }
  if (a === "projects" && b === undefined && req.method === "POST") {
    const parsed = JSON.parse(body);
    const project = {
      id: "project_new",
      organizationId: "org_acme",
      name: parsed.name,
      slug: "new-site-g7h8i9",
      publishableKey: "pk_new_project",
    };
    state.currentProjectId = project.id;
    return send(201, { project, selected: true });
  }
  if (a === "projects" && b === "select" && req.method === "POST") {
    const parsed = JSON.parse(body);
    const found = state.projects.find((project) =>
      [project.id, project.slug, project.name].includes(parsed.project),
    );
    if (!found) return send(404, { error: "No project in this workspace matches that value" });
    state.currentProjectId = found.id;
    return send(200, {
      project: { ...found, publishableKey: `pk_${found.id}` },
      selected: true,
    });
  }

  // ---- storage ----
  if (a === "storage" && b === undefined && req.method === "GET") {
    state.storagePolls += 1;
    const snapshot = JSON.parse(JSON.stringify(state.storage));
    if (state.storagePolls >= state.driveConnectAt) {
      snapshot.providers.gdrive = { connected: true, detail: { accountEmail: "ops@acme.test" } };
    }
    return send(200, snapshot);
  }
  if (a === "storage" && b === "s3" && req.method === "POST") {
    return send(state.s3Connect.status, state.s3Connect.body);
  }
  if (a === "storage" && b === "s3" && req.method === "DELETE") {
    return send(state.s3Disconnect.status, state.s3Disconnect.body ?? { error: "in use" });
  }
  if (a === "storage" && (b === "gdrive" || b === "box") && req.method === "DELETE") {
    if (state.providerDisconnect.status !== 200) {
      return send(state.providerDisconnect.status, state.providerDisconnect.body);
    }
    return send(200, { ok: true, provider: b, connected: false });
  }

  // ---- slack ----
  if (a === "slack" && req.method === "GET") {
    if (url.searchParams.get("refresh") === "1" && state.slackRefresh) {
      return send(
        state.slackRefresh.status,
        state.slackRefresh.body,
        state.slackRefresh.headers ?? {},
      );
    }
    return send(200, state.slack);
  }

  // ---- forms/<f>/webhooks ----
  if (a === "forms" && c === "webhooks" && d === undefined && req.method === "GET") {
    return send(200, state.webhooksList);
  }
  if (a === "forms" && c === "webhooks" && d === undefined && req.method === "POST") {
    return send(state.webhookAdd.status, state.webhookAdd.body);
  }
  if (a === "forms" && c === "webhooks" && d !== undefined && req.method === "PATCH") {
    return send(state.webhookPatch.status, state.webhookPatch.body);
  }
  if (a === "forms" && c === "webhooks" && d !== undefined && req.method === "DELETE") {
    return send(state.webhookDelete.status, state.webhookDelete.body);
  }

  // ---- forms/<f>/settings ----
  if (a === "forms" && c === "settings" && req.method === "GET") {
    return send(200, { settings: state.settings });
  }
  if (a === "forms" && c === "settings" && req.method === "PATCH") {
    if (state.settingsPatchError) {
      return send(state.settingsPatchError.status, state.settingsPatchError.body);
    }
    const patch = JSON.parse(body);
    return send(200, { settings: { ...state.settings, ...patch } });
  }

  // ---- forms/<f> (status / delete) ----
  if (a === "forms" && b !== undefined && c === undefined && req.method === "GET") {
    if (state.formMissing) return send(404, { error: "Form not found" });
    return send(200, { form: { ...state.form } });
  }
  if (a === "forms" && b !== undefined && c === undefined && req.method === "DELETE") {
    if (state.formMissing) return send(404, { error: "Form not found" });
    const parsed = JSON.parse(body);
    if (parsed.confirm !== state.form.name) {
      return send(409, {
        error: `The confirm value must exactly match the form title "${state.form.name}".`,
        code: "confirm_mismatch",
      });
    }
    if (state.form.status === "published" && parsed.alsoUnpublish !== true) {
      return send(409, {
        error: "This form is published. Pass alsoUnpublish: true to take it offline and delete it.",
        code: "published",
      });
    }
    return send(200, { id: state.form.id, deleted: true });
  }

  // ---- whoami (names the workspace + the pre-authoring storage signal) ----
  if (a === "whoami" && req.method === "GET") {
    return send(200, {
      workspace: state.workspaceName,
      workspaceId: state.currentWorkspaceId,
      workspaceSlug: "acme-inc-a1b2c3",
      project: state.projects.find((project) => project.id === state.currentProjectId)?.name,
      projectId: state.currentProjectId,
      projectSlug: state.projects.find((project) => project.id === state.currentProjectId)?.slug,
      canPublishFileFields: state.storage.canPublishFileFields,
    });
  }

  // ---- members ----
  if (a === "members" && b === undefined && req.method === "GET") {
    return send(200, state.members);
  }
  if (a === "members" && b === "invites" && c === undefined && req.method === "POST") {
    return send(state.invite.status, state.invite.body);
  }
  if (a === "members" && b === "invites" && c !== undefined && req.method === "DELETE") {
    return send(state.cancelInvite.status, state.cancelInvite.body);
  }

  // ---- workspace delete-request ----
  if (a === "workspace" && b === "delete-request" && req.method === "POST") {
    if (state.workspaceForce403) {
      return send(403, {
        error: "Only the workspace owner can schedule or cancel workspace deletion",
      });
    }
    const parsed = JSON.parse(body);
    if (parsed.confirm !== state.workspaceName) {
      return send(409, {
        error: `Type the workspace name "${state.workspaceName}" exactly to confirm.`,
      });
    }
    return send(200, { scheduledPurgeAt: state.workspacePurgeAt });
  }
  if (a === "workspace" && b === "delete-request" && req.method === "DELETE") {
    if (state.workspaceForce403) {
      return send(403, {
        error: "Only the workspace owner can schedule or cancel workspace deletion",
      });
    }
    return send(200, { ok: true });
  }

  return send(404, { error: "not found" });
});

const noAnsi = (result) => {
  assert.ok(
    !`${result.stdout}\n${result.stderr}`.includes("\x1b["),
    "non-TTY output must carry zero ANSI",
  );
};
const requestPaths = () => requests.map((r) => `${r.method} ${r.path}`);
const lastBody = () => JSON.parse(requests.at(-1).body);
const oneJsonDoc = (result) => {
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be exactly one JSON line, got:\n${result.stdout}`);
  return JSON.parse(lines[0]);
};

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;
  writeConfig({
    token: accountToken,
    tokenApi: api,
    pk: "pk_old_preview",
    claimUrl: "https://fillo.test/claim/old",
    email: "preview@example.test",
    name: "Preview User",
    claimToken: "old_claim_token",
  });

  // ================= project lifecycle =================
  resetState();
  const projectList = await runCli(["project"]);
  assert.equal(projectList.code, 0, projectList.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/projects"]);
  assert.match(projectList.stdout, /\* +Main site +main-site-a1b2c3 +project_main/);
  assert.match(projectList.stdout, /Docs Site +docs-site-d4e5f6 +project_docs/);

  resetState();
  const projectListJson = await runCli(["projects", "list", "--json"]);
  assert.equal(projectListJson.code, 0, projectListJson.stderr);
  assert.equal(oneJsonDoc(projectListJson).projects[0].current, true);

  resetState();
  const projectCreate = await runCli(["project", "create", "Customer", "site"]);
  assert.equal(projectCreate.code, 0, projectCreate.stderr);
  assert.deepEqual(lastBody(), { name: "Customer site", source: "cli" });
  assert.match(projectCreate.stdout, /Created and selected Customer site/);
  const createdConfig = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(createdConfig.pk, "pk_new_project");
  assert.equal(createdConfig.token, accountToken);
  assert.equal(createdConfig.tokenApi, api);
  assert.equal(createdConfig.claimUrl, undefined);
  assert.equal(createdConfig.email, undefined);
  assert.equal(createdConfig.name, undefined);
  assert.equal(createdConfig.claimToken, undefined);

  resetState();
  const projectSelect = await runCli(["project", "select", "docs-site-d4e5f6", "--json"]);
  assert.equal(projectSelect.code, 0, projectSelect.stderr);
  assert.equal(oneJsonDoc(projectSelect).project.id, "project_docs");
  assert.deepEqual(lastBody(), { project: "docs-site-d4e5f6", source: "cli" });
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).pk, "pk_project_docs");

  resetState();
  const projectMissing = await runCli(["project", "select", "missing"]);
  assert.notEqual(projectMissing.code, 0);
  assert.match(projectMissing.stderr, /No project in this workspace matches/);

  // ================= storage status =================
  resetState();
  const storageStatus = await runCli(["storage"]);
  assert.equal(storageStatus.code, 0, storageStatus.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/storage"]);
  assert.match(storageStatus.stdout, /PROVIDER +STATUS +DETAIL/);
  assert.match(storageStatus.stdout, /s3 +connected +s3\.example\.com · uploads · auto/);
  assert.match(storageStatus.stdout, /drive +not connected +—/);
  assert.match(storageStatus.stdout, /box +not connected +—/);
  assert.match(storageStatus.stdout, /Transit staging: active until 2026-08-01/);
  assert.match(storageStatus.stdout, /Uploads for storage=null forms resolve to: s3/);
  // The pre-authoring signal is spelled out in one line the agent can read.
  assert.match(storageStatus.stdout, /Can publish file fields: yes/);
  noAnsi(storageStatus);

  resetState();
  const storageJson = await runCli(["storage", "--json"]);
  assert.equal(storageJson.code, 0, storageJson.stderr);
  assert.deepEqual(oneJsonDoc(storageJson), state.storage);

  // A workspace with providers connected but no resolved default reports the
  // signal honestly — the fresh-install contradiction, made unambiguous.
  resetState();
  state.storage.providers.gdrive = { connected: true, detail: { accountEmail: "team@acme.com" } };
  state.storage.defaultStorageProvider = null;
  state.storage.canPublishFileFields = false;
  const storageAmbiguous = await runCli(["storage"]);
  assert.equal(storageAmbiguous.code, 0, storageAmbiguous.stderr);
  assert.match(storageAmbiguous.stdout, /Uploads for storage=null forms resolve to: no durable storage yet/);
  assert.match(storageAmbiguous.stdout, /Can publish file fields: not yet/);

  // ================= whoami carries the pre-authoring storage signal =========
  resetState();
  const whoamiReady = await runCli(["whoami"]);
  assert.equal(whoamiReady.code, 0, whoamiReady.stderr);
  assert.match(whoamiReady.stdout, /Connected to/);
  assert.match(whoamiReady.stdout, /File uploads: storage ready/);

  resetState();
  const whoamiJson = await runCli(["whoami", "--json"]);
  assert.equal(whoamiJson.code, 0, whoamiJson.stderr);
  const whoamiDoc = oneJsonDoc(whoamiJson);
  assert.equal(whoamiDoc.connected, true);
  assert.equal(whoamiDoc.canPublishFileFields, true);

  resetState();
  state.storage.canPublishFileFields = false;
  const whoamiBlocked = await runCli(["whoami"]);
  assert.equal(whoamiBlocked.code, 0, whoamiBlocked.stderr);
  assert.match(whoamiBlocked.stdout, /File uploads: no destination yet/);

  // ================= storage connect s3 =================
  // Flags-only happy path (envs neutralized so the machine's own can't leak in).
  const s3Env = {
    FILLO_S3_ENDPOINT: "",
    FILLO_S3_REGION: "",
    FILLO_S3_BUCKET: "",
    FILLO_S3_ACCESS_KEY_ID: "",
    FILLO_S3_SECRET_ACCESS_KEY: "",
    FILLO_S3_FORCE_PATH_STYLE: "",
  };
  resetState();
  const s3Ok = await runCli(
    [
      "storage",
      "connect",
      "s3",
      "--endpoint",
      "https://s3.example.com",
      "--bucket",
      "uploads",
      "--access-key-id",
      "AKIA_TEST",
      "--secret-access-key",
      "secret_test",
      "--region",
      "auto",
      "--force-path-style",
    ],
    s3Env,
  );
  assert.equal(s3Ok.code, 0, s3Ok.stderr);
  assert.deepEqual(requestPaths(), ["POST /api/v1/cli/storage/s3"]);
  assert.deepEqual(lastBody(), {
    endpoint: "https://s3.example.com",
    bucket: "uploads",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret_test",
    region: "auto",
    forcePathStyle: true,
  });
  assert.match(s3Ok.stdout, /Connected S3-compatible storage/);
  assert.match(s3Ok.stdout, /Uploads on published file fields now flow directly to this bucket/);
  noAnsi(s3Ok);

  // Env fallback: no flags, all values from the environment.
  resetState();
  const s3Env2 = await runCli(["storage", "connect", "s3", "--json"], {
    FILLO_S3_ENDPOINT: "https://env.example.com",
    FILLO_S3_BUCKET: "envbucket",
    FILLO_S3_ACCESS_KEY_ID: "ENVKEY",
    FILLO_S3_SECRET_ACCESS_KEY: "envsecret",
    FILLO_S3_REGION: "us-east-1",
  });
  assert.equal(s3Env2.code, 0, s3Env2.stderr);
  assert.deepEqual(lastBody(), {
    endpoint: "https://env.example.com",
    bucket: "envbucket",
    accessKeyId: "ENVKEY",
    secretAccessKey: "envsecret",
    region: "us-east-1",
  });
  assert.deepEqual(oneJsonDoc(s3Env2), state.s3Connect.body);

  // Missing values in a non-TTY run die naming the flag AND the env var.
  resetState();
  const s3Missing = await runCli(
    ["storage", "connect", "s3", "--access-key-id", "AKIA", "--secret-access-key", "sk"],
    s3Env,
  );
  assert.notEqual(s3Missing.code, 0);
  assert.match(s3Missing.stderr, /--endpoint \(or FILLO_S3_ENDPOINT\)/);
  assert.match(s3Missing.stderr, /--bucket \(or FILLO_S3_BUCKET\)/);
  assert.equal(requests.length, 0, "a missing-value die must not call the server");

  // 422 surfaces the probe error verbatim, plus the credentials/bucket hint.
  resetState({ s3Connect: { status: 422, body: { error: "Access denied by the bucket" } } });
  const s3Probe = await runCli(
    [
      "storage",
      "connect",
      "s3",
      "--endpoint",
      "https://s3.example.com",
      "--bucket",
      "uploads",
      "--access-key-id",
      "AKIA",
      "--secret-access-key",
      "sk",
    ],
    s3Env,
  );
  assert.notEqual(s3Probe.code, 0);
  assert.match(s3Probe.stderr, /Access denied by the bucket/);
  assert.match(s3Probe.stderr, /check the access key, secret, bucket, and endpoint/);

  // ================= storage connect drive (browser + poll) =================
  resetState({ driveConnectAt: 2 });
  const driveConnect = await runCli(["storage", "connect", "drive"], {
    FILLO_POLL_INTERVAL_MS: "10",
  });
  assert.equal(driveConnect.code, 0, driveConnect.stderr);
  assert.match(driveConnect.stdout, /api\/integrations\/google\/start\?return=terminal/);
  assert.match(driveConnect.stdout, /Open in your signed-in browser/);
  assert.match(driveConnect.stdout, /Connected Google Drive \(ops@acme\.test\)/);
  const drivePolls = requests.filter((r) => r.path === "/api/v1/cli/storage").length;
  assert.ok(drivePolls >= 2, `drive connect must poll until connected (saw ${drivePolls})`);
  noAnsi(driveConnect);

  resetState({ driveConnectAt: 2 });
  const driveJson = await runCli(["storage", "connect", "drive", "--json"], {
    FILLO_POLL_INTERVAL_MS: "10",
  });
  assert.equal(driveJson.code, 0, driveJson.stderr);
  assert.deepEqual(oneJsonDoc(driveJson), {
    connected: true,
    provider: "gdrive",
    accountEmail: "ops@acme.test",
  });
  const driveEvents = driveJson.stderr
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    driveEvents.map((e) => e.status),
    ["awaiting_connect", "connected"],
  );
  assert.match(driveEvents[0].url, /google\/start\?return=terminal/);

  // ================= storage disconnect =================
  resetState();
  const discNoProvider = await runCli(["storage", "disconnect"]);
  assert.notEqual(discNoProvider.code, 0);
  assert.match(discNoProvider.stderr, /Usage: fillo storage disconnect <s3\|drive\|box>/);
  assert.equal(requests.length, 0, "disconnect must never guess an implicit provider");

  resetState();
  const discS3 = await runCli(["storage", "disconnect", "s3"]);
  assert.equal(discS3.code, 0, discS3.stderr);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/storage/s3"]);
  assert.match(discS3.stdout, /Disconnected s3 storage/);

  resetState();
  const discDrive = await runCli(["storage", "disconnect", "drive"]);
  assert.equal(discDrive.code, 0, discDrive.stderr);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/storage/gdrive"], "drive maps to gdrive");

  resetState({
    s3Disconnect: {
      status: 409,
      body: { error: "This bucket still holds uploaded files. Unpublish forms using it first." },
    },
  });
  const discBusy = await runCli(["storage", "disconnect", "s3"]);
  assert.notEqual(discBusy.code, 0);
  assert.match(discBusy.stderr, /still holds uploaded files/);

  // ================= slack =================
  resetState();
  const slackStatus = await runCli(["slack"]);
  assert.equal(slackStatus.code, 0, slackStatus.stderr);
  assert.match(slackStatus.stdout, /Connected to Slack \(Acme\) — 2 channels cached/);

  resetState();
  const slackChannels = await runCli(["slack", "--channels"]);
  assert.equal(slackChannels.code, 0, slackChannels.stderr);
  assert.match(slackChannels.stdout, /NAME +ID +VISIBILITY/);
  assert.match(slackChannels.stdout, /general +C1 +public/);
  assert.match(slackChannels.stdout, /vip +C2 +private/);

  resetState();
  const slackJson = await runCli(["slack", "--json"]);
  assert.equal(slackJson.code, 0, slackJson.stderr);
  assert.deepEqual(oneJsonDoc(slackJson), state.slack);

  // refresh 409 → reconnect-in-browser guidance with the OAuth URL.
  resetState({
    slackRefresh: {
      status: 409,
      body: { error: "Reconnect Slack in the browser to refresh channels." },
    },
  });
  const slack409 = await runCli(["slack", "--refresh"]);
  assert.notEqual(slack409.code, 0);
  assert.equal(requests[0].query.refresh, "1", "--refresh must forward ?refresh=1");
  assert.match(slack409.stderr, /Reconnect Slack in the browser/);
  assert.match(
    slack409.stderr,
    /api\/integrations\/slack\/start\?return=terminal&project=project_main/,
  );

  // refresh 429 → rate-limit with the Retry-After seconds.
  resetState({
    slackRefresh: {
      status: 429,
      body: { error: "Slack is rate-limiting channel refreshes." },
      headers: { "Retry-After": "42" },
    },
  });
  const slack429 = await runCli(["slack", "--refresh"]);
  assert.notEqual(slack429.code, 0);
  assert.match(slack429.stderr, /rate-limiting/);
  assert.match(slack429.stderr, /retry after 42s/);

  // ================= webhooks =================
  resetState();
  const whList = await runCli(["webhooks", "list", "f1"]);
  assert.equal(whList.code, 0, whList.stderr);
  assert.match(whList.stdout, /ID +URL +EVENTS +CREATED/);
  assert.match(whList.stdout, /wh1 +https:\/\/a\.test\/hook +response\.created +2026-07-20 10:00/);
  assert.ok(!whList.stdout.includes("secret"), "list must never render a secret");

  resetState();
  const whListJson = await runCli(["webhooks", "list", "f1", "--json"]);
  assert.deepEqual(oneJsonDoc(whListJson), state.webhooksList);

  resetState();
  const whAdd = await runCli([
    "webhooks",
    "add",
    "f1",
    "--url",
    "https://b.test/hook",
    "--include-abandoned",
  ]);
  assert.equal(whAdd.code, 0, whAdd.stderr);
  assert.deepEqual(lastBody(), { url: "https://b.test/hook", includeAbandoned: true });
  assert.ok(whAdd.stdout.includes("whsec_test_shown_once"), "the secret must be printed once");
  assert.match(whAdd.stdout, /store it — Fillo signs deliveries with it, shown only now/);

  resetState();
  const whSet = await runCli(["webhooks", "set", "f1", "wh2", "--include-abandoned=false"]);
  assert.equal(whSet.code, 0, whSet.stderr);
  assert.deepEqual(lastBody(), { includeAbandoned: false });
  assert.deepEqual(requestPaths(), ["PATCH /api/v1/cli/forms/f1/webhooks/wh2"]);

  resetState();
  const whRemoveNoId = await runCli(["webhooks", "remove", "f1"]);
  assert.notEqual(whRemoveNoId.code, 0);
  assert.match(whRemoveNoId.stderr, /Usage: fillo webhooks remove <form> <id>/);
  assert.equal(requests.length, 0, "remove must never guess the webhook id");

  resetState();
  const whRemove = await runCli(["webhooks", "remove", "f1", "wh2"]);
  assert.equal(whRemove.code, 0, whRemove.stderr);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/forms/f1/webhooks/wh2"]);
  assert.match(whRemove.stdout, /Removed webhook wh2/);

  // ================= settings =================
  resetState();
  const setGet = await runCli(["settings", "get", "f1"]);
  assert.equal(setGet.code, 0, setGet.stderr);
  assert.match(setGet.stdout, /notifyEmail +team@acme\.test/);
  assert.match(setGet.stdout, /sendReceipt +true/);
  assert.match(setGet.stdout, /responseLimit +\(unset\)/);

  resetState();
  const setGetJson = await runCli(["settings", "get", "f1", "--json"]);
  assert.deepEqual(oneJsonDoc(setGetJson), { settings: state.settings });

  // set: booleans, a cleared key, and a JSON object value, all in one PATCH.
  resetState();
  const setSet = await runCli([
    "settings",
    "set",
    "f1",
    "sendReceipt=false",
    "resumeUrl=null",
    'responseLimit={"by":"browser","onRepeat":"update"}',
  ]);
  assert.equal(setSet.code, 0, setSet.stderr);
  assert.deepEqual(lastBody(), {
    sendReceipt: false,
    resumeUrl: null,
    responseLimit: { by: "browser", onRepeat: "update" },
  });
  assert.match(setSet.stdout, /Updated sendReceipt, resumeUrl, responseLimit/);

  // Unknown key is rejected locally, before any request leaves.
  resetState();
  const setBadKey = await runCli(["settings", "set", "f1", "bogus=1"]);
  assert.notEqual(setBadKey.code, 0);
  assert.match(setBadKey.stderr, /Unknown setting: bogus/);
  assert.equal(requests.length, 0);

  // A bad boolean value is rejected locally too.
  resetState();
  const setBadBool = await runCli(["settings", "set", "f1", "sendReceipt=maybe"]);
  assert.notEqual(setBadBool.code, 0);
  assert.match(setBadBool.stderr, /sendReceipt=maybe is not valid/);

  // Server 400 → "Invalid settings patch" plus the offending keys we sent.
  resetState({ settingsPatchError: { status: 400, body: { error: "Invalid settings patch" } } });
  const setServer400 = await runCli(["settings", "set", "f1", "notifyEmail=not-an-email"]);
  assert.notEqual(setServer400.code, 0);
  assert.match(setServer400.stderr, /Invalid settings patch/);
  assert.match(setServer400.stderr, /keys sent: notifyEmail/);

  // Server 409 for a code-managed form (everything `fillo push` creates): the
  // server rejects saveProgress/responseLimit/trust, and the CLI passes that
  // reason through, then names the fix — the same next step the --help caveat gives.
  resetState({
    settingsPatchError: {
      status: 409,
      body: {
        error:
          "Save progress, response limits, and the trust policy are controlled by the synced schema.",
      },
    },
  });
  const setCodeManaged = await runCli(["settings", "set", "f1", "saveProgress=true"]);
  assert.notEqual(setCodeManaged.code, 0);
  assert.match(setCodeManaged.stderr, /controlled by the synced schema/);
  assert.match(setCodeManaged.stderr, /Set them in the form schema you `fillo push`, then push again/);

  // `settings --help` marks the schema-controlled keys, drops them from the
  // plain booleans line, and keeps aligned columns (item: help whitespace).
  resetState();
  const settingsHelp = await runCli(["settings"]);
  assert.equal(settingsHelp.code, 0, settingsHelp.stderr);
  assert.match(settingsHelp.stdout, /Controlled by your form schema/);
  assert.match(settingsHelp.stdout, /saveProgress, responseLimit, trust/);
  assert.match(settingsHelp.stdout, /booleans {2,}sendReceipt/);
  assert.doesNotMatch(settingsHelp.stdout, /booleans[^\n]*saveProgress/);

  // ================= members =================
  resetState();
  const membersList = await runCli(["members"]);
  assert.equal(membersList.code, 0, membersList.stderr);
  assert.match(membersList.stdout, /Members/);
  assert.match(membersList.stdout, /owner@acme\.test +Ada Owner +owner +2026-06-01/);
  assert.match(membersList.stdout, /Pending invitations/);
  assert.match(membersList.stdout, /cy@acme\.test +member +2026-08-01 +inv1/);

  resetState();
  const inviteOk = await runCli(["members", "invite", "new@acme.test", "--role", "member"]);
  assert.equal(inviteOk.code, 0, inviteOk.stderr);
  assert.deepEqual(lastBody(), { email: "new@acme.test", role: "member" });
  assert.match(inviteOk.stdout, /Invited new@acme\.test as member — expires 2026-08-10/);

  resetState({
    invite: {
      status: 403,
      body: { error: "You can't invite a member with a higher role than your own." },
    },
  });
  const invite403 = await runCli(["members", "invite", "boss@acme.test", "--role", "admin"]);
  assert.notEqual(invite403.code, 0);
  assert.match(invite403.stderr, /higher role than your own/);

  resetState({
    invite: {
      status: 429,
      body: { error: "Too many invitations sent recently. Try again later." },
    },
  });
  const invite429 = await runCli(["members", "invite", "spam@acme.test"]);
  assert.notEqual(invite429.code, 0);
  assert.match(invite429.stderr, /Too many invitations/);

  resetState();
  const cancelNoId = await runCli(["members", "cancel-invite"]);
  assert.notEqual(cancelNoId.code, 0);
  assert.match(cancelNoId.stderr, /Usage: fillo members cancel-invite <id>/);
  assert.equal(requests.length, 0);

  resetState();
  const cancelOk = await runCli(["members", "cancel-invite", "inv1"]);
  assert.equal(cancelOk.code, 0, cancelOk.stderr);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/members/invites/inv1"]);
  assert.match(cancelOk.stdout, /Cancelled invitation inv1/);

  // ================= delete form =================
  // Interactive prompt: no --confirm, human output, the title piped via stdin.
  resetState();
  const delInteractive = await runCli(["delete", "form", "f1"], {}, "Contact Form\n");
  assert.equal(delInteractive.code, 0, delInteractive.stderr);
  assert.deepEqual(requestPaths(), ["GET /api/v1/cli/forms/f1", "DELETE /api/v1/cli/forms/f1"]);
  assert.deepEqual(lastBody(), { confirm: "Contact Form" });
  assert.match(delInteractive.stdout, /Type its exact title to confirm/);
  assert.match(delInteractive.stdout, /Deleted form f1/);

  // Interactive but the typed title is wrong → local guard, no DELETE call.
  resetState();
  const delMismatchLocal = await runCli(["delete", "form", "f1"], {}, "Wrong Title\n");
  assert.notEqual(delMismatchLocal.code, 0);
  assert.deepEqual(
    requestPaths(),
    ["GET /api/v1/cli/forms/f1"],
    "a local mismatch must not call DELETE",
  );
  assert.match(delMismatchLocal.stderr, /does not match "Contact Form" — nothing was deleted/);

  // Agent (FILLO_AGENT=1), no --confirm → must be told to pass --confirm.
  resetState();
  const delNoConfirm = await runCli(["delete", "form", "f1"], { FILLO_AGENT: "1" });
  assert.notEqual(delNoConfirm.code, 0);
  assert.match(delNoConfirm.stderr, /Refusing to delete without confirmation/);
  assert.match(delNoConfirm.stderr, /--confirm/);
  assert.match(delNoConfirm.stderr, /no confirmation-free delete/);
  assert.equal(requests.length, 0);

  // --confirm with the wrong title → server confirm_mismatch 409, hint surfaced.
  resetState();
  const delServerMismatch = await runCli(["delete", "form", "f1", "--confirm", "Nope"]);
  assert.notEqual(delServerMismatch.code, 0);
  assert.deepEqual(
    requestPaths(),
    ["DELETE /api/v1/cli/forms/f1"],
    "the --confirm path skips the status GET",
  );
  assert.match(delServerMismatch.stderr, /must exactly match the form title "Contact Form"/);

  // Published form → 409 published, told to add --also-unpublish, then it works.
  resetState({ form: { id: "f1", name: "Contact Form", status: "published", slug: "contact" } });
  const delPublished = await runCli(["delete", "form", "f1", "--confirm", "Contact Form"]);
  assert.notEqual(delPublished.code, 0);
  assert.match(delPublished.stderr, /--also-unpublish/);

  resetState({ form: { id: "f1", name: "Contact Form", status: "published", slug: "contact" } });
  const delAlso = await runCli([
    "delete",
    "form",
    "f1",
    "--confirm",
    "Contact Form",
    "--also-unpublish",
  ]);
  assert.equal(delAlso.code, 0, delAlso.stderr);
  assert.deepEqual(lastBody(), { confirm: "Contact Form", alsoUnpublish: true });
  assert.match(delAlso.stdout, /Deleted form f1/);

  // --confirm --json purity.
  resetState();
  const delJson = await runCli(["delete", "form", "f1", "--confirm", "Contact Form", "--json"]);
  assert.equal(delJson.code, 0, delJson.stderr);
  assert.deepEqual(oneJsonDoc(delJson), { id: "f1", deleted: true });

  // A missing form (404): the CLI gives the same `fillo list` guidance the
  // status/publish/responses commands do, not the server's bare "Form not found".
  resetState({ formMissing: true });
  const delMissing = await runCli(["delete", "form", "ghost", "--confirm", "Whatever"]);
  assert.notEqual(delMissing.code, 0);
  assert.match(delMissing.stderr, /No form matches "ghost" in this workspace/);
  assert.match(delMissing.stderr, /fillo list/);
  assert.doesNotMatch(delMissing.stderr, /Form not found/);

  // The interactive lookup 404s with the same guidance before any prompt.
  resetState({ formMissing: true });
  const delMissingInteractive = await runCli(["delete", "form", "ghost"], {}, "");
  assert.notEqual(delMissingInteractive.code, 0);
  assert.match(delMissingInteractive.stderr, /No form matches "ghost" in this workspace/);
  assert.match(delMissingInteractive.stderr, /fillo list/);

  // ================= delete workspace =================
  resetState();
  const wsSchedule = await runCli(["delete", "workspace", "--confirm", "Acme Inc"]);
  assert.equal(wsSchedule.code, 0, wsSchedule.stderr);
  assert.deepEqual(requestPaths(), ["POST /api/v1/cli/workspace/delete-request"]);
  assert.deepEqual(lastBody(), { confirm: "Acme Inc" });
  assert.match(wsSchedule.stdout, /scheduled for deletion on 2026-08-15/);
  assert.match(wsSchedule.stdout, /fillo delete workspace --cancel/);

  resetState();
  const wsCancel = await runCli(["delete", "workspace", "--cancel"]);
  assert.equal(wsCancel.code, 0, wsCancel.stderr);
  assert.deepEqual(requestPaths(), ["DELETE /api/v1/cli/workspace/delete-request"]);
  assert.match(wsCancel.stdout, /cancelled/);

  resetState({ workspaceForce403: true });
  const ws403 = await runCli(["delete", "workspace", "--confirm", "Acme Inc"]);
  assert.notEqual(ws403.code, 0);
  assert.match(ws403.stderr, /Only the workspace owner/);

  // Wrong --confirm → server 409; the CLI names the exact workspace name (the
  // server's own mismatch message doesn't), consistent with the form path.
  resetState();
  const wsMismatch = await runCli(["delete", "workspace", "--confirm", "Wrong Name"]);
  assert.notEqual(wsMismatch.code, 0);
  assert.match(wsMismatch.stderr, /does not match "Acme Inc" — nothing was scheduled/);
  assert.match(wsMismatch.stderr, /Re-run with --confirm "Acme Inc"/);

  resetState();
  const wsScheduleJson = await runCli(["delete", "workspace", "--confirm", "Acme Inc", "--json"]);
  assert.deepEqual(oneJsonDoc(wsScheduleJson), { scheduledPurgeAt: "2026-08-15T00:00:00.000Z" });

  // ================= dispatch / unknown subcommands =================
  resetState();
  for (const [family, bad] of [
    ["storage", "nuke"],
    ["slack", "nuke"],
    ["webhooks", "nuke"],
    ["settings", "nuke"],
    ["members", "nuke"],
    ["delete", "nuke"],
  ]) {
    const unknown = await runCli([family, bad]);
    assert.notEqual(unknown.code, 0, `${family} ${bad} should fail`);
    assert.match(unknown.stderr, new RegExp(`Unknown ${family} command: ${bad}`));
  }

  console.log("storage/slack/webhooks/settings/members/delete checks passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      value += chunk;
    });
    req.on("end", () => resolve(value));
    req.on("error", reject);
  });
}

function writeConfig(config) {
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
}

function runCli(args, extraEnv = {}, input) {
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
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
