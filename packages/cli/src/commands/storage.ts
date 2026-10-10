import { API, api, callApi, failed, readJson, requireToken } from "../lib/api.js";
import { connectViaBrowser } from "../lib/browser-connect.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  agentMode,
  bold,
  boldRaw,
  dateOnly,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  printTable,
  terminalText,
} from "../lib/output.js";
import { readLine, readSecret } from "../lib/prompt.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo storage` — inspect and wire the workspace's upload destinations from
 * the terminal. Status and the S3/R2 lane are fully headless (S3 is pure
 * credentials); Drive and Box connect by bouncing through the human's
 * already-signed-in browser, so the CLI prints the OAuth URL and polls the
 * `fcli_` status endpoint until the provider flips connected. All uploads go
 * browser-direct to customer storage; this only opens/inspects the connection.
 */

type DurableProvider = "gdrive" | "s3" | "box";

type StorageStatus = {
  providers: Record<
    DurableProvider,
    { connected: boolean; detail: Record<string, unknown> | null }
  >;
  transit: { active: boolean; accessUntil: string | null };
  implicitStorageProvider: string | null;
  defaultStorageProvider: string | null;
  /** Pre-authoring signal: does a default upload destination resolve right now,
   *  so a new form's file field can publish? Absent on older servers. */
  canPublishFileFields?: boolean;
};

// User-facing provider words ↔ the durable provider ids the API uses.
const PROVIDER_LABEL: Record<DurableProvider, string> = { s3: "s3", gdrive: "drive", box: "box" };

/** Map a `connect`/`disconnect` argument (s3, r2, drive, gdrive, box) to the
 *  durable provider id, or undefined when it isn't one we recognize. */
function resolveProviderArg(arg: string | undefined): DurableProvider | undefined {
  if (arg === "s3" || arg === "r2") return "s3";
  if (arg === "drive" || arg === "gdrive" || arg === "google") return "gdrive";
  if (arg === "box") return "box";
  return undefined;
}

function detailText(provider: DurableProvider, detail: Record<string, unknown> | null): string {
  if (!detail) return "—";
  if (provider === "s3") {
    const parts = [detail.endpoint, detail.bucket, detail.region]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map(terminalText);
    if (detail.forcePathStyle === true) parts.push("path-style");
    return parts.join(" · ") || "—";
  }
  const email = detail.accountEmail;
  return typeof email === "string" && email ? terminalText(email) : "—";
}

function fetchStatus(token: string): Promise<StorageStatus> {
  return callApi<StorageStatus>(
    "/cli/storage",
    { token },
    { fallback: failed("storage status"), expect: (b) => Boolean(b.providers) },
  );
}

async function status(flags: Flags) {
  const token = requireToken();
  const body = await fetchStatus(token);
  if (jsonMode(flags)) return emitResult(body);

  const rows = (["s3", "gdrive", "box"] as DurableProvider[]).map((provider) => {
    const state = body.providers[provider];
    return [
      PROVIDER_LABEL[provider],
      state.connected ? "connected" : "not connected",
      detailText(provider, state.detail),
    ];
  });
  console.log("");
  printTable(["PROVIDER", "STATUS", "DETAIL"], rows);

  const transit = body.transit;
  const transitLine = transit.active
    ? `active${transit.accessUntil ? ` until ${dateOnly(transit.accessUntil)}` : ""}`
    : "inactive";
  console.log(`\n  ${dim("Transit staging:")} ${transitLine}`);
  const target = body.defaultStorageProvider;
  const targetLabel =
    target && target in PROVIDER_LABEL
      ? PROVIDER_LABEL[target as DurableProvider]
      : (target ?? "no durable storage yet");
  console.log(`  ${dim("Uploads for storage=null forms resolve to:")} ${targetLabel}`);
  // The one-line pre-authoring answer: whether a file field can publish now.
  if (body.canPublishFileFields === true) {
    console.log(`  ${dim("Can publish file fields:")} yes`);
  } else if (body.canPublishFileFields === false) {
    console.log(
      `  ${dim("Can publish file fields:")} not yet — connect or choose a destination first`,
    );
  }
  console.log("");
}

/** One credential field the S3 connect flow needs, and how to obtain it. */
type S3Field = {
  key: "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey";
  flag: string;
  env: string;
  label: string;
  required: boolean;
  secret?: boolean;
};

const S3_FIELDS: readonly S3Field[] = [
  {
    key: "endpoint",
    flag: "--endpoint",
    env: "FILLO_S3_ENDPOINT",
    label: "Endpoint URL",
    required: true,
  },
  { key: "bucket", flag: "--bucket", env: "FILLO_S3_BUCKET", label: "Bucket", required: true },
  {
    key: "region",
    flag: "--region",
    env: "FILLO_S3_REGION",
    label: "Region (optional)",
    required: false,
  },
  {
    key: "accessKeyId",
    flag: "--access-key-id",
    env: "FILLO_S3_ACCESS_KEY_ID",
    label: "Access key id",
    required: true,
  },
  {
    key: "secretAccessKey",
    flag: "--secret-access-key",
    env: "FILLO_S3_SECRET_ACCESS_KEY",
    label: "Secret access key",
    required: true,
    secret: true,
  },
];

const FLAG_KEY: Record<S3Field["key"], string> = {
  endpoint: "endpoint",
  region: "region",
  bucket: "bucket",
  accessKeyId: "access-key-id",
  secretAccessKey: "secret-access-key",
};

async function connectS3(flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();
  // Interactive prompting is only safe with a real terminal AND human output.
  const interactive = !json && !agentMode();

  const values: Partial<Record<S3Field["key"], string>> = {};
  const missing: S3Field[] = [];
  for (const field of S3_FIELDS) {
    const fromFlag = flagString(flags, FLAG_KEY[field.key]);
    const fromEnv = process.env[field.env];
    const resolved = fromFlag ?? (fromEnv && fromEnv.length > 0 ? fromEnv : undefined);
    if (resolved !== undefined) {
      values[field.key] = resolved;
    } else if (field.required) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    if (!interactive) {
      // Agent / non-TTY / --json: name the exact flag and env var for each gap.
      const lines = missing.map((f) => `${f.flag} (or ${f.env})`);
      die(
        `Missing S3 connection values: ${lines.join(", ")}. ` +
          "Pass the flags, or set the env vars, then retry.",
      );
    }
    for (const field of missing) {
      const answer = field.secret
        ? await readSecret(`  ${field.label}: `).catch(() => "")
        : await readLine(`  ${field.label}: `);
      if (!answer && field.required) die(`${field.label} is required — nothing was connected.`);
      values[field.key] = answer;
    }
  } else if (interactive && values.region === undefined) {
    // Region is optional; offer the prompt but accept an empty answer.
    const answer = await readLine("  Region (optional, blank for auto): ");
    if (answer) values.region = answer;
  }

  const forcePathStyle =
    flags["force-path-style"] === true ||
    process.env.FILLO_S3_FORCE_PATH_STYLE === "1" ||
    process.env.FILLO_S3_FORCE_PATH_STYLE === "true";

  const payload: Record<string, unknown> = {
    endpoint: values.endpoint,
    bucket: values.bucket,
    accessKeyId: values.accessKeyId,
    secretAccessKey: values.secretAccessKey,
    ...(values.region ? { region: values.region } : {}),
    ...(forcePathStyle ? { forcePathStyle: true } : {}),
  };

  const body = await callApi<{ connected?: boolean; detail?: Record<string, unknown> }>(
    "/cli/storage/s3",
    { token, method: "POST", body: JSON.stringify(payload) },
    {
      fallback: failed("storage connect"),
      expect: (b) => b.connected === true,
      on: (res, b) => {
        if (res.status === 422) {
          die(
            `${b.error ?? "Fillo couldn't reach the bucket."} — check the access key, secret, ` +
              "bucket, and endpoint, then retry.",
          );
        }
      },
    },
  );

  if (json) return emitResult(body);
  const detail = body.detail ?? {};
  console.log(`\n  ${okMark()} Connected S3-compatible storage`);
  if (typeof detail.endpoint === "string")
    console.log(`  Endpoint:  ${terminalText(detail.endpoint)}`);
  if (typeof detail.bucket === "string") console.log(`  Bucket:    ${terminalText(detail.bucket)}`);
  if (typeof detail.region === "string") console.log(`  Region:    ${terminalText(detail.region)}`);
  console.log("\n  Uploads on published file fields now flow directly to this bucket.\n");
}

async function connectBrowserProvider(provider: DurableProvider, flags: Flags) {
  const json = jsonMode(flags);
  const token = requireToken();
  const what = provider === "gdrive" ? "Google Drive" : "Box";
  const startPath = provider === "gdrive" ? "google" : "box";
  const startUrl = `${API}/api/integrations/${startPath}/start?return=terminal`;

  let snapshot: StorageStatus | null = null;
  await connectViaBrowser({
    json,
    what,
    startUrl,
    poll: async () => {
      const res = await api("/cli/storage", { token });
      if (res.status === 401) die("Token invalid — run `fillo login` again.");
      const body = (await readJson(res)) as StorageStatus & { error?: string };
      if (!res.ok || !body.providers) return false;
      snapshot = body;
      return body.providers[provider].connected;
    },
    onConnected: () => {
      const detail = snapshot?.providers[provider].detail;
      const email =
        detail && typeof detail.accountEmail === "string" ? detail.accountEmail : undefined;
      return {
        result: { connected: true, provider, ...(email ? { accountEmail: email } : {}) },
        lines: [
          `  ${okMark()} Connected ${what}${email ? ` (${terminalText(email)})` : ""}.`,
          "  Uploads on published file fields now flow to this destination.",
        ],
      };
    },
  });
}

async function connect(providerArg: string | undefined, flags: Flags) {
  const provider = resolveProviderArg(providerArg);
  if (!provider) {
    die("Usage: fillo storage connect <s3|drive|box>  (r2 and gdrive are accepted aliases).");
  }
  if (provider === "s3") return connectS3(flags);
  return connectBrowserProvider(provider, flags);
}

async function disconnect(providerArg: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  const provider = resolveProviderArg(providerArg);
  // Disconnect must always name its provider — never guess an implicit target.
  if (!provider) {
    die("Usage: fillo storage disconnect <s3|drive|box> — name the provider to disconnect.");
  }
  const body = await callApi<{ ok?: boolean; provider?: string; connected?: boolean }>(
    `/cli/storage/${provider}`,
    { method: "DELETE" },
    {
      // 409 = still in use (files, sessions, or a live upload form): the
      // server's guidance passes through, so the agent unpublishes or migrates
      // rather than retrying.
      fallback: failed("storage disconnect"),
      expect: (b) => b.ok === true,
    },
  );
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Disconnected ${PROVIDER_LABEL[provider]} storage.`);
}

/* ---------- per-form destination ---------- */

/** The destination words the server accepts for one form. `transit` and `none`
 *  both clear the per-form choice — transit staging is what an unselected form
 *  falls back to while no durable provider is connected, never a destination a
 *  form can pin — so the server always reports what uploads resolved to. */
const FORM_DESTINATIONS = ["gdrive", "box", "s3", "r2", "transit", "none"] as const;

type FormStorageBody = {
  destination?: string;
  storage?: { provider?: string; variant?: string; selectedFolderName?: string } | null;
  resolved?: string | null;
  error?: string;
};

/** Every per-form storage call reports a missing form and a refusal alike: 409
 *  means the workspace has not connected that destination, or the form is live
 *  and collects files, and the server's sentence already names the fix. */
function formStorageCall<T>(
  handle: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  return callApi<T>(path, init, {
    fallback: failed("storage"),
    on: (res) => {
      if (res.status === 404) {
        die(
          `No form matches "${terminalText(handle)}" in this workspace. Run \`fillo list\` to see its forms.`,
        );
      }
    },
  });
}

async function formStorage(
  handle: string | undefined,
  destination: string | undefined,
  flags: Flags,
) {
  const json = jsonMode(flags);
  if (!handle) {
    die(`Usage: fillo storage set <form> <${FORM_DESTINATIONS.join("|")}>`);
  }
  const token = requireToken();
  const path = `/cli/forms/${encodeURIComponent(handle)}/storage`;

  if (destination === undefined) {
    const body = await formStorageCall<FormStorageBody>(handle, path, { token });
    if (json) return emitResult(body);
    console.log(`\n  Destination: ${bold(terminalText(body.destination ?? "none"))}`);
    console.log(
      `  ${dim("Uploads resolve to:")} ${terminalText(body.resolved ?? "nothing yet")}\n`,
    );
    return;
  }
  if (!(FORM_DESTINATIONS as readonly string[]).includes(destination)) {
    die(`A form's destination must be one of: ${FORM_DESTINATIONS.join(", ")}.`);
  }

  const body = await formStorageCall<FormStorageBody>(handle, path, {
    token,
    method: "PUT",
    body: JSON.stringify({ destination }),
  });
  if (json) return emitResult(body);
  console.log(
    `\n  ${okMark()} Uploads for this form go to ${bold(terminalText(body.destination ?? destination))}`,
  );
  console.log(`  ${dim("Resolved destination:")} ${terminalText(body.resolved ?? "nothing yet")}`);
  if (destination === "transit" && body.resolved !== "transit") {
    // Asking for transit on a workspace that has durable storage is honored as
    // "no per-form choice" — say what actually happens instead of implying the
    // files will sit in Fillo's staging bucket.
    console.log(
      `  ${dim("Transit staging only applies while no durable provider is connected — this form now follows the workspace default.")}`,
    );
  }
  if (body.resolved === null) {
    console.log(
      `  ${dim("No destination resolves yet — connect one with `fillo storage connect <s3|drive|box>`.")}`,
    );
  }
  console.log("");
}

/* ---------- Drive upload folder ---------- */

type DriveFolderBody = {
  folder?: { id: string | null; name: string | null };
  folders?: Array<{ id: string; name: string }>;
  error?: string;
};

async function driveFolder(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) {
    die("Usage: fillo storage folder <form> [--list | --id <folderId> | --reset]");
  }
  const token = requireToken();
  const folderId = flagString(flags, "id");
  const reset = flags.reset === true;
  if (folderId && reset) die("Pass --id or --reset, not both.");
  const path = `/cli/forms/${encodeURIComponent(handle)}/storage/folder`;

  const body = await formStorageCall<DriveFolderBody>(
    handle,
    folderId || reset ? path : `${path}?q=${encodeURIComponent(flagString(flags, "q") ?? "")}`,
    {
      token,
      ...(folderId
        ? { method: "PUT", body: JSON.stringify({ folderId }) }
        : reset
          ? { method: "DELETE" }
          : {}),
    },
  );
  if (json) return emitResult(body);

  if (folderId) {
    console.log(
      `\n  ${okMark()} Uploads land in ${bold(terminalText(body.folder?.name ?? folderId))}\n`,
    );
    return;
  }
  if (reset) {
    console.log(`\n  ${okMark()} Back to this form's automatic Fillo folder.\n`);
    return;
  }
  console.log(
    `\n  Current folder: ${bold(terminalText(body.folder?.name ?? "automatic (Fillo creates one per form)"))}`,
  );
  const folders = body.folders ?? [];
  if (folders.length === 0) {
    console.log(`  ${dim("No writable folders found in the connected Drive account.")}\n`);
    return;
  }
  console.log("");
  printTable(
    ["NAME", "FOLDER ID"],
    folders.map((folder) => [terminalText(folder.name), terminalText(folder.id)]),
  );
  console.log(`\n  ${dim("Choose one with: fillo storage folder <form> --id <folderId>")}\n`);
}

async function storage(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "status") return status(flags);
  if (subcommand === "help") return storageHelp();
  if (subcommand === "connect") return connect(args[0], flags);
  if (subcommand === "disconnect") return disconnect(args[0], flags);
  if (subcommand === "set") return formStorage(args[0], args[1], flags);
  if (subcommand === "folder") return driveFolder(args[0], flags);
  die(
    `Unknown storage command: ${terminalText(subcommand)} (expected status, connect, disconnect, set, or folder).`,
  );
}

function storageHelp() {
  console.log(`
  ${boldRaw("fillo storage")} — inspect and connect upload destinations

  ${boldRaw("Commands")}
    storage                     Show each provider's connection + the transit window
    storage connect s3          Connect an S3/R2 bucket (headless — no browser)
                       ${dimRaw("--endpoint URL           or FILLO_S3_ENDPOINT")}
                       ${dimRaw("--bucket NAME            or FILLO_S3_BUCKET")}
                       ${dimRaw("--access-key-id ID       or FILLO_S3_ACCESS_KEY_ID")}
                       ${dimRaw("--secret-access-key KEY  or FILLO_S3_SECRET_ACCESS_KEY (hidden prompt on a TTY)")}
                       ${dimRaw("--region NAME            or FILLO_S3_REGION (optional, defaults to auto)")}
                       ${dimRaw("--force-path-style       or FILLO_S3_FORCE_PATH_STYLE=1")}
    storage connect drive       Connect Google Drive (opens an OAuth URL to approve)
    storage connect box         Connect Box (opens an OAuth URL to approve)
    storage disconnect <p>      Disconnect s3, drive, or box (provider required)
    storage set <form> <dest>   Where ONE form's uploads land: gdrive, box, s3, r2,
                       ${dimRaw("transit, or none. transit/none clear the per-form choice — the")}
                       ${dimRaw("form then follows the workspace default (which is transit")}
                       ${dimRaw("staging only while no durable provider is connected).")}
                       ${dimRaw("Without a destination it prints the current one.")}
    storage folder <form>       The Google Drive folder that form's uploads land in
                       ${dimRaw("--list (default)  current folder + the account's writable folders")}
                       ${dimRaw("--q <text>        filter that list by folder name")}
                       ${dimRaw("--id <folderId>   send this form's uploads to that folder")}
                       ${dimRaw("--reset           back to the automatic per-form folder")}

  ${dimRaw("r2 is an alias for s3; gdrive for drive. Missing S3 values fall back to the")}
  ${dimRaw("env vars above, then an interactive prompt — agents/pipes must pass flags/env.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const storageCommand: Command = {
  name: "storage",
  flags: [
    "endpoint",
    "region",
    "bucket",
    "access-key-id",
    "secret-access-key",
    "force-path-style",
    "list",
    "id",
    "q",
    "reset",
  ],
  run: (args, flags) => storage(args[0], args.slice(1), flags),
  help: storageHelp,
};
