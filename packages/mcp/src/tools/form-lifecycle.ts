import { localCapability } from "../capabilities.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, plural } from "../result.js";
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
  registerImportLogo(server);
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
      title: localCapability("fillo_pull_form").title,
      description: localCapability("fillo_pull_form").description,
      inputSchema: {
        form: FORM_ARG,
        includeDraft: z
          .boolean()
          .optional()
          .describe("Include the staged draft schema and theme (default true)."),
      },
      annotations: localCapability("fillo_pull_form").annotations,
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
      title: localCapability("fillo_list_versions").title,
      description: localCapability("fillo_list_versions").description,
      inputSchema: { form: FORM_ARG },
      annotations: localCapability("fillo_list_versions").annotations,
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
      title: localCapability("fillo_rename_form").title,
      description: localCapability("fillo_rename_form").description,
      inputSchema: {
        form: FORM_ARG,
        name: z.string().trim().min(1).max(120).describe("The new form name."),
      },
      annotations: localCapability("fillo_rename_form").annotations,
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
      title: localCapability("fillo_duplicate_form").title,
      description: localCapability("fillo_duplicate_form").description,
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
      annotations: localCapability("fillo_duplicate_form").annotations,
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

function registerImportLogo(server: McpServer): void {
  server.registerTool(
    "fillo_import_logo",
    {
      title: localCapability("fillo_import_logo").title,
      description: localCapability("fillo_import_logo").description,
      inputSchema: {
        url: z.string().trim().url().max(2048).describe("Public https URL of the image."),
      },
      annotations: localCapability("fillo_import_logo").annotations,
    },
    async ({ url }) => {
      const call = await laneCall(
        { path: "/assets", method: "POST", body: { url } },
        { scope: "forms:write", fallback: "Couldn't import the image" },
      );
      if (!call.ok) return call.result;

      const data = formBody(call.res.json);
      const id = typeof data?.id === "string" ? data.id : undefined;
      if (!id) return fail("Fillo accepted the image but returned no id. Try again.");
      return ok(
        `Imported the image as "${id}". Set theme.logo (or theme.dark.logo for dark mode) to ` +
          "that id and save the theme with fillo_push_form.",
        data,
      );
    },
  );
}

function registerUnpublishForm(server: McpServer): void {
  server.registerTool(
    "fillo_unpublish_form",
    {
      title: localCapability("fillo_unpublish_form").title,
      description: localCapability("fillo_unpublish_form").description,
      inputSchema: { form: FORM_ARG, confirm: OUTWARD_CONFIRM },
      annotations: localCapability("fillo_unpublish_form").annotations,
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
      title: localCapability("fillo_discard_changes").title,
      description: localCapability("fillo_discard_changes").description,
      inputSchema: { form: FORM_ARG },
      annotations: localCapability("fillo_discard_changes").annotations,
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
      title: localCapability("fillo_set_storage").title,
      description: localCapability("fillo_set_storage").description,
      inputSchema: {
        form: FORM_ARG,
        destination: z
          .enum(["gdrive", "box", "s3", "r2", "transit", "none"])
          .describe("Where uploads land. `transit` and `none` both clear the per-form choice."),
      },
      annotations: localCapability("fillo_set_storage").annotations,
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
      title: localCapability("fillo_get_storage").title,
      description: localCapability("fillo_get_storage").description,
      inputSchema: { form: FORM_ARG },
      annotations: localCapability("fillo_get_storage").annotations,
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
      title: localCapability("fillo_list_drive_folders").title,
      description: localCapability("fillo_list_drive_folders").description,
      inputSchema: {
        form: FORM_ARG,
        q: z.string().trim().min(1).optional().describe("Filter the listed folders by name."),
      },
      annotations: localCapability("fillo_list_drive_folders").annotations,
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
      title: localCapability("fillo_set_drive_folder").title,
      description: localCapability("fillo_set_drive_folder").description,
      inputSchema: {
        form: FORM_ARG,
        folderId: z
          .string()
          .trim()
          .min(1)
          .describe("Drive folder id from fillo_list_drive_folders."),
      },
      annotations: localCapability("fillo_set_drive_folder").annotations,
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
      title: localCapability("fillo_reset_drive_folder").title,
      description: localCapability("fillo_reset_drive_folder").description,
      inputSchema: { form: FORM_ARG },
      annotations: localCapability("fillo_reset_drive_folder").annotations,
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
      title: localCapability("fillo_delete_form").title,
      description: localCapability("fillo_delete_form").description,
      inputSchema: {
        form: FORM_ARG,
        confirm: typedConfirm("form title, exactly as fillo_pull_form reports its name"),
        alsoUnpublish: z
          .boolean()
          .optional()
          .describe("Take a live form offline as part of deleting it."),
      },
      annotations: localCapability("fillo_delete_form").annotations,
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

function registerFormSettings(server: McpServer): void {
  server.registerTool(
    "fillo_get_settings",
    {
      title: localCapability("fillo_get_settings").title,
      description: localCapability("fillo_get_settings").description,
      inputSchema: { form: FORM_ARG },
      annotations: localCapability("fillo_get_settings").annotations,
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
      title: localCapability("fillo_update_settings").title,
      description: localCapability("fillo_update_settings").description,
      inputSchema: {
        form: FORM_ARG,
        settings: z
          .record(z.string(), z.unknown())
          .describe(
            'The patch, e.g. { "submitLabel": "Send request", "redirectUrl": null }. Unknown keys are rejected.',
          ),
      },
      annotations: localCapability("fillo_update_settings").annotations,
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
