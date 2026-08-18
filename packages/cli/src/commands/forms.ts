import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateFormSchema } from "@usefillo/core";
import { API, api, readJson, requireToken, SYNC_TOKEN_ENV } from "../lib/api.js";
import { readConfig } from "../lib/config.js";
import type { Flags } from "../lib/flags.js";
import {
  ansiEnabled,
  bold,
  die,
  dim,
  emitProgress,
  emitResult,
  failMark,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

const MAX_STDIN_SCHEMA_BYTES = 1024 * 1024;

async function list(flags: Flags) {
  const res = await api("/cli/forms", { token: requireToken() });
  if (!res.ok) die(`list failed (${res.status}).`);
  const body = (await readJson(res)) as {
    forms: Array<{ id: string; name: string; status: string; url: string }>;
  };
  if (jsonMode(flags)) return emitResult(body);
  const { forms } = body;
  if (!forms.length) return console.log("  No forms yet.");
  for (const f of forms) {
    console.log(
      `  ${f.status === "published" ? liveDot() : "○"} ${terminalText(f.name)}  ${dim(f.id)}  ${dim(f.url)}`,
    );
  }
}

const liveDot = () => (ansiEnabled() ? "\x1b[32m●\x1b[0m" : "●");

async function status(handle: string | undefined, flags: Flags) {
  if (!handle) die("Usage: fillo status <formId|handle>");
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}`, { token: requireToken() });
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 404) {
    // The real route always 404s with a JSON error body; an older deployment
    // without GET /cli/forms/[form] serves Next's HTML 404 instead. Don't read
    // that as "the form doesn't exist".
    try {
      JSON.parse(await res.text());
    } catch {
      die(
        "This Fillo server does not support `fillo status` yet. " +
          "Update the deployment, or check the form in the dashboard.",
      );
    }
    die(`No form matches "${handle}" in this workspace. Run \`fillo list\` to see its forms.`);
  }
  const body = (await readJson(res)) as {
    form?: {
      id: string;
      name: string;
      status: "draft" | "published";
      staged?: boolean;
      url: string;
      warning?: string;
      warningCode?: string;
      warningUrl?: string;
    };
    error?: string;
  };
  if (!res.ok || !body.form) die(body.error ?? `status failed (${res.status}).`);
  if (jsonMode(flags)) return emitResult(body);
  const form = body.form;
  console.log(
    `  ${form.status === "published" ? liveDot() : "○"} ${terminalText(form.name)}  ${dim(form.id)}`,
  );
  console.log(`  Status: ${bold(form.staged ? "staged" : form.status)}`);
  if (form.status === "published") console.log(`  Live at ${terminalText(form.url)}`);
  else console.log(`  ${dim(`Publishes to ${form.url}`)}`);
  if (form.staged) {
    console.log(`  ${dim("Staged changes are waiting for review in the Fillo dashboard.")}`);
  }
  if (form.warning) {
    const pending = form.status !== "published" || form.staged === true;
    console.log(`  ${dim(pending ? `Before publishing: ${form.warning}` : form.warning)}`);
  }
  if (form.warningUrl) console.log(`  Storage settings: ${terminalText(form.warningUrl)}`);
}

async function publish(handle: string | undefined, flags: Flags) {
  if (!handle) die("Usage: fillo publish <formId|handle> [--allow-breaking]");
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}/publish`, {
    method: "POST",
    token: requireToken(),
    body: JSON.stringify(flags["allow-breaking"] === true ? { allowBreaking: true } : {}),
  });
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 404) {
    // Same older-deployment guard as `fillo status`: a server without the
    // publish route serves Next's HTML 404 — don't read that as "no form".
    try {
      JSON.parse(await res.text());
    } catch {
      die(
        "This Fillo server does not support `fillo publish` yet. " +
          "Update the deployment, or publish the form from the dashboard.",
      );
    }
    die(`No form matches "${handle}" in this workspace. Run \`fillo list\` to see its forms.`);
  }
  const body = (await readJson(res)) as {
    form?: { id: string; name: string; slug: string; status: "published"; url: string };
    changed?: boolean;
    error?: string;
    code?: string;
    breakingFields?: string[];
    warningUrl?: string;
  };
  if (res.status === 409 && body.code === "breaking_changes") {
    // Even on failure, --json keeps its contract: the server's structured
    // refusal is the one JSON document on stdout; the explanation stays human.
    if (jsonMode(flags)) emitResult(body);
    const fields = Array.isArray(body.breakingFields)
      ? body.breakingFields.filter((f): f is string => typeof f === "string")
      : [];
    console.error(
      `${failMark()} Not published — the staged changes remove or re-type fields that existing responses answered.`,
    );
    if (fields.length) console.error(`  Fields: ${terminalText(fields.join(", "))}`);
    console.error(
      `  ${dim("Recorded answers are kept, but the live form, grid, and exports stop showing these fields.")}`,
    );
    console.error("  Re-run with --allow-breaking to publish anyway.");
    process.exit(1);
  }
  if (res.status === 409 && typeof body.warningUrl === "string" && body.warningUrl) {
    if (jsonMode(flags)) emitResult(body);
    // A storage-blocked publish carries the same settings deep-link as push.
    console.error(`${failMark()} ${terminalText(body.error ?? `publish failed (${res.status}).`)}`);
    console.error(`  Storage settings: ${terminalText(body.warningUrl)}`);
    process.exit(1);
  }
  if (!res.ok || !body.form) die(body.error ?? `publish failed (${res.status}).`);
  if (jsonMode(flags)) return emitResult(body);
  const form = body.form;
  if (body.changed === false) {
    console.log(
      `\n  ${okMark()} ${bold(terminalText(form.name))} is already live — nothing staged to publish.`,
    );
  } else {
    console.log(`\n  ${okMark()} Published ${bold(terminalText(form.name))}  ${dim(form.id)}`);
  }
  console.log(`  Live at ${terminalText(form.url)}\n`);
}

async function loadResponseData(file: string): Promise<Record<string, unknown>> {
  let value: unknown;
  if (file === "-") {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_STDIN_SCHEMA_BYTES) {
          die("The response data on stdin is too large (maximum 1 MB).");
        }
        chunks.push(buffer);
      }
      const input = Buffer.concat(chunks).toString("utf8");
      if (!input.trim()) {
        die("stdin is empty — pipe one JSON answer object to `fillo test-response <form> -`.");
      }
      value = JSON.parse(input);
    } catch (error) {
      die(`Couldn't read response data from stdin: ${(error as Error).message}`);
    }
  } else {
    const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
    if (!abs.endsWith(".json")) {
      die("Test response data must be a .json file (or - for JSON on stdin).");
    }
    try {
      value = JSON.parse(readFileSync(abs, "utf8"));
    } catch (error) {
      die(`Couldn't read ${file}: ${(error as Error).message}`);
    }
  }
  if (!isRecord(value)) {
    die("Test response data must be one JSON object keyed by field id.");
  }
  return value;
}

async function testResponse(handle: string | undefined, file: string | undefined) {
  if (!handle || !file) {
    die("Usage: fillo test-response <formId|handle> <answers.json|->");
  }
  // Resolve the private account credential before touching stdin. A
  // publishable-key-only setup must fail locally and never send answer data.
  const token = requireToken();
  const data = await loadResponseData(file);
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}/test-response`, {
    method: "POST",
    token,
    body: JSON.stringify({ data }),
  });
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 404) {
    try {
      JSON.parse(await res.text());
    } catch {
      die(
        "This Fillo server does not support `fillo test-response` yet. " +
          "Update the deployment, then retry.",
      );
    }
    die(`No form matches "${handle}" in this workspace. Run \`fillo list\` to see its forms.`);
  }
  const body = (await readJson(res)) as {
    id?: string;
    preview?: boolean;
    schema?: "staged" | "published";
    expiresAt?: string;
    errors?: Record<string, string>;
    error?: string;
    code?: string;
  };
  if (res.status === 422 && body.errors && typeof body.errors === "object") {
    console.error(`${failMark()} Test response failed server validation.`);
    for (const [field, message] of Object.entries(body.errors)) {
      console.error(`  ${terminalText(field)}: ${terminalText(message)}`);
    }
    process.exit(1);
  }
  if (!res.ok || !body.id || body.preview !== true) {
    die(body.error ?? `test response failed (${res.status}).`);
  }
  console.log(
    `\n  ${okMark()} Test response passed the ${bold(body.schema ?? "current")} schema  ${dim(body.id)}`,
  );
  console.log(
    `  ${dim("Preview only — excluded from responses, limits, delivery, and analytics; auto-deletes after 7 days.")}\n`,
  );
}

async function loadSchema(file: string, allowCode: boolean): Promise<unknown> {
  if (file === "-") {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_STDIN_SCHEMA_BYTES) {
          die("The schema on stdin is too large (maximum 1 MB).");
        }
        chunks.push(buffer);
      }
      const input = Buffer.concat(chunks).toString("utf8");
      if (!input.trim()) die("stdin is empty — pipe one JSON form schema to `fillo push -`.");
      const parsed = JSON.parse(input);
      if (parsed == null) die("stdin must contain a form schema.");
      return parsed;
    } catch (error) {
      die(`Couldn't read the schema from stdin: ${(error as Error).message}`);
    }
  }
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
  // A non-JSON schema is a code module: importing it RUNS the file. Don't do
  // that implicitly — an agent or teammate's form.mjs would get silent code
  // execution. JSON is safe and the default; modules need explicit opt-in.
  if (!abs.endsWith(".json") && !allowCode) {
    die(
      `${file} is a code module — pushing it executes the file. Re-run with ` +
        `--allow-code if you trust it, or push a .json schema instead.`,
    );
  }
  try {
    if (abs.endsWith(".json")) {
      const parsed = JSON.parse(readFileSync(abs, "utf8"));
      if (parsed == null) die(`${file} is empty — it must contain a form schema.`);
      return parsed;
    }
    const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    const schema = mod.default ?? mod.schema ?? mod.form ?? mod.forms ?? mod.MARKETING_FORMS;
    if (schema == null) {
      die(
        `${file} doesn't export a form schema — default-export it (or export ` +
          `\`schema\`/\`form\`/\`forms\`) and push again.`,
      );
    }
    return schema;
  } catch (e) {
    die(`Couldn't read ${file}: ${(e as Error).message}`);
  }
}

type PushItem = {
  handle?: string;
  schema: unknown;
  theme?: unknown;
  storage?: "gdrive" | "box" | "s3" | "r2";
  purpose?: "file_request";
};

const PUSH_STORAGE_VALUES = new Set(["gdrive", "box", "s3", "r2"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPushItems(value: unknown, handle?: string): PushItem[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) die("The schema file contains no forms to push.");
  return values.map((item, index) => {
    if (isRecord(item) && "schema" in item) {
      const ownHandle = typeof item.id === "string" ? item.id : undefined;
      if (item.storage !== undefined && !PUSH_STORAGE_VALUES.has(String(item.storage))) {
        die(`Item ${index + 1} has an unsupported storage destination.`);
      }
      if (item.purpose !== undefined && item.purpose !== "file_request") {
        die(`Item ${index + 1} has an unsupported form purpose.`);
      }
      return {
        handle: handle ?? ownHandle,
        schema: item.schema,
        theme: item.theme,
        ...(typeof item.storage === "string"
          ? { storage: item.storage as PushItem["storage"] }
          : {}),
        ...(item.purpose === "file_request" ? { purpose: item.purpose } : {}),
      };
    }
    if (values.length > 1 && !handle) {
      die(`Item ${index + 1} needs an id or --handle.`);
    }
    return { handle, schema: item };
  });
}

/**
 * Advisory, non-blocking heads-up lines from the server (dropped field
 * properties, a declared per-file size the storage lane will override). The
 * push still SUCCEEDED — these must be impossible to miss, so they print
 * un-dimmed with a bold marker rather than as a faint aside.
 */
function printNotices(notices: string[] | undefined) {
  if (!Array.isArray(notices)) return;
  for (const notice of notices) {
    if (typeof notice === "string" && notice.trim()) {
      console.log(`  ${bold("Note:")} ${terminalText(notice)}`);
    }
  }
}

function printPushed(
  formId: string,
  url: string | undefined,
  updated: boolean,
  draft = false,
  storage: { warning?: string; warningUrl?: string; notices?: string[] } = {},
) {
  const label = draft ? "Created draft" : updated ? "Updated" : "Created";
  console.log(`\n  ${okMark()} ${label} ${bold(formId)}`);
  if (draft) {
    // Terminal-native first: publishing is one command away, no dashboard trip.
    console.log(
      `  ${bold("Publish:")} fillo publish ${terminalText(formId)}   ${dim("(or publish it from the Fillo dashboard)")}`,
    );
  } else if (url) console.log(`  Live at ${terminalText(url)}`);
  // A draft with file fields but no ready destination carries the same storage
  // heads-up + settings deep-link the staged (sync) lane prints.
  if (storage.warning) console.log(`  ${dim(`Before publishing: ${storage.warning}`)}`);
  if (storage.warningUrl) console.log(`  Storage settings: ${terminalText(storage.warningUrl)}`);
  printNotices(storage.notices);
  console.log(`  Embed:  <FilloForm formId="${terminalText(formId)}" />\n`);
  console.log(`  Verify: [data-fillo-form-id="${terminalText(formId)}"] on the actual app route\n`);
}

type SyncPushResult = {
  formId?: string;
  slug?: string;
  status?: "draft" | "published";
  staged?: boolean;
  warning?: string;
  warningCode?: string;
  warningUrl?: string;
  /** Workspace-level pre-authoring uploads signal, forwarded from the server on
   *  the preview push lane. Absent on older servers / browser callers. */
  canPublishFileFields?: boolean;
  /** Advisory, non-blocking heads-up lines (dropped field properties, a
   *  declared per-file size the storage lane will override). */
  notices?: string[];
  error?: string;
  code?: string;
  syncError?: { code?: string; message?: string };
};

type SyncCredential = "account" | "sync_token" | "publishable_key";

function syncError(response: Response, body: SyncPushResult, credential: SyncCredential): string {
  const code = body.syncError?.code ?? body.code;
  const serverMessage = body.syncError?.message ?? body.error;
  if (code === "trusted_sync_required") {
    return (
      "This workspace accepts schema changes only from an authenticated CLI or sync token. " +
      "Run `fillo login`, then retry with `fillo push <file> --handle <id> --stage`, " +
      `or set ${SYNC_TOKEN_ENV} from Settings > Developers.`
    );
  }
  if (response.status === 401 && credential === "sync_token") {
    return (
      `${SYNC_TOKEN_ENV} was rejected. Create a replacement in Settings > Developers, ` +
      "update the CI secret, and retry."
    );
  }
  if (response.status === 401 && credential === "account") {
    return "Your CLI login was rejected. Run `fillo login` again, then retry the staged push.";
  }
  return serverMessage ?? `push failed (${response.status}).`;
}

function readSyncToken(): string | undefined {
  const raw = process.env[SYNC_TOKEN_ENV];
  if (raw === undefined) return undefined;
  const token = raw.trim();
  if (!token.startsWith("fsync_") || token.length < 16 || token.length > 512 || /\s/.test(token)) {
    die(`${SYNC_TOKEN_ENV} must contain a valid fsync_ token from Settings > Developers.`);
  }
  return token;
}

function requireStableHandle(item: PushItem): string {
  if (item.handle) return item.handle;
  die("Staging needs a stable form id. Add --handle <name> or an id beside schema in the input.");
}

function printSynced(body: SyncPushResult, requestedStage: boolean) {
  const formId = body.formId!;
  const changed = body.staged === true || body.status === "draft";
  const label = changed
    ? body.status === "draft"
      ? "Draft ready"
      : "Staged changes"
    : requestedStage
      ? "Checked"
      : "Synced";
  console.log(`\n  ${okMark()} ${label} for ${bold(formId)}`);
  if (changed) {
    // Publishing is terminal-native: name the command first, dashboard second.
    console.log(
      `  ${bold("Publish:")} fillo publish ${terminalText(formId)}   ${dim("(or review it first in the Fillo dashboard)")}`,
    );
  } else if (requestedStage && body.status === "published") {
    console.log(`  ${dim("Nothing to stage — the published version already matches.")}`);
  } else if (body.slug) {
    console.log(`  Live at ${terminalText(`${API}/f/${body.slug}`)}`);
  }
  if (body.warning) console.log(`  ${dim(`Before publishing: ${body.warning}`)}`);
  if (body.warningUrl) console.log(`  Storage settings: ${terminalText(body.warningUrl)}`);
  printNotices(body.notices);
  console.log(`  Embed:  <FilloForm formId="${terminalText(formId)}" />\n`);
  console.log(`  Verify: [data-fillo-form-id="${terminalText(formId)}"] on the actual app route\n`);
}

async function pushWithSync(
  items: PushItem[],
  credential: { kind: SyncCredential; token?: string; key?: string },
  requestedStage: boolean,
  results?: unknown[],
) {
  for (const item of items) {
    const handle = requireStableHandle(item);
    // Catch a malformed schema locally with the same core validator the server
    // runs, so a broken form fails fast and clearly instead of after a network
    // round-trip that just returns the same 400.
    const validation = validateFormSchema(item.schema);
    if (!validation.ok) {
      die(`Invalid schema for "${handle}" — ${validation.error ?? "schema is not valid"}`);
    }
    const res = await api("/forms/sync", {
      method: "POST",
      ...(credential.token ? { token: credential.token } : {}),
      body: JSON.stringify({
        ...(credential.key ? { key: credential.key } : {}),
        id: handle,
        schema: item.schema,
        theme: item.theme ?? null,
        ...(item.storage ? { storage: item.storage } : {}),
        ...(item.purpose ? { purpose: item.purpose } : {}),
      }),
    });
    const body = (await readJson(res)) as SyncPushResult;
    if (!res.ok || body.syncError || !body.formId) {
      die(syncError(res, body, credential.kind));
    }
    if (results) {
      // Normalize `staged` to a top-level boolean so `push --json` always
      // carries it (the immediate-apply preview lane omits it server-side);
      // `canPublishFileFields` and `notices` ride along untouched.
      results.push({ ...body, staged: body.staged === true });
      emitProgress({
        status: "pushed",
        formId: body.formId,
        staged: body.staged === true,
        formStatus: body.status,
      });
    } else {
      printSynced(body, requestedStage);
    }
  }
}

async function push(file: string | undefined, flags: Flags) {
  if (!file) {
    die("Usage: fillo push <form.json|-> [--handle name] [--stage] [--allow-code]");
  }
  const cfg = readConfig();
  const explicitStage = flags.stage === true;
  const legacyDraft = flags.draft === true;
  const stage = explicitStage || legacyDraft;
  const syncToken = readSyncToken();

  // Resolve authorization before reading stdin or executing an opted-in code
  // module. A bad/misleading credential must fail without running the schema.
  if (syncToken && !stage) {
    die(`${SYNC_TOKEN_ENV} can only stage changes. Add --stage to this push.`);
  }
  const accountToken = !syncToken && cfg.token ? requireToken() : undefined;
  if (!syncToken && !accountToken && stage && cfg.pk) {
    die(
      "This local setup is an unclaimed preview, where publishable-key sync applies changes immediately. " +
        "Omit --stage for the preview, or claim it and run `fillo login` before staging for review.",
    );
  }
  if (!syncToken && !accountToken && stage) {
    die(
      `To stage changes, run \`fillo login\` or set ${SYNC_TOKEN_ENV} from Settings > Developers.`,
    );
  }

  const handle = typeof flags.handle === "string" ? flags.handle : undefined;
  const items = toPushItems(await loadSchema(file, flags["allow-code"] === true), handle);
  if (items.length > 1 && handle) die("--handle can only be used when pushing one form.");

  // --json: per-form progress goes to stderr as it lands; the collected
  // results become the single final document on stdout.
  const results: unknown[] | undefined = jsonMode(flags) ? [] : undefined;

  if (syncToken) {
    await pushWithSync(items, { kind: "sync_token", token: syncToken }, true, results);
    if (results) emitResult({ forms: results });
    return;
  }

  // Logged in pushes may still publish directly, but --stage always uses the
  // review-preserving sync endpoint. --draft is retained as its compatibility
  // alias when there is a stable handle. Its legacy no-handle form remains a
  // one-off draft: it cannot target or take an existing live form offline.
  if (accountToken) {
    if (stage) {
      for (const item of items) {
        if (item.handle || explicitStage || !legacyDraft) {
          await pushWithSync([item], { kind: "account", token: accountToken }, true, results);
          continue;
        }
        const res = await api("/cli/forms", {
          method: "POST",
          token: accountToken,
          body: JSON.stringify({
            schema: item.schema,
            theme: item.theme ?? null,
            ...(item.storage ? { storage: item.storage } : {}),
            ...(item.purpose ? { purpose: item.purpose } : {}),
            publish: false,
          }),
        });
        const body = (await readJson(res)) as {
          formId?: string;
          url?: string;
          error?: string;
          updated?: boolean;
          warning?: string;
          warningUrl?: string;
          notices?: string[];
        };
        if (!res.ok || !body.formId) die(body.error ?? `push failed (${res.status}).`);
        if (results) {
          // `body` already carries the server's status/staged/accepting/
          // uploadsAvailable/warning/notices envelope — forward it whole so
          // `--json` gets the full lifecycle in one round-trip.
          results.push(body);
          emitProgress({ status: "pushed", formId: body.formId, draft: true });
        } else {
          printPushed(body.formId, body.url, !!body.updated, true, {
            warning: body.warning,
            warningUrl: body.warningUrl,
            notices: body.notices,
          });
        }
      }
      if (results) emitResult({ forms: results });
      return;
    }
    for (const item of items) {
      const res = await api("/cli/forms", {
        method: "POST",
        token: accountToken,
        body: JSON.stringify({
          schema: item.schema,
          theme: item.theme ?? null,
          handle: item.handle,
          ...(item.storage ? { storage: item.storage } : {}),
          ...(item.purpose ? { purpose: item.purpose } : {}),
          publish: true,
        }),
      });
      const body = (await readJson(res)) as {
        formId?: string;
        url?: string;
        status?: "draft" | "published";
        error?: string;
        updated?: boolean;
        warning?: string;
        warningCode?: string;
        warningUrl?: string;
        notices?: string[];
      };
      if (!res.ok || !body.formId) {
        // A storage-blocked 409 carries the same settings deep-link printSynced
        // shows — surface it under the error so the fix is one click away.
        if (res.status === 409 && typeof body.warningUrl === "string" && body.warningUrl) {
          if (results) emitResult(body);
          console.error(
            `${failMark()} ${terminalText(body.error ?? `push failed (${res.status}).`)}`,
          );
          console.error(`  Storage settings: ${terminalText(body.warningUrl)}`);
          process.exit(1);
        }
        die(body.error ?? `push failed (${res.status}).`);
      }
      const draft = body.status === "draft";
      if (results) {
        // `body` already carries the server's status/staged/accepting/
        // uploadsAvailable/canPublishFileFields envelope — forward it whole so
        // `--json` gets the full lifecycle in one round-trip.
        results.push(body);
        emitProgress({
          status: "pushed",
          formId: body.formId,
          ...(draft ? { draft: true } : { published: true }),
        });
      } else {
        printPushed(body.formId, body.url, !!body.updated, draft, {
          warning: body.warning,
          warningUrl: body.warningUrl,
          notices: body.notices,
        });
      }
    }
    if (results) emitResult({ forms: results });
    return;
  }

  if (cfg.pk) {
    await pushWithSync(items, { kind: "publishable_key", key: cfg.pk }, false, results);
    if (results) emitResult({ forms: results });
    return;
  }

  die("Not set up yet. Run `fillo init --email you@company.com` or `fillo login`.");
}

export const pushCommand: Command = {
  name: "push",
  flags: ["handle", "stage", "draft", "allow-code"],
  run: (args, flags) => push(args[0], flags),
};

export const listCommand: Command = {
  name: "list",
  aliases: ["ls"],
  flags: [],
  run: (_args, flags) => list(flags),
};

export const statusCommand: Command = {
  name: "status",
  flags: [],
  run: (args, flags) => status(args[0], flags),
};

export const publishCommand: Command = {
  name: "publish",
  flags: ["allow-breaking"],
  run: (args, flags) => publish(args[0], flags),
};

export const testResponseCommand: Command = {
  name: "test-response",
  flags: [],
  run: (args) => testResponse(args[0], args[1]),
};
