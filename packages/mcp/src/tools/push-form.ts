import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiOrigin, resolvePk, resolveToken } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { PUBLIC_IDEMPOTENT_WRITE } from "./annotations.js";

export function registerPushForm(server: McpServer): void {
  server.registerTool(
    "fillo_push_form",
    {
      title: "Create or update a Fillo form",
      description:
        "Create or update a form from a FormSchema plus a stable handle (an idempotent id — reuse " +
        "it to update the same form). Needs a credential: a login token (FILLO_TOKEN / `fillo login`) " +
        "publishes regular forms directly by default, while setup-first file requests stay draft for review and " +
        "then use fillo_publish_form. A `pk_` publishable key (from fillo_provision_workspace) takes a regular form " +
        "live on an unclaimed preview workspace, or stages a draft for review once the workspace is " +
        "claimed. If neither is set, run fillo_provision_workspace or `fillo login` first. The server " +
        "validates the schema and returns the form id, status, and hosted URL; embed it with " +
        '<FilloForm formId="…" />. Handle: letters, digits, dashes, max 64 chars.',
      inputSchema: {
        handle: z
          .string()
          .describe(
            "Stable idempotent form id (letters, digits, dashes, max 64). Reuse to update.",
          ),
        schema: z
          .record(z.string(), z.unknown())
          .describe("The FormSchema object: title, pages (with blocks/fields), and settings."),
        theme: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Optional theme tokens (colorScheme, primary, background, text, radius, fontFamily).",
          ),
        storage: z
          .enum(["gdrive", "box", "s3", "r2"])
          .optional()
          .describe("Optional exact storage destination. Required with purpose=file_request."),
        purpose: z
          .literal("file_request")
          .optional()
          .describe("Preserve the file-request upload invariant and setup journey."),
        publish: z
          .boolean()
          .optional()
          .describe(
            "Publish after writing (default true). Set false only for an explicitly requested draft/review; draft-only pushes require a login token.",
          ),
      },
      annotations: PUBLIC_IDEMPOTENT_WRITE,
    },
    async ({ handle, schema, theme, storage, purpose, publish }) => {
      const token = resolveToken();
      if (token) {
        const res = await filloFetch("/api/v1/cli/forms", {
          method: "POST",
          token,
          body: {
            handle,
            schema,
            theme: theme ?? null,
            ...(storage ? { storage } : {}),
            ...(purpose ? { purpose } : {}),
            // The server keeps file-request creates/revisions review-first even
            // when this ordinary token can publish regular forms directly.
            publish: publish !== false,
          },
        });
        if (!res.ok) {
          const warning = typeof res.json?.warning === "string" ? res.json.warning : undefined;
          const warningUrl =
            typeof res.json?.warningUrl === "string" ? res.json.warningUrl : undefined;
          const message = apiErrorMessage(res, "Couldn't push the form");
          return fail(message + (warningUrl ? ` Fix storage here: ${warningUrl}` : ""), {
            ...(warning ? { warning } : {}),
            ...(warningUrl ? { warningUrl } : {}),
          });
        }
        if (typeof res.json?.formId !== "string") {
          return fail(
            "Fillo returned an invalid push response. Verify the result with fillo_list_forms.",
          );
        }
        const { formId, slug, url, updated, warning, warningUrl } = res.json;
        const status = res.json.status === "draft" ? "draft" : "published";
        const live = status === "published" && url ? url : undefined;
        const warningText =
          (typeof warning === "string" && warning ? ` Note: ${warning}` : "") +
          (typeof warningUrl === "string" && warningUrl ? ` Storage settings: ${warningUrl}.` : "");
        return ok(
          status === "published"
            ? `${updated ? "Updated" : "Published"} form "${formId}"${live ? `, live at ${live}` : ""}. ` +
                `Embed it with <FilloForm formId="${formId}" />.` +
                warningText
            : publish === false && !warning
              ? `Saved form "${formId}" as a private review draft. Use fillo_publish_form when it is ready.`
              : `Saved form "${formId}" as a draft for storage setup and final preview. ` +
                `Use fillo_publish_form after review.` +
                warningText,
          {
            mode: "token",
            formId,
            slug,
            url: live,
            status,
            updated: !!updated,
            ...(typeof warning === "string" ? { warning } : {}),
            ...(typeof warningUrl === "string" ? { warningUrl } : {}),
          },
        );
      }

      const pk = resolvePk();
      if (pk) {
        if (publish === false) {
          return fail(
            "A draft-only push needs a login token because an unclaimed preview key may publish immediately. Run `npx @usefillo/cli login`, then retry with publish=false.",
          );
        }
        const res = await filloFetch("/api/v1/forms/sync", {
          method: "POST",
          body: {
            key: pk,
            id: handle,
            schema,
            theme: theme ?? null,
            ...(storage ? { storage } : {}),
            ...(purpose ? { purpose } : {}),
          },
        });
        // The sync route can answer 200 with a soft `syncError` (e.g. a claimed
        // workspace that requires a trusted credential) — surface it as a failure.
        if (!res.ok || typeof res.json?.formId !== "string" || res.json?.syncError) {
          const syncError = res.json?.syncError;
          const message =
            (syncError && typeof syncError.message === "string" && syncError.message) ||
            apiErrorMessage(res, "Couldn't sync the form");
          return fail(message, syncError?.code ? { code: syncError.code } : undefined);
        }
        const { formId, slug, status, staged, warning, warningUrl } = res.json;
        const live = status === "published" && slug ? `${apiOrigin()}/f/${slug}` : undefined;
        const label =
          status === "published"
            ? `Live at ${live}`
            : staged
              ? "Staged as a draft for dashboard review"
              : "Saved as a draft";
        return ok(
          `Synced form "${formId}" (${status ?? "draft"}). ${label}. ` +
            `Embed it with <FilloForm formId="${formId}" />.` +
            (warning ? ` Note: ${warning}` : "") +
            (warningUrl ? ` Storage settings: ${warningUrl}.` : ""),
          {
            mode: "publishable-key",
            formId,
            slug,
            status,
            staged: !!staged,
            url: live,
            ...(typeof warning === "string" ? { warning } : {}),
            ...(typeof warningUrl === "string" ? { warningUrl } : {}),
          },
        );
      }

      return fail(
        "No credential to push with. Run fillo_provision_workspace for a preview workspace, or set " +
          "FILLO_TOKEN (or `npx @usefillo/cli login`) to publish to an existing account.",
      );
    },
  );
}
