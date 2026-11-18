import type { FilloClient } from "./client.js";
import { contentHash } from "./define.js";

/** How long one browser stays quiet about the same broken definition. */
const REPORT_EVERY_MS = 24 * 60 * 60_000;
/** Lookups this page already made, so remounts don't repeat them. */
const lookups = new Map<string, Promise<string | null>>();
/** Console errors already printed this page. */
const logged = new Set<string>();

function definitionHash(definition: unknown): string {
  try {
    return contentHash(JSON.stringify(definition) ?? "");
  } catch {
    return "unserializable";
  }
}

/** True when this browser hasn't reported this definition in the last day. */
function claimReport(key: string): boolean {
  const storageKey = `fillo:definition-report:v1:${key}`;
  try {
    const last = Number(globalThis.localStorage?.getItem(storageKey));
    if (Number.isFinite(last) && Date.now() - last < REPORT_EVERY_MS) return false;
    globalThis.localStorage?.setItem(storageKey, String(Date.now()));
  } catch {
    // Storage disabled: the page-level dedupe still bounds reports.
  }
  return true;
}

function report(
  client: FilloClient,
  target: { formId: string } | { handle: string },
  definition: unknown,
): Promise<string | null> {
  return typeof client.reportInvalidDefinition === "function"
    ? client.reportInvalidDefinition(target, definition)
    : Promise.resolve(null);
}

/**
 * A page shipped a form definition Fillo can't render. Find the published
 * version to show instead, tell the workspace owner, and explain it once in
 * the console. Resolves to the published form's id, or null when there's
 * nothing to show. Never throws.
 *
 * - With a `formId`, that form is the fallback and the report goes out in the
 *   background, at most once per browser per day for the same definition.
 * - With only a code form's `handle`, the publishable key resolves the id, so
 *   the report is what finds the fallback.
 */
export function publishedFallbackForInvalidDefinition(
  client: FilloClient | undefined,
  args: { formId?: string; handle?: string; definition: unknown; reason: string },
): Promise<string | null> {
  const target = args.formId ?? (args.handle ? `handle:${args.handle}` : "");
  const key = `${client?.baseUrl ?? ""}|${client?.key ?? ""}|${target}|${definitionHash(args.definition)}`;
  const existing = lookups.get(key);
  if (existing) return existing;

  let lookup: Promise<string | null>;
  if (args.formId) {
    if (client && claimReport(key)) void report(client, { formId: args.formId }, args.definition);
    lookup = Promise.resolve(args.formId);
  } else if (args.handle && client?.key) {
    lookup = report(client, { handle: args.handle }, args.definition);
  } else {
    lookup = Promise.resolve(null);
  }
  lookup = lookup.then((formId) => {
    if (!logged.has(key)) {
      logged.add(key);
      // An explicit formId isn't checked until the renderer fetches it.
      const instead = !formId
        ? "Nothing is published to show instead, so the form is hidden"
        : args.formId
          ? "Showing the version published on Fillo instead, or hiding the form if nothing is published"
          : "Showing the version published on Fillo instead";
      console.error(
        `[fillo] This form's definition is invalid: ${args.reason}. ${instead}. Fix the definition in your code.`,
      );
    }
    return formId;
  });
  lookups.set(key, lookup);
  return lookup;
}
