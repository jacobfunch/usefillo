import { api, callApi, failed, readJson, requireToken } from "../lib/api.js";
import { requireConfirm } from "../lib/confirm.js";
import { enumFlag, type Flags, flagString } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  plural,
  printTable,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo deliveries` — where a form's responses went, and how to send them
 * again. The terminal view of the dashboard's Activity page, over the /cli
 * twins of the management routes; agents/scripts use /api/v1/manage with an
 * `fsk_` key holding responses:manage.
 *
 * status and retry are Tier A (reading, and re-sending work that was already
 * meant to go out). redeliver is Tier B: it is a NEW delivery that may
 * duplicate a downstream row, so it goes through the gate in lib/confirm.ts and
 * agent mode requires a bare --confirm.
 */

const when = (ms: number | null | undefined) =>
  typeof ms === "number" ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—";

type Destination = {
  key: string;
  kind: "webhook" | "integration";
  label: string;
  detail: string | null;
  delivered: number;
  pending: number;
  failed: number;
  lastDeliveredAt: number | null;
  lastError: string | null;
};

type Delivery = {
  id: string;
  destinationKey: string;
  destinationLabel: string;
  event: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  responseId: string | null;
  updatedAt: number;
};

type StatusBody = {
  windowDays?: number;
  destinations?: Destination[];
  deliveries?: Delivery[];
  hasMore?: boolean;
  error?: string;
};

/** A real Fillo 404 carries JSON {error}; an older deployment without these
 *  routes serves Next's HTML 404 — never read that as "the form is gone". */
async function dieOnNotFound(res: Response, handle: string, verb: string): Promise<never> {
  try {
    JSON.parse(await res.text());
  } catch {
    die(
      `This Fillo server does not support \`fillo deliveries ${verb}\` yet. ` +
        "Update the deployment, or use the form's Activity page.",
    );
  }
  die(
    `No form matches "${terminalText(handle)}" in this workspace. Run \`fillo list\` to see its forms.`,
  );
}

async function status(handle: string | undefined, flags: Flags) {
  if (!handle) die("Usage: fillo deliveries status <formId|handle>");
  const token = requireToken();
  const res = await api(`/cli/forms/${encodeURIComponent(handle)}/deliveries`, { token });
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 404) await dieOnNotFound(res, handle, "status");
  const body = (await readJson(res)) as StatusBody;
  if (!res.ok || !Array.isArray(body.destinations)) {
    die(body.error ?? `deliveries status failed (${res.status}).`);
  }
  if (jsonMode(flags)) return emitResult(body);

  if (body.destinations.length === 0) {
    return console.log("  No destinations configured — responses stay in Fillo only.");
  }
  console.log(`\n  ${bold("Destinations")}  ${dim(`last ${body.windowDays ?? 30} days`)}`);
  printTable(
    ["DESTINATION", "KEY", "OK", "PENDING", "FAILED", "LAST OK"],
    body.destinations.map((d) => [
      terminalText(d.detail ? `${d.label} · ${d.detail}` : d.label),
      terminalText(d.key),
      String(d.delivered),
      String(d.pending),
      String(d.failed),
      when(d.lastDeliveredAt),
    ]),
  );
  const failing = body.destinations.filter((d) => d.failed > 0);
  for (const d of failing) {
    console.log(
      `  ${dim(`${terminalText(d.label)}: ${terminalText(d.lastError ?? "delivery failed")}`)}`,
    );
  }
  if (failing.length > 0) {
    console.log(`  ${dim("Repair with `fillo deliveries retry <form> --all`.")}`);
  }

  const recent = body.deliveries ?? [];
  if (recent.length > 0) {
    console.log(`\n  ${bold("Recent")}`);
    printTable(
      ["WHEN", "STATE", "DESTINATION", "EVENT", "RESPONSE", "TRIES"],
      recent
        .slice(0, 20)
        .map((d) => [
          when(d.updatedAt),
          d.state,
          terminalText(d.destinationLabel),
          terminalText(d.event),
          terminalText(d.responseId ?? "—"),
          String(d.attempts),
        ]),
    );
    if (body.hasMore) console.log(`  ${dim("More retained rows exist than shown.")}`);
  }
  console.log("");
}

async function retry(handle: string | undefined, flags: Flags) {
  if (!handle) {
    die(
      "Usage: fillo deliveries retry <form> [--response <id> | --destination <key> | --delivery <id> --kind webhook|integration | --all]",
    );
  }
  const token = requireToken();
  const response = flagString(flags, "response");
  const destination = flagString(flags, "destination");
  const delivery = flagString(flags, "delivery");
  const kind = enumFlag(flags, "kind", ["webhook", "integration"] as const);
  const all = flags.all === true;

  const chosen = [Boolean(response), Boolean(destination), Boolean(delivery), all].filter(Boolean);
  if (chosen.length !== 1) {
    die("Choose exactly one of --response, --destination, --delivery, or --all.");
  }
  if (Boolean(delivery) !== Boolean(kind)) {
    die("--delivery needs --kind webhook|integration (and vice versa).");
  }

  const payload = response
    ? { responseIds: [response] }
    : destination
      ? { destinationKey: destination }
      : delivery
        ? { deliveryId: delivery, deliveryKind: kind }
        : { all: true as const };

  const body = await callApi<{ retried: number }>(
    `/cli/forms/${encodeURIComponent(handle)}/deliveries/retry`,
    { token, method: "POST", body: JSON.stringify(payload) },
    {
      fallback: failed("deliveries retry"),
      expect: (b) => typeof b.retried === "number",
      on: async (res, b) => {
        if (res.status === 404) await dieOnNotFound(res, handle, "retry");
        if (res.status === 429) die(b.error ?? "Too many retries — wait a minute and try again.");
      },
    },
  );
  if (jsonMode(flags)) return emitResult(body);
  if (body.retried === 0) {
    return console.log("  Nothing to retry — no failed or scheduled deliveries matched.");
  }
  console.log(
    `  ${okMark()} Re-queued ${body.retried} deliver${body.retried === 1 ? "y" : "ies"}; check \`fillo deliveries status\` in a moment.`,
  );
}

async function redeliver(handle: string | undefined, ids: string[], flags: Flags) {
  const json = jsonMode(flags);
  if (!handle || ids.length === 0) {
    die("Usage: fillo deliveries redeliver <form> <responseId...> [--confirm]");
  }
  const token = requireToken();

  // Tier B consent: a redelivery is a NEW delivery, not a repair.
  await requireConfirm(flags, {
    tier: "B",
    ttyIsConsent: true,
    notice:
      "Redelivering sends these responses to every destination again, including ones that already succeeded — a receiver may end up with a duplicate row.",
  });

  const body = await callApi<{ redelivered: number }>(
    `/cli/forms/${encodeURIComponent(handle)}/deliveries/redeliver`,
    { token, method: "POST", body: JSON.stringify({ responseIds: ids }) },
    {
      fallback: failed("deliveries redeliver"),
      expect: (b) => typeof b.redelivered === "number",
      on: async (res) => {
        if (res.status === 404) await dieOnNotFound(res, handle, "redeliver");
      },
    },
  );
  if (json) return emitResult(body);
  if (body.redelivered === 0) {
    return console.log(
      "  Nothing was re-sent — those ids are not accepted responses on this form (held responses go through `fillo responses release`).",
    );
  }
  console.log(
    `  ${okMark()} Re-sending ${plural(body.redelivered, "response")} to every destination.`,
  );
}

async function deliveries(subcommand: string | undefined, args: string[], flags: Flags) {
  if (!subcommand || subcommand === "help") return deliveriesHelp();
  if (subcommand === "status") return status(args[0], flags);
  if (subcommand === "retry") return retry(args[0], flags);
  if (subcommand === "redeliver") return redeliver(args[0], args.slice(1), flags);
  die(
    `Unknown deliveries command: ${terminalText(subcommand)} (expected status, retry, or redeliver).`,
  );
}

function deliveriesHelp() {
  console.log(`
  ${boldRaw("fillo deliveries")} — where a form's responses went, and re-sending

  ${boldRaw("Commands")}
    deliveries status <form>    Per-destination health and the recent outbox
    deliveries retry <form>     Repair failed (or overdue) deliveries
                       ${dimRaw("--response <id>        that response's failed destinations")}
                       ${dimRaw("--destination <key>    one destination's backlog")}
                       ${dimRaw("--delivery <id> --kind webhook|integration   one row")}
                       ${dimRaw("--all                  every failed delivery on the form")}
    deliveries redeliver <form> <id...>
                                Send responses again, to every destination
                       ${dimRaw("--confirm   required for agents/pipes; ask the human first")}

  ${dimRaw("retry repairs what failed; redeliver re-sends what already succeeded")}
  ${dimRaw("too and may duplicate a downstream row — ask the human before --confirm.")}
  ${dimRaw("Counts cover the telemetry retention window, not all time.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const deliveriesCommand: Command = {
  name: "deliveries",
  flags: ["response", "destination", "delivery", "kind", "all", "confirm", "yes"],
  run: (args, flags) => deliveries(args[0], args.slice(1), flags),
  help: deliveriesHelp,
};
