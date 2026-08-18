import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageRoot, "dist", "index.js");
const home = mkdtempSync(join(tmpdir(), "fillo-stage-push-"));
const configDir = join(home, ".fillo");
const configPath = join(configDir, "config.json");
const schemaPath = join(home, "contact.json");
const fileRequestPath = join(home, "file-request.json");
const responsePath = join(home, "contact-response.json");
const syncToken = "fsync_test_secret_abcdef";
const accountToken = "fcli_test_account_secret";
const publishableKey = "pk_preview_workspace";
const schema = {
  version: 1,
  title: "Contact",
  pages: [{ id: "main", blocks: [{ id: "email", kind: "email", label: "Email" }] }],
  settings: {},
};
const fileRequestSchema = {
  version: 1,
  title: "Send us your files",
  pages: [
    {
      id: "request",
      blocks: [
        {
          id: "files",
          kind: "file_upload",
          label: "Files",
          required: true,
          maxFiles: 5,
          maxFileSizeMb: 250,
        },
      ],
    },
  ],
  settings: { submitLabel: "Send files" },
};
const requests = [];
let api = "";

mkdirSync(configDir, { recursive: true });
writeFileSync(schemaPath, JSON.stringify(schema));
writeFileSync(
  fileRequestPath,
  JSON.stringify({
    id: "file-request",
    purpose: "file_request",
    storage: "r2",
    schema: fileRequestSchema,
    theme: null,
  }),
);
writeFileSync(responsePath, JSON.stringify({ email: "ada@example.com" }));

const server = createServer(async (req, res) => {
  const rawBody = await readBody(req);
  const body = rawBody ? JSON.parse(rawBody) : {};
  requests.push({ url: req.url, authorization: req.headers.authorization, body });
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/api/v1/forms/sync") {
    if (body.id === "blocked") {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          error: "Public schema changes are disabled.",
          code: "trusted_sync_required",
        }),
      );
      return;
    }
    if (body.id === "soft-blocked") {
      res.end(
        JSON.stringify({
          formId: "form_live",
          status: "published",
          resolvedSchema: schema,
          syncError: {
            code: "trusted_sync_required",
            message: "Use a trusted credential.",
          },
        }),
      );
      return;
    }
    if (body.id === "revoked") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: `Rejected bearer ${syncToken}` }));
      return;
    }
    const trusted = typeof req.headers.authorization === "string";
    res.statusCode = 201;
    res.end(
      JSON.stringify({
        formId: `form_${body.id}`,
        slug: body.id,
        // The immediate-apply preview lane omits `staged` server-side (the CLI
        // normalizes it to a top-level boolean); the trusted lane sends it.
        status: trusted ? "draft" : "published",
        ...(trusted ? { staged: true } : { canPublishFileFields: true }),
        ...(body.id === "uploads"
          ? {
              warning:
                "This form has file upload fields but no storage destination. Connect Google Drive, S3, or Box before publishing.",
              warningCode: "storage_required",
              warningUrl: `${api}/settings/connections`,
            }
          : {}),
        // A preview push that dropped a select defaultValue and over-promised the
        // transit file-size cap carries advisory notices (the push still succeeds).
        ...(body.id === "preview"
          ? {
              notices: [
                'Field "cadence" (select) — dropped unsupported property "defaultValue"; not part of the form schema, so not saved.',
                'Uploads are capped at 10 MB per file on this workspace\'s current storage (Fillo temporary storage), below the 500 MB set on file field "attachment". The effective cap wins — connect your own storage to raise it.',
              ],
            }
          : {}),
      }),
    );
    return;
  }

  if (req.url === "/api/v1/cli/forms" && req.method === "GET") {
    res.end(
      JSON.stringify({
        forms: [
          {
            id: "form_contact",
            name: "Contact",
            slug: "contact",
            status: "published",
            url: `${api}/f/contact`,
          },
        ],
      }),
    );
    return;
  }

  if (req.url === "/api/v1/cli/forms/intake" && req.method === "GET") {
    res.end(
      JSON.stringify({
        form: {
          id: "form_intake",
          name: "Intake",
          slug: "intake",
          status: "draft",
          staged: false,
          url: `${api}/f/intake`,
          warning:
            "This form has file upload fields but no storage destination. Connect Google Drive, S3, or Box before publishing.",
          warningCode: "storage_required",
          warningUrl: `${api}/settings/connections`,
        },
      }),
    );
    return;
  }

  if (req.url === "/api/v1/cli/forms/legacy-status" && req.method === "GET") {
    // An older deployment without GET /cli/forms/[form] serves Next's HTML 404.
    res.setHeader("Content-Type", "text/html");
    res.statusCode = 404;
    res.end("<!DOCTYPE html><html><body>This page could not be found.</body></html>");
    return;
  }

  if (req.url === "/api/v1/cli/forms/legacy-publish/publish" && req.method === "POST") {
    // An older deployment without the publish route serves Next's HTML 404.
    res.setHeader("Content-Type", "text/html");
    res.statusCode = 404;
    res.end("<!DOCTYPE html><html><body>This page could not be found.</body></html>");
    return;
  }

  const publishMatch = req.url?.match(/^\/api\/v1\/cli\/forms\/([^/]+)\/publish$/);
  if (publishMatch && req.method === "POST") {
    const handle = decodeURIComponent(publishMatch[1]);
    const publishedForm = (changed) => ({
      form: {
        id: `form_${handle}`,
        name: "Intake",
        slug: handle,
        status: "published",
        url: `${api}/f/${handle}`,
      },
      changed,
    });
    if (handle === "breaking" && body.allowBreaking !== true) {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error:
            "Publishing would remove or re-type fields that existing responses answered: email, message. Re-run with --allow-breaking to publish anyway.",
          code: "breaking_changes",
          breakingFields: ["email", "message"],
        }),
      );
      return;
    }
    if (handle === "storage-blocked") {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error: "Connect a storage destination before publishing this form.",
          warningCode: "storage_required",
          warningUrl: `${api}/settings/connections`,
        }),
      );
      return;
    }
    if (handle === "already-live") {
      res.end(JSON.stringify(publishedForm(false)));
      return;
    }
    if (handle === "nope") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Form not found" }));
      return;
    }
    res.end(JSON.stringify(publishedForm(true)));
    return;
  }

  if (req.url === "/api/v1/cli/forms/legacy-test/test-response" && req.method === "POST") {
    res.setHeader("Content-Type", "text/html");
    res.statusCode = 404;
    res.end("<!DOCTYPE html><html><body>This page could not be found.</body></html>");
    return;
  }

  const testResponseMatch = req.url?.match(/^\/api\/v1\/cli\/forms\/([^/]+)\/test-response$/);
  if (testResponseMatch && req.method === "POST") {
    const handle = decodeURIComponent(testResponseMatch[1]);
    if (handle === "invalid-preview") {
      res.statusCode = 422;
      res.end(JSON.stringify({ errors: { email: "Enter a valid email" } }));
      return;
    }
    if (handle === "preview-cap") {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error: "This form already has 50 preview responses.",
          code: "preview_response_cap",
          limit: 50,
        }),
      );
      return;
    }
    if (handle === "nope") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Form not found" }));
      return;
    }
    res.statusCode = 201;
    res.end(
      JSON.stringify({
        id: `preview_${handle}`,
        preview: true,
        schema: "staged",
        expiresAt: "2026-07-24T12:00:00.000Z",
      }),
    );
    return;
  }

  if (req.url === "/api/v1/cli/forms" && body.handle === "storage-blocked") {
    res.statusCode = 409;
    res.end(
      JSON.stringify({
        error: "Connect a storage destination before publishing this form.",
        warningCode: "storage_required",
        warningUrl: `${api}/settings/connections`,
      }),
    );
    return;
  }

  if (req.url === "/api/v1/cli/forms") {
    // The account direct-publish lane now returns the full lifecycle envelope
    // so `push --json` needs no second `status` round-trip.
    const fileRequestDraft = body.purpose === "file_request";
    res.end(
      JSON.stringify({
        formId: fileRequestDraft ? "form_file_request" : "form_direct",
        slug: fileRequestDraft ? "file-request" : "direct",
        url: `${api}/f/${fileRequestDraft ? "file-request" : "direct"}`,
        updated: false,
        status: fileRequestDraft ? "draft" : "published",
        staged: false,
        accepting: !fileRequestDraft,
        uploadsAvailable: true,
        canPublishFileFields: true,
      }),
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  api = `http://127.0.0.1:${address.port}`;
  // A CI sync token is self-contained. An unrelated local login, including one
  // bound to another Fillo deployment, must not block or receive this request.
  writeConfig({ token: accountToken, tokenApi: "https://other.example" });

  const stagedFromStdin = await runCli(
    ["push", "-", "--handle", "contact", "--stage"],
    JSON.stringify(schema),
    { FILLO_SYNC_TOKEN: syncToken },
  );
  assert.equal(stagedFromStdin.code, 0, stagedFromStdin.stderr);
  assert.equal(requests[0].url, "/api/v1/forms/sync");
  assert.equal(requests[0].authorization, `Bearer ${syncToken}`);
  assert.equal(requests[0].body.key, undefined);
  assert.equal(requests[0].body.id, "contact");
  assert.deepEqual(requests[0].body.schema, schema);
  assert.match(stagedFromStdin.stdout, /Draft ready/);
  // Terminal-native publish is named first; the dashboard is the alternative.
  assert.match(stagedFromStdin.stdout, /Publish: fillo publish form_contact/);
  assert.doesNotMatch(stagedFromStdin.stdout, /Review and publish it from the Fillo dashboard/);
  assert.doesNotMatch(output(stagedFromStdin), new RegExp(syncToken));

  const missingStage = await runCli(["push", schemaPath, "--handle", "contact"], undefined, {
    FILLO_SYNC_TOKEN: syncToken,
  });
  assert.notEqual(missingStage.code, 0);
  assert.match(missingStage.stderr, /can only stage changes.*Add --stage/i);
  assert.equal(requests.length, 1, "a stage-only token must never reach a publishing endpoint");
  assert.doesNotMatch(output(missingStage), new RegExp(syncToken));

  writeConfig({ token: accountToken, tokenApi: api });
  const draftAlias = await runCli(["push", schemaPath, "--handle", "onboarding", "--draft"]);
  assert.equal(draftAlias.code, 0, draftAlias.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/forms/sync");
  assert.equal(requests.at(-1).authorization, `Bearer ${accountToken}`);
  assert.equal(requests.at(-1).body.key, undefined);
  assert.doesNotMatch(output(draftAlias), new RegExp(accountToken));

  const stagedFileRequest = await runCli(["push", fileRequestPath, "--stage"]);
  assert.equal(stagedFileRequest.code, 0, stagedFileRequest.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/forms/sync");
  assert.equal(requests.at(-1).body.id, "file-request");
  assert.equal(requests.at(-1).body.storage, "r2");
  assert.equal(requests.at(-1).body.purpose, "file_request");
  assert.deepEqual(requests.at(-1).body.schema, fileRequestSchema);

  // A staged push whose response carries the storage warning prints the
  // warning and its settings deep-link.
  const stagedUploads = await runCli(["push", schemaPath, "--handle", "uploads", "--stage"]);
  assert.equal(stagedUploads.code, 0, stagedUploads.stderr);
  assert.match(stagedUploads.stdout, /Before publishing:/);
  assert(
    stagedUploads.stdout.includes(`Storage settings: ${api}/settings/connections`),
    stagedUploads.stdout,
  );

  // `fillo list` shows each form's live URL.
  const listed = await runCli(["list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /Contact/);
  assert(listed.stdout.includes(`${api}/f/contact`), listed.stdout);

  // `fillo status` shows one form's state plus the storage warning + deep-link.
  const intakeStatus = await runCli(["status", "intake"]);
  assert.equal(intakeStatus.code, 0, intakeStatus.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms/intake");
  assert.match(intakeStatus.stdout, /Status:.*draft/);
  assert(intakeStatus.stdout.includes(`Publishes to ${api}/f/intake`), intakeStatus.stdout);
  assert.match(intakeStatus.stdout, /Before publishing:/);
  assert(
    intakeStatus.stdout.includes(`Storage settings: ${api}/settings/connections`),
    intakeStatus.stdout,
  );

  const missingStatus = await runCli(["status", "nope"]);
  assert.notEqual(missingStatus.code, 0);
  assert.match(missingStatus.stderr, /No form matches "nope"/);

  // Against an older server without GET /cli/forms/[form] (HTML 404), status
  // explains the missing endpoint instead of claiming the form doesn't exist.
  const legacyStatus = await runCli(["status", "legacy-status"]);
  assert.notEqual(legacyStatus.code, 0);
  assert.match(legacyStatus.stderr, /does not support `fillo status` yet/);
  assert.doesNotMatch(legacyStatus.stderr, /No form matches/);

  const oneOffDraft = await runCli(["push", schemaPath, "--draft"]);
  assert.equal(oneOffDraft.code, 0, oneOffDraft.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms");
  assert.equal(requests.at(-1).authorization, `Bearer ${accountToken}`);
  assert.equal(requests.at(-1).body.handle, undefined);
  assert.equal(requests.at(-1).body.publish, false);
  assert.match(oneOffDraft.stdout, /Created draft/);
  // The one-off draft is publishable from the terminal, dashboard as fallback.
  assert.match(oneOffDraft.stdout, /Publish: fillo publish form_direct/);
  assert.doesNotMatch(oneOffDraft.stdout, /Review and publish it from the Fillo dashboard/);

  const directPublish = await runCli(["push", schemaPath, "--handle", "direct"]);
  assert.equal(directPublish.code, 0, directPublish.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms");
  assert.equal(requests.at(-1).authorization, `Bearer ${accountToken}`);
  assert.equal(requests.at(-1).body.publish, true);

  const directFileRequestDraft = await runCli(["push", fileRequestPath]);
  assert.equal(directFileRequestDraft.code, 0, directFileRequestDraft.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms");
  assert.equal(requests.at(-1).body.purpose, "file_request");
  assert.match(directFileRequestDraft.stdout, /Created draft/);
  assert.match(directFileRequestDraft.stdout, /Publish: fillo publish form_file_request/);
  assert.doesNotMatch(directFileRequestDraft.stdout, /Live at/);

  const directFileRequestDraftJson = await runCli(["push", fileRequestPath, "--json"]);
  assert.equal(directFileRequestDraftJson.code, 0, directFileRequestDraftJson.stderr);
  const directFileRequestForm = JSON.parse(
    directFileRequestDraftJson.stdout.split("\n").filter(Boolean)[0],
  ).forms[0];
  assert.equal(directFileRequestForm.formId, "form_file_request");
  assert.equal(directFileRequestForm.status, "draft");
  assert.match(directFileRequestDraftJson.stderr, /"draft":true/);
  assert.doesNotMatch(directFileRequestDraftJson.stderr, /"published":true/);

  // `push --json` forwards the server's whole lifecycle envelope in one
  // round-trip — status/staged/accepting/uploadsAvailable/canPublishFileFields —
  // instead of just {formId, slug, url}. No second `status` call needed.
  const directPublishJson = await runCli(["push", schemaPath, "--handle", "direct", "--json"]);
  assert.equal(directPublishJson.code, 0, directPublishJson.stderr);
  const pushLines = directPublishJson.stdout.split("\n").filter(Boolean);
  assert.equal(
    pushLines.length,
    1,
    `push --json stdout must be one JSON line:\n${directPublishJson.stdout}`,
  );
  const pushForm = JSON.parse(pushLines[0]).forms[0];
  assert.equal(pushForm.formId, "form_direct");
  assert.equal(pushForm.status, "published");
  assert.equal(pushForm.staged, false);
  assert.equal(pushForm.accepting, true);
  assert.equal(pushForm.uploadsAvailable, true);
  assert.equal(pushForm.canPublishFileFields, true);

  // A direct publish blocked on storage (409) fails non-zero and surfaces the
  // settings deep-link the server sends alongside the error.
  const storageBlockedPublish = await runCli(["push", schemaPath, "--handle", "storage-blocked"]);
  assert.notEqual(storageBlockedPublish.code, 0);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms");
  assert.match(storageBlockedPublish.stderr, /storage destination/i);
  assert(
    storageBlockedPublish.stderr.includes(`Storage settings: ${api}/settings/connections`),
    output(storageBlockedPublish),
  );
  assert.doesNotMatch(storageBlockedPublish.stdout, /✓|Live at/);

  // `fillo publish` promotes staged changes and prints the live URL.
  const published = await runCli(["publish", "intake"]);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms/intake/publish");
  assert.equal(requests.at(-1).authorization, `Bearer ${accountToken}`);
  assert.deepEqual(requests.at(-1).body, {});
  assert.match(published.stdout, /Published/);
  assert(published.stdout.includes(`Live at ${api}/f/intake`), published.stdout);

  // Nothing staged and already live is an idempotent success, not an error.
  const alreadyLive = await runCli(["publish", "already-live"]);
  assert.equal(alreadyLive.code, 0, alreadyLive.stderr);
  assert.match(alreadyLive.stdout, /already live/);
  assert(alreadyLive.stdout.includes(`Live at ${api}/f/already-live`), alreadyLive.stdout);

  // A destructive staged diff over real responses refuses until the caller
  // acknowledges with --allow-breaking, and names the affected fields.
  const breakingRefused = await runCli(["publish", "breaking"]);
  assert.notEqual(breakingRefused.code, 0);
  assert.match(breakingRefused.stderr, /remove or re-type/i);
  assert.match(breakingRefused.stderr, /email, message/);
  assert.match(breakingRefused.stderr, /--allow-breaking/);
  assert.doesNotMatch(breakingRefused.stdout, /✓|Live at/);

  const breakingConfirmed = await runCli(["publish", "breaking", "--allow-breaking"]);
  assert.equal(breakingConfirmed.code, 0, breakingConfirmed.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms/breaking/publish");
  assert.equal(requests.at(-1).body.allowBreaking, true);
  assert.match(breakingConfirmed.stdout, /Published/);

  // A storage-blocked publish (409) surfaces the settings deep-link.
  const storageBlockedPublishCmd = await runCli(["publish", "storage-blocked"]);
  assert.notEqual(storageBlockedPublishCmd.code, 0);
  assert.match(storageBlockedPublishCmd.stderr, /storage destination/i);
  assert(
    storageBlockedPublishCmd.stderr.includes(`Storage settings: ${api}/settings/connections`),
    output(storageBlockedPublishCmd),
  );

  const missingPublish = await runCli(["publish", "nope"]);
  assert.notEqual(missingPublish.code, 0);
  assert.match(missingPublish.stderr, /No form matches "nope"/);

  // Against an older server without the publish route (HTML 404), publish
  // explains the missing endpoint instead of claiming the form doesn't exist.
  const legacyPublish = await runCli(["publish", "legacy-publish"]);
  assert.notEqual(legacyPublish.code, 0);
  assert.match(legacyPublish.stderr, /does not support `fillo publish` yet/);
  assert.doesNotMatch(legacyPublish.stderr, /No form matches/);

  // `fillo test-response` sends answer data only through the private CLI lane,
  // reports server validation precisely, and never claims it was a real submit.
  const tested = await runCli(["test-response", "intake", responsePath]);
  assert.equal(tested.code, 0, tested.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms/intake/test-response");
  assert.equal(requests.at(-1).authorization, `Bearer ${accountToken}`);
  assert.deepEqual(requests.at(-1).body, { data: { email: "ada@example.com" } });
  assert.match(tested.stdout, /Test response passed/);
  assert.match(tested.stdout, /Preview only/);
  assert.doesNotMatch(tested.stdout, /submitted|delivered/i);

  const testedFromStdin = await runCli(
    ["test-response", "intake", "-"],
    JSON.stringify({ email: "grace@example.com" }),
  );
  assert.equal(testedFromStdin.code, 0, testedFromStdin.stderr);
  assert.deepEqual(requests.at(-1).body, { data: { email: "grace@example.com" } });

  const invalidPreview = await runCli(["test-response", "invalid-preview", responsePath]);
  assert.notEqual(invalidPreview.code, 0);
  assert.match(invalidPreview.stderr, /failed server validation/i);
  assert.match(invalidPreview.stderr, /email: Enter a valid email/);

  const cappedPreview = await runCli(["test-response", "preview-cap", responsePath]);
  assert.notEqual(cappedPreview.code, 0);
  assert.match(cappedPreview.stderr, /50 preview responses/i);

  const missingPreviewForm = await runCli(["test-response", "nope", responsePath]);
  assert.notEqual(missingPreviewForm.code, 0);
  assert.match(missingPreviewForm.stderr, /No form matches "nope"/);

  const legacyTest = await runCli(["test-response", "legacy-test", responsePath]);
  assert.notEqual(legacyTest.code, 0);
  assert.match(legacyTest.stderr, /does not support `fillo test-response` yet/);
  assert.doesNotMatch(legacyTest.stderr, /No form matches/);

  writeConfig({ pk: publishableKey });

  // Publishing needs an account credential — a publishable key can't.
  const publishWithoutLogin = await runCli(["publish", "intake"]);
  assert.notEqual(publishWithoutLogin.code, 0);
  assert.match(publishWithoutLogin.stderr, /Not logged in/);

  const previewWithoutLogin = await runCli(["test-response", "intake", responsePath]);
  assert.notEqual(previewWithoutLogin.code, 0);
  assert.match(previewWithoutLogin.stderr, /Not logged in/);
  // Refused locally — the answer data never reaches the server.
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms/legacy-test/test-response");

  const misleadingPreviewStage = await runCli([
    "push",
    schemaPath,
    "--handle",
    "preview",
    "--stage",
  ]);
  assert.notEqual(misleadingPreviewStage.code, 0);
  assert.match(misleadingPreviewStage.stderr, /unclaimed preview.*applies changes immediately/i);
  // Refused locally — the last request on the wire is still the legacy check.
  assert.equal(requests.at(-1).url, "/api/v1/cli/forms/legacy-test/test-response");

  const previewPush = await runCli(["push", schemaPath, "--handle", "preview"]);
  assert.equal(previewPush.code, 0, previewPush.stderr);
  assert.equal(requests.at(-1).url, "/api/v1/forms/sync");
  assert.equal(requests.at(-1).authorization, undefined);
  assert.equal(requests.at(-1).body.key, publishableKey);
  assert.match(previewPush.stdout, /Live at/);
  // Advisory notices print un-dimmed on the human output — impossible to miss.
  assert.match(previewPush.stdout, /Note: Field "cadence" \(select\).*"defaultValue"/);
  assert.match(previewPush.stdout, /Note: Uploads are capped at 10 MB.*effective cap wins/);

  // Preview `push --json` forwards the whole lifecycle: a top-level `staged`
  // boolean (normalized even though the server omits it here),
  // `canPublishFileFields`, and the advisory `notices`.
  const previewPushJson = await runCli(["push", schemaPath, "--handle", "preview", "--json"]);
  assert.equal(previewPushJson.code, 0, previewPushJson.stderr);
  const previewLines = previewPushJson.stdout.split("\n").filter(Boolean);
  assert.equal(
    previewLines.length,
    1,
    `preview push --json must be one JSON line:\n${previewPushJson.stdout}`,
  );
  const previewForm = JSON.parse(previewLines[0]).forms[0];
  assert.equal(previewForm.formId, "form_preview");
  assert.equal(previewForm.staged, false, "the immediate-apply preview normalizes staged to false");
  assert.equal(previewForm.canPublishFileFields, true);
  assert.ok(
    Array.isArray(previewForm.notices) && previewForm.notices.length === 2,
    "notices are forwarded",
  );

  const blockedPublicPush = await runCli(["push", schemaPath, "--handle", "blocked"]);
  assert.notEqual(blockedPublicPush.code, 0);
  assert.match(blockedPublicPush.stderr, /authenticated CLI or sync token/i);
  assert.match(blockedPublicPush.stderr, /--stage/);

  const softBlockedPublicPush = await runCli(["push", schemaPath, "--handle", "soft-blocked"]);
  assert.notEqual(softBlockedPublicPush.code, 0);
  assert.match(softBlockedPublicPush.stderr, /authenticated CLI or sync token/i);
  assert.doesNotMatch(softBlockedPublicPush.stdout, /✓|Synced|Live at/);

  const revokedToken = await runCli(
    ["push", schemaPath, "--handle", "revoked", "--stage"],
    undefined,
    { FILLO_SYNC_TOKEN: syncToken },
  );
  assert.notEqual(revokedToken.code, 0);
  assert.match(revokedToken.stderr, /Create a replacement in Settings > Developers/i);
  assert.doesNotMatch(output(revokedToken), new RegExp(syncToken));

  console.log("trusted stage push checks passed");
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

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function runCli(args, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      FILLO_API: api,
      HOME: home,
      USERPROFILE: home,
      ...extraEnv,
    };
    if (!("FILLO_SYNC_TOKEN" in extraEnv)) delete env.FILLO_SYNC_TOKEN;
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
