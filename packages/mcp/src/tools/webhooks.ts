import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, plural } from "../result.js";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, OUTWARD_WRITE, READ_ONLY } from "./annotations.js";
import { OUTWARD_CONFIRM, blockOutward } from "./confirm.js";
import { FORM_ARG, laneCall, noForm } from "./lane.js";

/**
 * Webhooks: the form's own HTTP destination, as opposed to the managed
 * integrations.
 *
 * Adding one is Tier B. It used to be routine on the reasoning that the
 * receiving endpoint belongs to the customer — but nothing about the call
 * proves that, and the effect is identical to enabling an integration: from
 * then on every respondent answer leaves Fillo for a server Fillo does not
 * control. A private or loopback target is refused, which is exactly the shape
 * an exfiltration endpoint has, so the endpoint being public is not a safeguard
 * either. A person names the host.
 *
 * The signing secret is returned exactly ONCE, at creation. It is the caller's
 * only chance to capture it, so the tool hands it to the model with instructions
 * to put it somewhere safe; the server never shows it again and nothing here
 * writes it to a log.
 */

const SCOPE = "webhooks:manage";

const AUTH_ARG = z
  .object({
    type: z.enum(["none", "bearer", "x-api-key"]),
    secret: z.string().max(4096).optional(),
  })
  .optional()
  .describe(
    'How Fillo authenticates to your endpoint: {"type":"none"}, or {"type":"bearer"|"x-api-key","secret":"…"}. ' +
      "The secret is stored encrypted and never returned.",
  );

/** The consent notice and the refusal name the HOST, not the URL: a path can
 *  carry a token, and the host is the part a person can recognize. */
function receivingHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function registerWebhooks(server: McpServer): void {
  registerListWebhooks(server);
  registerAddWebhook(server);
  registerUpdateWebhook(server);
  registerRemoveWebhook(server);
}

function registerListWebhooks(server: McpServer): void {
  server.registerTool(
    "fillo_list_webhooks",
    {
      title: "List a form's webhooks",
      description:
        "List the webhooks this form posts to, with their events and how each authenticates. " +
        "Signing secrets are never returned — they are shown only once, when the webhook is " +
        `created. Needs ${SCOPE}.`,
      inputSchema: { form: FORM_ARG },
      annotations: READ_ONLY,
    },
    async ({ form }) => {
      const call = await laneCall(
        { path: `/forms/${encodeURIComponent(form)}/webhooks` },
        {
          scope: SCOPE,
          fallback: "Couldn't list the webhooks",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.webhooks) ? (res.json.webhooks as unknown[]) : [];
      return ok(`${plural(rows.length, "webhook")} on "${form}".`, res.json);
    },
  );
}

function registerAddWebhook(server: McpServer): void {
  server.registerTool(
    "fillo_add_webhook",
    {
      title: "Add a webhook to a form",
      description:
        "Post this form's responses to an HTTPS endpoint. From the moment this succeeds every " +
        "respondent answer leaves Fillo for a server Fillo does not control, so ASK THE HUMAN " +
        "FIRST — name the exact host — and pass confirm=true only once they agree. Fillo signs " +
        "every call, and the signing secret comes back in THIS RESPONSE ONLY; hand it to the human " +
        "to store in a secret manager or environment variable and never commit it. Set " +
        "includeAbandoned to also receive draft.abandoned events. Private and loopback addresses " +
        `are refused. Needs ${SCOPE}.`,
      inputSchema: {
        form: FORM_ARG,
        url: z.string().trim().min(1).max(2000).describe("Public https:// endpoint to post to."),
        includeAbandoned: z
          .boolean()
          .optional()
          .describe("Also send draft.abandoned events (default false)."),
        authentication: AUTH_ARG,
        confirm: OUTWARD_CONFIRM,
      },
      annotations: { ...OUTWARD_WRITE, idempotentHint: false },
    },
    async ({ form, url, includeAbandoned, authentication, confirm }) => {
      const blocked = blockOutward(
        confirm,
        `Posting every "${form}" response to ${receivingHost(url)}`,
      );
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/webhooks`,
          method: "POST",
          body: {
            url,
            ...(includeAbandoned === undefined ? {} : { includeAbandoned }),
            ...(authentication ? { authentication } : {}),
          },
        },
        {
          scope: SCOPE,
          fallback: "Couldn't add the webhook",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `Added the webhook to "${form}". Its signing secret is in this result and Fillo will never ` +
          "show it again — give it to the human to store as a secret now, and do not write it into " +
          "source control.",
        res.json,
      );
    },
  );
}

function registerUpdateWebhook(server: McpServer): void {
  server.registerTool(
    "fillo_update_webhook",
    {
      title: "Update a form's webhook",
      description:
        "Change which events a webhook receives, or how Fillo authenticates to it. Sending " +
        "`authentication` replaces the stored credential wholesale. The endpoint URL cannot be " +
        "changed — remove the webhook and add the new URL, which also mints a fresh signing " +
        `secret. At least one of includeAbandoned or authentication is required. Needs ${SCOPE}.`,
      inputSchema: {
        form: FORM_ARG,
        id: z.string().trim().min(1).describe("Webhook id from fillo_list_webhooks."),
        includeAbandoned: z.boolean().optional().describe("Send draft.abandoned events too."),
        authentication: AUTH_ARG,
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form, id, includeAbandoned, authentication }) => {
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/webhooks/${encodeURIComponent(id)}`,
          method: "PATCH",
          body: {
            ...(includeAbandoned === undefined ? {} : { includeAbandoned }),
            ...(authentication ? { authentication } : {}),
          },
        },
        {
          scope: SCOPE,
          fallback: "Couldn't update the webhook",
          missing: `No webhook "${id}" on "${form}". List them with fillo_list_webhooks.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Updated webhook "${id}".`, res.json);
    },
  );
}

function registerRemoveWebhook(server: McpServer): void {
  server.registerTool(
    "fillo_remove_webhook",
    {
      title: "Remove a form's webhook",
      description:
        "Stop posting this form's responses to an endpoint. Reversible in the sense that you can " +
        "add the URL again, but the signing secret is gone — the new webhook gets a new one, and " +
        `the receiving side has to be updated. Needs ${SCOPE}.`,
      inputSchema: {
        form: FORM_ARG,
        id: z.string().trim().min(1).describe("Webhook id from fillo_list_webhooks."),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ form, id }) => {
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/webhooks/${encodeURIComponent(id)}`,
          method: "DELETE",
        },
        {
          scope: SCOPE,
          fallback: "Couldn't remove the webhook",
          missing: `No webhook "${id}" on "${form}".`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Removed webhook "${id}" from "${form}".`, res.json);
    },
  );
}
