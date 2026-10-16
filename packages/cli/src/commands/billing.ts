import { API, callApi, failed } from "../lib/api.js";
import type { Flags } from "../lib/flags.js";
import { boldRaw, die, dim, dimRaw, emitResult, jsonMode, terminalText } from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo billing` — read-only: the workspace's plan and this month's response
 * usage over the human's `fcli_` credential (owner or admin, the same bar as
 * Settings → Billing & plan). It reports and points at the Manage page; it
 * never subscribes, changes a volume, or opens checkout. Plan selection and
 * payment stay a human click in Settings, by design.
 *
 * Servers from before 2026-09-27 could also report a running no-card trial
 * (`plan: "trial"`, `trialEndsAt`) and an unused one (`trialAvailable`). A
 * running one is still read back plainly; an unused one is never offered.
 */

type BillingBody = {
  billingEnabled?: boolean;
  plan: string;
  tier?: string | null;
  interval?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  /** Only from servers before 2026-09-27, alongside `plan: "trial"`. */
  trialEndsAt?: string | null;
  allowance: number;
  usage: { period?: string; responses: number; resetsAt?: string | null };
  history?: Array<{ period?: string; responses?: number }>;
  manageUrl?: string | null;
};

/**
 * The Everything volumes, smallest first — a mirror of `PAID_TIERS` in
 * apps/web/src/marketing/pricing.ts, volumes only (the CLI never quotes a
 * price). Used solely to name the volume that fits when usage runs high.
 */
const VOLUMES = [
  { tier: "5k", responses: 5_000 },
  { tier: "25k", responses: 25_000 },
  { tier: "100k", responses: 100_000 },
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const count = (value: number) => new Intl.NumberFormat("en-US").format(value);

function parseDate(iso: string | null | undefined): Date | null {
  if (typeof iso !== "string" || !iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Dates read in UTC: usage periods are UTC calendar months, and a fixed month
// table keeps the output identical across Node/ICU versions ("Sep", not "Sept").
const longDate = (date: Date) =>
  `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
const shortDate = (date: Date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;

/** "2026-08" → "Aug", plus the year when it differs from the current period's. */
function periodLabel(period: string, currentYear: string | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return terminalText(period);
  return match[1] === currentYear ? month : `${month} ${match[1]}`;
}

function daysLeft(end: Date, now = Date.now()): string {
  const days = Math.max(0, Math.ceil((end.getTime() - now) / 86_400_000));
  return days === 0 ? "ends today" : days === 1 ? "1 day left" : `${days} days left`;
}

const tierName = (tier: string | null | undefined) =>
  tier ? `Everything ${terminalText(tier)}` : "Everything";

/** The one line that says what the workspace runs on and the next date that matters. */
function planLine(body: BillingBody): string {
  if (body.billingEnabled === false) {
    // No billing on this server: the plan name is all there is to report.
    return body.plan === "free" ? "Free" : "Everything";
  }
  switch (body.plan) {
    case "free":
      return `Free · ${count(body.allowance)} responses a month`;
    case "trial": {
      // Older servers only: a trial started before trials were retired.
      const end = parseDate(body.trialEndsAt);
      const ends = end ? ` · ends ${longDate(end)} (${daysLeft(end)})` : "";
      return `Everything trial · ${count(body.allowance)} responses${ends}`;
    }
    case "complimentary":
      return `${tierName(body.tier)} · complimentary (no charge, no renewal date)`;
    case "subscribed": {
      const billed = body.interval === "year" ? "billed yearly" : "billed monthly";
      const end = parseDate(body.currentPeriodEnd);
      let next = "";
      if (body.status === "past_due") next = " · payment failed";
      else if (body.cancelAtPeriodEnd) next = end ? ` · cancels ${longDate(end)}` : " · canceling";
      else if (end)
        next = `${body.status === "trialing" ? " · first payment" : " · renews"} ${longDate(end)}`;
      return `${tierName(body.tier)} · ${billed}${next}`;
    }
    default:
      // A plan kind this CLI release doesn't know yet: name it rather than guess.
      return terminalText(body.plan);
  }
}

function usageLine(body: BillingBody): string {
  const { responses } = body.usage;
  const reset = parseDate(body.usage.resetsAt);
  const resets = reset ? ` · resets ${shortDate(reset)}` : "";
  if (!(body.allowance > 0)) return `${count(responses)} responses this month${resets}`;
  const percent = Math.floor((responses / body.allowance) * 100);
  return `${count(responses)} of ${count(body.allowance)} responses this month (${percent}%)${resets}`;
}

/** Earlier months on one line, only once any of them counted something. */
function historyLine(body: BillingBody): string | null {
  const currentYear = body.usage.period?.slice(0, 4);
  const earlier = (body.history ?? []).filter(
    (row): row is { period: string; responses: number } =>
      typeof row.period === "string" &&
      row.period !== body.usage.period &&
      typeof row.responses === "number",
  );
  if (!earlier.some((row) => row.responses > 0)) return null;
  return earlier
    .map((row) => `${periodLabel(row.period, currentYear)} ${count(row.responses)}`)
    .join(" · ");
}

/** Only an http(s) link from the server is printed; anything else falls back. */
function manageUrl(body: BillingBody): string {
  try {
    const url = new URL(body.manageUrl ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") return terminalText(url.href);
  } catch {
    // fall through to the deployment's own Settings page
  }
  return `${terminalText(API)}/settings/plan`;
}

/** The volume that fits this month's count, above the current allowance. */
function fittingVolume(body: BillingBody) {
  return VOLUMES.find(
    (volume) => volume.responses > body.allowance && volume.responses >= body.usage.responses,
  );
}

/** Plain facts under the block: payment trouble, an ending plan, the soft limit. */
function notes(body: BillingBody): string[] {
  const lines: string[] = [];
  const billing = body.billingEnabled !== false;

  if (billing && body.plan === "subscribed" && body.status === "past_due") {
    lines.push(
      "The last payment failed. Stripe is retrying it, and Everything stays on meanwhile.",
      "An owner or admin updates the card from Manage billing at the link above.",
    );
  } else if (billing && body.plan === "subscribed" && body.cancelAtPeriodEnd) {
    lines.push(
      "Everything stays active until the period ends; the workspace returns to Free after that.",
    );
  } else if (billing && body.plan === "trial") {
    lines.push("When the trial ends without a subscription, the workspace returns to Free.");
  }

  if (body.allowance > 0) {
    const ratio = body.usage.responses / body.allowance;
    if (ratio >= 0.8) {
      lines.push(
        ratio >= 1
          ? `${body.usage.responses > body.allowance ? "Past this month's allowance." : "This month's allowance is used up."} Forms keep collecting and nothing is dropped.`
          : `${Math.floor(ratio * 100)}% of this month's allowance is used. Forms keep collecting if it runs over.`,
      );
      if (billing) {
        const next = fittingVolume(body);
        if (next) {
          lines.push(
            `${ratio >= 1 ? "The volume that fits" : "The next volume"} is Everything ${next.tier} (${count(next.responses)} a month).`,
          );
        } else {
          lines.push(
            `For steady volume above ${count(body.allowance)} a month, write to hello@fillo.so.`,
          );
        }
      }
    }
  }

  if (!billing) lines.push("Billing isn't enabled on this Fillo server.");
  return lines;
}

async function billing(subcommand: string | undefined, flags: Flags) {
  if (subcommand === "help") return billingHelp();
  if (subcommand !== undefined) {
    die(`Unknown billing command: ${subcommand} (fillo billing takes no arguments).`);
  }
  const body = await callApi<BillingBody>(
    "/cli/workspace/billing",
    {},
    {
      fallback: failed("billing"),
      expect: (b) =>
        typeof b.plan === "string" &&
        typeof b.allowance === "number" &&
        typeof b.usage?.responses === "number",
    },
  );
  if (jsonMode(flags)) return emitResult(body);

  const rows: Array<[string, string]> = [
    ["Plan:", planLine(body)],
    ["Usage:", usageLine(body)],
  ];
  const earlier = historyLine(body);
  if (earlier) rows.push(["Earlier:", earlier]);
  if (body.billingEnabled !== false) rows.push(["Manage:", `${manageUrl(body)} (owner or admin)`]);

  console.log("");
  // Labels are literal; every value is already terminal-safe text.
  for (const [label, value] of rows) console.log(`  ${label.padEnd(9)}${value}`);
  const extra = notes(body);
  if (extra.length > 0) {
    console.log("");
    for (const line of extra) console.log(`  ${dim(line)}`);
  }
  console.log("");
}

function billingHelp() {
  console.log(`
  ${boldRaw("fillo billing")} — the workspace's plan and this month's response usage

  ${boldRaw("Usage")}
    billing            Print the plan, usage against the monthly allowance,
                       recent months, and the Manage link

  ${dimRaw("Read-only. Needs an owner or admin login. Subscribing, volume changes,")}
  ${dimRaw("cards, and invoices are a human click in Settings → Billing & plan (the")}
  ${dimRaw("printed Manage link). Allowances are soft: forms keep collecting past them.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const billingCommand: Command = {
  name: "billing",
  flags: [],
  run: (args, flags) => billing(args[0], flags),
  help: billingHelp,
};
