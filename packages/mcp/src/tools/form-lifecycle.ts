import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural } from "../result.js";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, OUTWARD_WRITE, READ_ONLY } from "./annotations.js";
import { OUTWARD_CONFIRM, blockOutward, typedConfirm } from "./confirm.js";
import {
  FORM_ARG,
  formBody,
  formLabel,
  laneCall,
  laneFetch,
  laneProblem,
  noCredential,
  noForm,
  resolveLane,
} from "./lane.js";

/**
 * Wave 1a: a form's own lifecycle — read it, rename it, duplicate it, take it
 * offline, throw staged edits away, point its uploads somewhere, change how it
 * presents itself, and list what has been published.
 *
 * Creating and publishing already have tools (fillo_push_form,
 * fillo_publish_form); everything else a person can do to a form from the
 * dashboard lives here.
 */

export function registerFormLifecycle(server: McpServer): void {
  registerPullForm(server);
  registerRenameForm(server);
  registerDuplicateForm(server);
  registerUnpublishForm(server);
  registerDiscardChanges(server);
  registerDeleteForm(server);
  registerGetStorage(server);
  registerFormStorage(server);
  registerDriveFolders(server);
  registerFormSettings(server);
  registerUpdateFormSettings(server);
  registerFormVersions(server);
}

// ------------------------------------------------------------------ read ---

function registerPullForm(server: McpServer): void {
  server.registerTool(
    "fillo_pull_form",
    {
      title: "Pull a form's schema, theme, and draft",
      description:
        "Read one form as the dashboard sees it: schema, theme, settings, status, and — unlike the " +
        "public fillo_get_form — its UNPUBLISHED staged draft. Use this before editing an existing " +
        "form so an edit is built on what is actually there. Needs a login token (FILLO_TOKEN) or a " +
        "project API key with forms:read; reading the draft also needs forms:write on a key.",
      inputSchema: {
        form: FORM_ARG,
        includeDraft: z
          .boolean()
          .optional()
          .describe("Include the staged draft schema and theme (default true)."),
      },
      annotations: READ_ONLY,
    },
    async ({ form, includeDraft }) => {
      const lane = resolveLane();
      if (!lane) return noCredential("forms:read");

      const searchParams = new URLSearchParams();
      // `include=draft` on both mounts (the CLI lane still answers the older
      // `schema` spelling, which is why nothing branches on the lane here).
      if (includeDraft !== false) searchParams.set("include", "draft");
      const res = await laneFetch(lane, {
        path: `/forms/${encodeURIComponent(form)}`,
        ...(searchParams.size ? { searchParams } : {}),
      });
      const problem = laneProblem(lane, res, {
        scope: "forms:read (plus forms:write for the draft)",
        fallback: "Couldn't read the form",
        missing: noForm(form),
      });
      if (problem) return problem;

      const data = formBody(res.json);
      if (!data || typeof data.id !== "string") {
        return fail("Fillo returned an unexpected form payload. Retry, or use fillo_list_forms.");
      }
      const staged = Boolean(data.draftSchema ?? data.hasDraft ?? data.staged);
      return ok(
        `Form "${formLabel(data, form)}" is ${data.status === "published" ? "published" : "a draft"}` +
          `${staged ? " with unpublished changes staged" : ""}.`,
        data,
      );
    },
  );
}

function registerFormVersions(server: McpServer): void {
  server.registerTool(
    "fillo_list_versions",
    {
      title: "List a form's published versions",
      description:
        "List the schema versions this form has published, newest first (up to 200). Each entry is " +
        "{ id, version, schemaHash, createdAt }. Use it to see when a form's shape last changed — " +
        "responses reference the version they were collected under. Needs forms:read.",
      inputSchema: { form: FORM_ARG },
      annotations: READ_ONLY,
    },
    async ({ form }) => {
      const call = await laneCall(
        { path: `/forms/${encodeURIComponent(form)}/versions` },
        {
          scope: "forms:read",
          fallback: "Couldn't list the form's versions",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const rows = Array.isArray(res.json?.data) ? (res.json.data as unknown[]) : [];
      return ok(
        rows.length
          ? `${plural(rows.length, "published version")}.`
          : "This form has never been published.",
        res.json,
      );
    },
  );
}

// ---------------------------------------------------------------- writes ---

function registerRenameForm(server: McpServer): void {
  server.registerTool(
    "fillo_rename_form",
    {
      title: "Rename a form",
      description:
        "Change a form's name (1–120 characters). The name is what the dashboard and the responses " +
        "grid show; it does not change the form's id, hosted slug, or published schema, so live " +
        "embeds keep working. Needs forms:write.",
      inputSchema: {
        form: FORM_ARG,
        name: z.string().trim().min(1).max(120).describe("The new form name."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form, name }) => {
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}`,
          method: "PATCH",
          body: { name },
        },
        {
          scope: "forms:write",
          fallback: "Couldn't rename the form",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const data = formBody(res.json);
      return ok(`Renamed the form to "${formLabel(data, name)}".`, data);
    },
  );
}

function registerDuplicateForm(server: McpServer): void {
  server.registerTool(
    "fillo_duplicate_form",
    {
      title: "Duplicate a form",
      description:
        "Copy a form into a NEW draft, including any staged edits, its purpose, and its storage " +
        "provider (the Drive folder is re-resolved, not copied). The copy collects nothing until it " +
        "is published. Responses are never copied. Needs forms:write.",
      inputSchema: {
        form: FORM_ARG,
        name: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional()
          .describe('Name for the copy (default "<source name> (copy)").'),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form, name }) => {
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/duplicate`,
          method: "POST",
          body: name ? { name } : {},
        },
        {
          scope: "forms:write",
          fallback: "Couldn't duplicate the form",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const data = formBody(res.json);
      return ok(
        `Copied "${form}" into draft "${formLabel(data, "the copy")}". ` +
          "Publish it with fillo_publish_form when it is ready.",
        data,
      );
    },
  );
}

function registerUnpublishForm(server: McpServer): void {
  server.registerTool(
    "fillo_unpublish_form",
    {
      title: "Take a form offline",
      description:
        "Unpublish a live form. The hosted URL stops accepting responses and any embed rendering it " +
        "goes dark, so this is visible to everyone who can reach the form — ASK THE HUMAN FIRST, " +
        "then pass confirm=true. Existing responses are kept and the form becomes a draft you can " +
        "publish again. Already-draft forms succeed unchanged. Needs forms:write.",
      inputSchema: { form: FORM_ARG, confirm: OUTWARD_CONFIRM },
      annotations: OUTWARD_WRITE,
    },
    async ({ form, confirm }) => {
      const blocked = blockOutward(confirm, `Taking "${form}" offline`);
      if (blocked) return blocked;

      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/unpublish`,
          method: "POST",
          body: {},
        },
        {
          scope: "forms:write",
          fallback: "Couldn't unpublish the form",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const data = formBody(res.json);
      return ok(
        data?.changed === false
          ? `Form "${formLabel(data, form)}" was already offline — nothing changed.`
          : `Took "${formLabel(data, form)}" offline. It is a draft now; fillo_publish_form puts it back.`,
        data,
      );
    },
  );
}

function registerDiscardChanges(server: McpServer): void {
  server.registerTool(
    "fillo_discard_changes",
    {
      title: "Discard a form's staged changes",
      description:
        "Throw away the unpublished draft on a PUBLISHED form, so it goes back to exactly what is " +
        "live. The live form is untouched and no respondent sees anything change. Use it to abandon " +
        "an edit in progress. Nothing staged means nothing to do. Needs forms:write.",
      inputSchema: { form: FORM_ARG },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form }) => {
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/discard`,
          method: "POST",
          body: {},
        },
        {
          scope: "forms:write",
          fallback: "Couldn't discard the staged changes",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        res.json?.changed
          ? `Discarded the staged changes on "${form}" — it matches what is live again.`
          : `Nothing was staged on "${form}".`,
        res.json,
      );
    },
  );
}

// --------------------------------------------------------------- storage ---

function registerFormStorage(server: McpServer): void {
  server.registerTool(
    "fillo_set_storage",
    {
      title: "Set where a form's uploads land",
      description:
        "Choose the destination this form's file uploads go to. Uploads are browser-direct into " +
        'storage the workspace owns: "gdrive", "box", "s3", "r2", Fillo\'s short-lived "transit" ' +
        'staging, or "none" to clear the per-form choice and fall back to the project default. The ' +
        "provider must already be connected for the workspace, and a live form that collects files " +
        "cannot be left without one. Returns the resolved destination. Needs storage:manage.",
      inputSchema: {
        form: FORM_ARG,
        destination: z
          .enum(["gdrive", "box", "s3", "r2", "transit", "none"])
          .describe("Where uploads land. `transit` and `none` both clear the per-form choice."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form, destination }) => {
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/storage`,
          method: "PUT",
          body: { destination },
        },
        {
          scope: "storage:manage",
          fallback: "Couldn't change the upload destination",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `Uploads for "${form}" now resolve to ${res.json?.resolved ?? destination}.`,
        res.json,
      );
    },
  );
}

function registerGetStorage(server: McpServer): void {
  server.registerTool(
    "fillo_get_storage",
    {
      title: "Read where a form's uploads land",
      description:
        "Report this form's upload destination: the per-form choice, the stored config, and the " +
        "`resolved` provider uploads actually reach right now (which can be the workspace default " +
        "or Fillo's transit staging when the form itself picks nothing). Read it before changing " +
        "it. Needs storage:manage — this reports the workspace resolution a write would change.",
      inputSchema: { form: FORM_ARG },
      annotations: READ_ONLY,
    },
    async ({ form }) => {
      const call = await laneCall(
        { path: `/forms/${encodeURIComponent(form)}/storage` },
        {
          scope: "storage:manage",
          fallback: "Couldn't read the upload destination",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `Uploads for "${form}" resolve to ${res.json?.resolved ?? "nothing yet"} (choice: ${res.json?.destination ?? "none"}).`,
        res.json,
      );
    },
  );
}

/**
 * Google Drive's folder step, as three tools rather than one switch. Listing is
 * a read, pinning and clearing are writes, and a client that shows annotations
 * can only say so honestly when they are separate.
 */
function registerDriveFolders(server: McpServer): void {
  const FOLDER_PATH = (form: string) => `/forms/${encodeURIComponent(form)}/storage/folder`;

  server.registerTool(
    "fillo_list_drive_folders",
    {
      title: "List the Google Drive folders a form can use",
      description:
        "List the folders the connected Google account offers for this form's uploads, plus the " +
        "one currently pinned. Filter by name with `q`. Call this to find an id for " +
        "fillo_set_drive_folder. Google Drive only — other providers have no folder step. Needs " +
        "storage:manage.",
      inputSchema: {
        form: FORM_ARG,
        q: z.string().trim().min(1).optional().describe("Filter the listed folders by name."),
      },
      annotations: READ_ONLY,
    },
    async ({ form, q }) => {
      const searchParams = new URLSearchParams();
      if (q) searchParams.set("q", q);
      const call = await laneCall(
        {
          path: FOLDER_PATH(form),
          ...(searchParams.size ? { searchParams } : {}),
        },
        {
          scope: "storage:manage",
          fallback: "Couldn't list the upload folders",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      const folders = Array.isArray(res.json?.folders) ? (res.json.folders as unknown[]) : [];
      return ok(
        `Current folder: ${res.json?.folder?.name ?? "none pinned"}. ${plural(folders.length, "folder")} available — pass one's id to fillo_set_drive_folder.`,
        res.json,
      );
    },
  );

  server.registerTool(
    "fillo_set_drive_folder",
    {
      title: "Pin a form's Google Drive upload folder",
      description:
        "Send this form's uploads to a specific Google Drive folder. Get the id from " +
        "fillo_list_drive_folders; the folder must be reachable by the connected Google account. " +
        "Files already uploaded stay where they are. Needs storage:manage.",
      inputSchema: {
        form: FORM_ARG,
        folderId: z
          .string()
          .trim()
          .min(1)
          .describe("Drive folder id from fillo_list_drive_folders."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form, folderId }) => {
      const call = await laneCall(
        {
          path: FOLDER_PATH(form),
          method: "PUT",
          body: { folderId },
        },
        {
          scope: "storage:manage",
          fallback: "Couldn't pin that upload folder",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(
        `Uploads for "${form}" now land in "${res.json?.folder?.name ?? folderId}".`,
        res.json,
      );
    },
  );

  server.registerTool(
    "fillo_reset_drive_folder",
    {
      title: "Clear a form's pinned Drive folder",
      description:
        "Stop pinning a Google Drive folder for this form, so Fillo goes back to creating its own " +
        "per-form folder. Files already uploaded stay where they are. Needs storage:manage.",
      inputSchema: { form: FORM_ARG },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form }) => {
      const call = await laneCall(
        { path: FOLDER_PATH(form), method: "DELETE" },
        {
          scope: "storage:manage",
          fallback: "Couldn't clear the upload folder",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Cleared the pinned Drive folder for "${form}".`, res.json);
    },
  );
}

function registerDeleteForm(server: McpServer): void {
  server.registerTool(
    "fillo_delete_form",
    {
      title: "Delete a form",
      description:
        "Permanently delete a form, its responses, and its uploaded files. This CANNOT be undone. " +
        "`confirm` must be the form's exact title (not its id or slug) — read it with " +
        "fillo_pull_form and have the human confirm that title. A published form is refused unless " +
        "alsoUnpublish is true, so taking something live offline is never an accident. Needs a " +
        "LOGIN TOKEN: deleting a form has no project-API-key route.",
      inputSchema: {
        form: FORM_ARG,
        confirm: typedConfirm("form title, exactly as fillo_pull_form reports its name"),
        alsoUnpublish: z
          .boolean()
          .optional()
          .describe("Take a live form offline as part of deleting it."),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ form, confirm, alsoUnpublish }) => {
      const lane = resolveLane();
      if (!lane) return noCredential("(login token only)");
      if (lane.kind !== "cli") {
        return fail(
          "Deleting a form needs a login token. Run `npx @usefillo/cli login` or set FILLO_TOKEN — " +
            "there is deliberately no project-API-key route for it.",
        );
      }

      const res = await laneFetch(lane, {
        path: `/forms/${encodeURIComponent(form)}`,
        method: "DELETE",
        body: { confirm, ...(alsoUnpublish === undefined ? {} : { alsoUnpublish }) },
      });
      const problem = laneProblem(lane, res, {
        scope: "(login token only)",
        fallback: "Couldn't delete the form",
        missing: noForm(form),
      });
      if (problem) return problem;

      return ok(
        `Deleted form "${form}" and everything it collected. This cannot be undone.`,
        res.json,
      );
    },
  );
}

// -------------------------------------------------------------- settings ---

/** Every key the settings patch accepts, shared by the read and write tools'
 *  copy so the two can never describe different surfaces. */
const SETTINGS_KEYS =
  "submitMode, submitLabel, successTitle, successMessage, redirectUrl, showProgress, notifyEmail, " +
  "sendReceipt, saveProgress, draftAnswersVisible, resumeEmails, resumeUrl, draftDigest, " +
  "responseLimit, trust";

function registerFormSettings(server: McpServer): void {
  server.registerTool(
    "fillo_get_settings",
    {
      title: "Read a form's settings",
      description:
        "Read one form's operational settings — how it submits, what the success state says, where " +
        `it redirects, notifications, saved progress, response limits, and trust policy (${SETTINGS_KEYS}). ` +
        "Read these before patching them with fillo_update_settings. Needs settings:manage.",
      inputSchema: { form: FORM_ARG },
      annotations: READ_ONLY,
    },
    async ({ form }) => {
      const call = await laneCall(
        { path: `/forms/${encodeURIComponent(form)}/settings` },
        {
          scope: "settings:manage",
          fallback: "Couldn't read the form's settings",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Settings for "${form}".`, res.json);
    },
  );
}

function registerUpdateFormSettings(server: McpServer): void {
  server.registerTool(
    "fillo_update_settings",
    {
      title: "Update a form's settings",
      description:
        "Patch one form's operational settings. Send only the keys you are changing; null clears a " +
        `key back to its default. At least one key is required. Accepted: ${SETTINGS_KEYS}. ` +
        "The presentation keys (submitMode, submitLabel, successTitle, successMessage, " +
        "redirectUrl, showProgress) live inside the form's definition: they are rejected on " +
        "code-managed forms — change those in the code that defines the form — and on a project " +
        "API key they need forms:write as well as settings:manage. Returns the saved settings as " +
        "Fillo normalized them. Needs settings:manage.",
      inputSchema: {
        form: FORM_ARG,
        settings: z
          .record(z.string(), z.unknown())
          .describe(
            'The patch, e.g. { "submitLabel": "Send request", "redirectUrl": null }. Unknown keys are rejected.',
          ),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ form, settings }) => {
      if (!settings || Object.keys(settings).length === 0) {
        return fail(
          "Send at least one setting to change. Read the current ones first with fillo_get_settings.",
        );
      }
      const call = await laneCall(
        {
          path: `/forms/${encodeURIComponent(form)}/settings`,
          method: "PATCH",
          // The patch object IS the body on both mounts — no wrapper.
          body: settings,
        },
        {
          // The route asserts forms:write on top when the patch names a
          // presentation key, and its 403 says which scope is missing — so the
          // "mint a key carrying …" hint names both.
          scope: "settings:manage (plus forms:write for the presentation keys)",
          fallback: "Couldn't update the form's settings",
          missing: noForm(form),
        },
      );
      if (!call.ok) return call.result;
      const { res } = call;

      return ok(`Updated ${Object.keys(settings).join(", ")} on "${form}".`, res.json);
    },
  );
}
