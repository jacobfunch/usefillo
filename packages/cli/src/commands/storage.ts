import { API, api, readJson, requireToken } from "../lib/api.js";
import { connectViaBrowser } from "../lib/browser-connect.js";
import { type Flags, flagString } from "../lib/flags.js";
import {
  agentMode,
  boldRaw,
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
const dateOnly = (iso: string) => iso.slice(0, 10);

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

async function fetchStatus(token: string): Promise<StorageStatus> {
  const res = await api("/cli/storage", { token });
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  const body = (await readJson(res)) as StorageStatus & { error?: string };
  if (!res.ok || !body.providers) die(body.error ?? `storage status failed (${res.status}).`);
  return body;
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

  const res = await api("/cli/storage/s3", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
  const body = (await readJson(res)) as {
    connected?: boolean;
    detail?: Record<string, unknown>;
    error?: string;
  };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 422) {
    die(
      `${body.error ?? "Fillo couldn't reach the bucket."} — check the access key, secret, ` +
        "bucket, and endpoint, then retry.",
    );
  }
  if (!res.ok || body.connected !== true) {
    die(body.error ?? `storage connect failed (${res.status}).`);
  }

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
  const token = requireToken();
  const res = await api(`/cli/storage/${provider}`, { method: "DELETE", token });
  const body = (await readJson(res)) as {
    ok?: boolean;
    provider?: string;
    connected?: boolean;
    error?: string;
  };
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  // 409 = still in use (files, sessions, or a live upload form): surface the
  // server's guidance so the agent unpublishes/migrates rather than retrying.
  if (!res.ok || body.ok !== true) die(body.error ?? `storage disconnect failed (${res.status}).`);
  if (json) return emitResult(body);
  console.log(`  ${okMark()} Disconnected ${PROVIDER_LABEL[provider]} storage.`);
}

async function storage(subcommand: string | undefined, args: string[], flags: Flags) {
  if (subcommand === undefined || subcommand === "status") return status(flags);
  if (subcommand === "help") return storageHelp();
  if (subcommand === "connect") return connect(args[0], flags);
  if (subcommand === "disconnect") return disconnect(args[0], flags);
  die(
    `Unknown storage command: ${terminalText(subcommand)} (expected status, connect, or disconnect).`,
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

  ${dimRaw("r2 is an alias for s3; gdrive for drive. Missing S3 values fall back to the")}
  ${dimRaw("env vars above, then an interactive prompt — agents/pipes must pass flags/env.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const storageCommand: Command = {
  name: "storage",
  flags: ["endpoint", "region", "bucket", "access-key-id", "secret-access-key", "force-path-style"],
  run: (args, flags) => storage(args[0], args.slice(1), flags),
  help: storageHelp,
};
