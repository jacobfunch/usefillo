import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural, untrusted } from "../result.js";
import { OUTWARD_CONFIRM, blockOutward, mismatch, typedConfirm } from "./confirm.js";
import {
  FORM_ARG,
  gridSearchParams,
  laneCall,
  laneFetch,
  laneProblem,
  noCredential,
  noForm,
  resolveLane,
} from "./lane.js";

/**
 * Wave 1c: operating what has already come in — releasing what the trust policy
 * held back, repairing deliveries that failed, reading in-progress drafts and
 * insights, and erasing a person on request.
 *
 * Everything that reads respondent-authored content rides in the `untrusted`
 * envelope, because the whole point of these tools is to put strangers' text in
 * front of a model. Releasing and redelivering are Tier B: both END with data
 * arriving somewhere outside Fillo.
 */

const RESPONSE_IDS = z
  .array(z.string().trim().min(1).max(128))
  .max(200)
  .describe("Response ids (max 200).");

export function registerResponseOps(server: McpServer): void {
  registerListHeldResponses(server);
  registerReleaseResponses(server);
  registerDeleteResponse(server);
  registerListDeliveries(server);
  registerRetryDeliveries(server);
  registerRedeliverResponses(server);
  registerListDrafts(server);
  registerInsights(server);
  registerListRespondents(server);
  registerDeleteRespondent(server);
}

// -------------------------------------------------------------- held rows ---

function registerListHeldResponses(server: McpServer): void {
  server.registerTool(
    "fillo_list_held_responses",
    {
      title: localCapability("fillo_list_held_responses").title,
      description: localCapability("fillo_list_held_responses").description,
      inputSchema: {
        form: FORM_ARG,
        range: z.string().optional().describe("Date range filter (grid grammar)."),
        q: z.string().optional().describe("Full-text search across answers."),
        source: z.string().optional().describe("Filter by response source."),
        respondent: z.string().optional().describe("Filter by respondent external id."),
        where: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Field filters, each `fieldId:op:value`, e.g. ['score:eq:10']."),
        includeFields: z
          .array(z.string().min(1).max(200))
          .max(100)
          .optional()
          .describe("Only these answer field ids; [] returns no answers."),
        includeMeta: z.boolean().optional().describe("Set false to return metadata as null."),
        cursor: z.string().optional().describe("Opaque cursor from a prior page's nextCursor."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)."),
      },
      annotations: localCapability("fillo_list_held_responses").annotations,
    },
    async ({
      form,
      range,
      q,
      source,
      respondent,
      where,
      cursor,
      limit,
      includeFields,
      includeMeta,
    }) => {
      const searchParams = gridSearchParams({
        range,
        q,
        source,
        respondent,
        where,
        cursor,
        limit,
        includeFields,
        includeMeta,
      });
      searchParams.set("held", "1");

      const call = await laneCall(
        { path: `/forms/${encodeURIComponent(form)}/responses`, searchParams },
        {
          scope: "responses:read and responses:manage",
          fallback: "Couldn't list the held responses",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.data) ? (res.json.data as unknown[]) : [];
      return ok(
        rows.length
          ? `${plural(rows.length, "held response")} on this page` +
              (res.json.nextCursor ? " (more available — follow nextCursor)." : ".")
          : "Nothing is being held on this form.",
        untrusted(res.json),
      );
    },
  );
}

function registerReleaseResponses(server: McpServer): void {
  server.registerTool(
    "fillo_release_responses",
    {
      title: localCapability("fillo_release_responses").title,
      description: localCapability("fillo_release_responses").description,
      inputSchema: {
        form: FORM_ARG,
        responseIds: RESPONSE_IDS.optional(),
        all: z.literal(true).optional().describe("Release every held response on this form."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: localCapability("fillo_release_responses").annotations,
    },
    async ({ form, responseIds, all, confirm }) => {
      if (Boolean(all) === Boolean(responseIds?.length)) {
        return fail("Pass responseIds or all=true — exactly one, never both.");
      }
      const blocked = blockOutward(
        confirm,
        all
          ? `Releasing every held response on "${form}" (they get delivered)`
          : `Releasing ${responseIds?.length} held response(s) on "${form}" (they get delivered)`,
      );
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/responses/release`,
          method: "POST",
          body: all ? { all: true } : { responseIds },
        },
        {
          scope: "responses:manage",
          fallback: "Couldn't release those responses",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const released = Number(res.json?.released ?? 0);
      return ok(
        released
          ? `Released ${plural(released, "response")} — they are being delivered now.`
          : "Nothing matched — no held responses were released.",
        res.json,
      );
    },
  );
}

function registerDeleteResponse(server: McpServer): void {
  server.registerTool(
    "fillo_delete_response",
    {
      title: localCapability("fillo_delete_response").title,
      description: localCapability("fillo_delete_response").description,
      inputSchema: {
        form: FORM_ARG,
        id: z.string().trim().min(1).max(128).describe("The response id to delete."),
        confirm: typedConfirm("response id"),
      },
      annotations: localCapability("fillo_delete_response").annotations,
    },
    async ({ form, id, confirm }) => {
      const lane = resolveLane();
      if (!lane) return noCredential("(login token only)");

      // The scoped mount addresses a response by id alone and makes
      // `responses:delete` the whole gate — its documented contract takes no
      // body. Comparing `confirm` against this tool's OWN `id` argument would
      // be theatre: the model can satisfy it from context without ever asking a
      // person, which is exactly what a typed confirmation exists to prevent.
      // So this lane is refused outright rather than gated by a local check the
      // server never sees.
      if (lane.kind !== "cli") {
        return fail(
          "Deleting a response needs a login token. Run `npx @usefillo/cli login` or set " +
            "FILLO_TOKEN — the project-API-key route accepts no typed confirmation, so on that " +
            "credential the confirmation would be checked only by the caller, which is no " +
            "confirmation at all. Nothing was deleted.",
        );
      }

      const wrong = mismatch(confirm, id, "response id");
      if (wrong) return wrong;

      const res = await laneFetch(lane, {
        path: `/forms/${encodeURIComponent(form)}/responses/${encodeURIComponent(id)}`,
        method: "DELETE",
        body: { confirm },
      });
      const problem = laneProblem(lane, res, {
        scope: "(login token only)",
        fallback: "Couldn't delete the response",
        missing: `No response "${id}" on this form. It may already be deleted, or it may be held — use fillo_list_responses with held=true.`,
      });
      if (problem) return problem;

      return ok(`Deleted response "${id}". This cannot be undone.`, res.json);
    },
  );
}

// -------------------------------------------------------------- delivery ---

function registerListDeliveries(server: McpServer): void {
  server.registerTool(
    "fillo_delivery_status",
    {
      title: localCapability("fillo_delivery_status").title,
      description: localCapability("fillo_delivery_status").description,
      inputSchema: { form: FORM_ARG },
      annotations: localCapability("fillo_delivery_status").annotations,
    },
    async ({ form }) => {
      const call = await laneCall(
        { path: `/forms/${encodeURIComponent(form)}/deliveries` },
        {
          scope: "responses:manage",
          fallback: "Couldn't read delivery health",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const destinations = Array.isArray(res.json?.destinations)
        ? (res.json.destinations as Array<{ failed?: number }>)
        : [];
      const failing = destinations.filter((d) => Number(d.failed ?? 0) > 0).length;
      return ok(
        plural(destinations.length, "destination") +
          (failing
            ? `, ${failing} with failures — fillo_retry_deliveries can repair them.`
            : ", none failing."),
        res.json,
      );
    },
  );
}

function registerRetryDeliveries(server: McpServer): void {
  server.registerTool(
    "fillo_retry_deliveries",
    {
      title: localCapability("fillo_retry_deliveries").title,
      description: localCapability("fillo_retry_deliveries").description,
      inputSchema: {
        form: FORM_ARG,
        responseIds: RESPONSE_IDS.optional(),
        destinationKey: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .optional()
          .describe("A destination key from fillo_delivery_status, e.g. `webhook:abc`."),
        deliveryKind: z.enum(["webhook", "integration"]).optional().describe("With deliveryId."),
        deliveryId: z.string().trim().min(1).max(128).optional().describe("With deliveryKind."),
        all: z.literal(true).optional().describe("Retry every failed delivery on this form."),
      },
      annotations: localCapability("fillo_retry_deliveries").annotations,
    },
    async ({ form, responseIds, destinationKey, deliveryKind, deliveryId, all }) => {
      const targets = [
        responseIds?.length ? "responseIds" : null,
        destinationKey ? "destinationKey" : null,
        deliveryKind || deliveryId ? "deliveryId" : null,
        all ? "all" : null,
      ].filter(Boolean);
      if (targets.length !== 1) {
        return fail(
          "Choose exactly one target: responseIds, destinationKey, deliveryKind+deliveryId, or all=true.",
        );
      }
      if (Boolean(deliveryKind) !== Boolean(deliveryId)) {
        return fail("deliveryKind and deliveryId go together — send both or neither.");
      }

      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/deliveries/retry`,
          method: "POST",
          body: all
            ? { all: true }
            : destinationKey
              ? { destinationKey }
              : deliveryId
                ? { deliveryKind, deliveryId }
                : { responseIds },
        },
        {
          scope: "responses:manage",
          fallback: "Couldn't retry those deliveries",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const retried = Number(res.json?.retried ?? 0);
      return ok(
        retried
          ? `Queued ${plural(retried, "delivery attempt")}. Check fillo_delivery_status in a moment.`
          : "Nothing was failing — no retries queued.",
        res.json,
      );
    },
  );
}

function registerRedeliverResponses(server: McpServer): void {
  server.registerTool(
    "fillo_redeliver_responses",
    {
      title: localCapability("fillo_redeliver_responses").title,
      description: localCapability("fillo_redeliver_responses").description,
      inputSchema: {
        form: FORM_ARG,
        responseIds: RESPONSE_IDS.min(1).describe("Response ids to send again (1–200)."),
        confirm: OUTWARD_CONFIRM,
      },
      annotations: localCapability("fillo_redeliver_responses").annotations,
    },
    async ({ form, responseIds, confirm }) => {
      const blocked = blockOutward(
        confirm,
        `Re-sending ${responseIds.length} response(s) on "${form}" to their destinations (duplicates arrive)`,
      );
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/deliveries/redeliver`,
          method: "POST",
          body: { responseIds },
        },
        {
          scope: "responses:manage",
          fallback: "Couldn't redeliver those responses",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const count = Number(res.json?.redelivered ?? 0);
      return ok(`Queued ${plural(count, "response")} to be sent again.`, res.json);
    },
  );
}

// ------------------------------------------------------ drafts and people ---

function registerListDrafts(server: McpServer): void {
  server.registerTool(
    "fillo_list_drafts",
    {
      title: localCapability("fillo_list_drafts").title,
      description: localCapability("fillo_list_drafts").description,
      inputSchema: { form: FORM_ARG },
      annotations: localCapability("fillo_list_drafts").annotations,
    },
    async ({ form }) => {
      const call = await laneCall(
        { path: `/forms/${encodeURIComponent(form)}/drafts` },
        {
          scope: "responses:manage",
          fallback: "Couldn't read the in-progress drafts",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const open = Number(res.json?.open ?? 0);
      return ok(
        `${plural(open, "in-progress draft")} (${res.json?.identified ?? 0} identified).`,
        untrusted(res.json),
      );
    },
  );
}

function registerInsights(server: McpServer): void {
  server.registerTool(
    "fillo_form_insights",
    {
      title: localCapability("fillo_form_insights").title,
      description: localCapability("fillo_form_insights").description,
      inputSchema: {
        form: FORM_ARG,
        range: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Date range (default all)."),
        q: z.string().optional().describe("Full-text search across answers."),
        source: z.string().optional().describe("Filter by response source."),
        respondent: z.string().optional().describe("Filter by respondent external id."),
        where: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Field filters, each `fieldId:op:value`, e.g. ['score:eq:10']."),
        by: z.string().optional().describe("Field id to segment on."),
        op: z
          .enum(["eq", "answered", "not_answered"])
          .optional()
          .describe("Segment comparison (default eq, which needs `eq`)."),
        eq: z.string().optional().describe("The value to segment on when op is eq."),
      },
      annotations: localCapability("fillo_form_insights").annotations,
    },
    async ({ form, range, q, source, respondent, where, by, op, eq }) => {
      const searchParams = gridSearchParams({ range, q, source, respondent, where });
      if (by) searchParams.set("by", by);
      if (op) searchParams.set("op", op);
      if (eq !== undefined) searchParams.set("eq", eq);

      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/insights`,
          ...(searchParams.size ? { searchParams } : {}),
        },
        {
          scope: "forms:read and responses:read",
          fallback: "Couldn't read the form's insights",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `${res.json?.total ?? 0} responses in range` +
          (res.json?.segmentIgnored
            ? " (the segment field isn't in any schema version — ignored)."
            : "."),
        untrusted(res.json),
      );
    },
  );
}

function registerListRespondents(server: McpServer): void {
  server.registerTool(
    "fillo_list_respondents",
    {
      title: localCapability("fillo_list_respondents").title,
      description: localCapability("fillo_list_respondents").description,
      inputSchema: {
        externalId: z.string().trim().min(1).optional().describe("Exact external id."),
        email: z.string().trim().min(1).optional().describe("Exact email address."),
        cursor: z.string().optional().describe("Opaque cursor from a prior page's nextCursor."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)."),
      },
      annotations: localCapability("fillo_list_respondents").annotations,
    },
    async ({ externalId, email, cursor, limit }) => {
      const lane = resolveLane();
      if (!lane) return noCredential("respondents:read");
      if (lane.kind === "manage" && !externalId && !email) {
        return fail(
          "A project API key must look a respondent up by externalId or email. Log in with " +
            "`npx @usefillo/cli login` to browse the whole list instead.",
        );
      }

      const searchParams = new URLSearchParams();
      if (externalId) searchParams.set("externalId", externalId);
      if (email) searchParams.set("email", email);
      if (cursor) searchParams.set("cursor", cursor);
      if (limit) searchParams.set("limit", String(limit));

      const res = await laneFetch(lane, {
        path: "/respondents",
        ...(searchParams.size ? { searchParams } : {}),
      });
      const problem = laneProblem(lane, res, {
        scope: "respondents:read",
        fallback: "Couldn't look up respondents",
      });
      if (problem) return problem;

      const rows = Array.isArray(res.json?.data) ? (res.json.data as unknown[]) : [];
      return ok(
        `${plural(rows.length, "respondent")} on this page` +
          (res.json?.nextCursor ? " (more available — follow nextCursor)." : "."),
        untrusted(res.json),
      );
    },
  );
}

function registerDeleteRespondent(server: McpServer): void {
  server.registerTool(
    "fillo_delete_respondent",
    {
      title: localCapability("fillo_delete_respondent").title,
      description: localCapability("fillo_delete_respondent").description,
      inputSchema: {
        respondent: z
          .string()
          .trim()
          .min(1)
          .describe("The respondent's profile id OR external id."),
        alsoResponses: z
          .boolean()
          .optional()
          .describe("Also delete every response and file they submitted (default false)."),
        confirm: typedConfirm("respondent external id"),
      },
      annotations: localCapability("fillo_delete_respondent").annotations,
    },
    async ({ respondent, alsoResponses, confirm }) => {
      const call = await laneCall(
        {
          path: `/respondents/${encodeURIComponent(respondent)}`,
          method: "DELETE",
          body: { confirm, ...(alsoResponses === undefined ? {} : { alsoResponses }) },
        },
        {
          scope: "respondents:delete",
          fallback: "Couldn't forget this respondent",
          missing: `No respondent "${respondent}" in this project. Look the external id up with fillo_list_respondents.`,
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const deleted = Number(res.json?.responsesDeleted ?? 0);
      // The external id is respondent-supplied text, so the receipt that quotes
      // it back rides in the envelope every other respondent-derived payload
      // uses — the summary line names the argument the caller passed instead.
      return ok(
        "Forgot the respondent you named" +
          (deleted ? ` and deleted ${plural(deleted, "response")}.` : ".") +
          " This cannot be undone.",
        untrusted(res.json),
      );
    },
  );
}
