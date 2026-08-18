import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveToken } from "../config.js";
import { apiErrorMessage, filloFetch } from "../http.js";
import { fail, ok } from "../result.js";
import { PUBLIC_IDEMPOTENT_WRITE } from "./annotations.js";

export function registerPublishForm(server: McpServer): void {
  server.registerTool(
    "fillo_publish_form",
    {
      title: "Publish a Fillo form",
      description:
        "Take a draft form or staged changes live. Needs a login token (FILLO_TOKEN or " +
        "`npx @usefillo/cli login`); a `pk_` publishable key cannot complete this owner action. " +
        "The form may be identified by id, slug, or stable push handle. Publishing is idempotent: " +
        "an already-live form with nothing staged succeeds unchanged. If existing responses use " +
        "fields the staged schema removes or re-types, confirm with the user before retrying with " +
        "allowBreaking=true. File forms must have ready storage before they can go live.",
      inputSchema: {
        form: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Form id, hosted slug, or stable push handle."),
        allowBreaking: z
          .boolean()
          .optional()
          .describe(
            "Acknowledge removing or re-typing fields that existing responses answered. Confirm with the user first.",
          ),
      },
      annotations: PUBLIC_IDEMPOTENT_WRITE,
    },
    async ({ form, allowBreaking }) => {
      const token = resolveToken();
      if (!token) {
        return fail(
          "Publishing needs a login token. Set FILLO_TOKEN or run `npx @usefillo/cli login`, then retry. " +
            "A publishable key can create or stage a form, but it cannot complete this owner action.",
        );
      }

      const res = await filloFetch(`/api/v1/cli/forms/${encodeURIComponent(form)}/publish`, {
        method: "POST",
        token,
        body: allowBreaking === undefined ? {} : { allowBreaking },
      });
      if (res.status === 401) {
        return fail(
          "Login token is invalid or expired. Run `npx @usefillo/cli login`, or set a fresh FILLO_TOKEN.",
        );
      }
      if (!res.ok) {
        const warningUrl =
          typeof res.json?.warningUrl === "string" ? res.json.warningUrl : undefined;
        const breaking = res.json?.code === "breaking_changes";
        const message = apiErrorMessage(res, "Couldn't publish the form");
        return fail(
          message +
            (warningUrl ? ` Fix it here: ${warningUrl}` : "") +
            (breaking
              ? " Re-run fillo_publish_form with allowBreaking=true after confirming with the user."
              : ""),
          {
            ...(typeof res.json?.code === "string" ? { code: res.json.code } : {}),
            ...(typeof res.json?.warningCode === "string"
              ? { warningCode: res.json.warningCode }
              : {}),
            ...(warningUrl ? { warningUrl } : {}),
            ...(Array.isArray(res.json?.breakingFields)
              ? { breakingFields: res.json.breakingFields }
              : {}),
          },
        );
      }

      const published = res.json?.form;
      if (
        !published ||
        typeof published !== "object" ||
        typeof published.id !== "string" ||
        typeof published.slug !== "string" ||
        published.status !== "published" ||
        typeof published.url !== "string" ||
        typeof res.json?.changed !== "boolean"
      ) {
        return fail(
          "Fillo returned an invalid publish response. Verify the result with fillo_get_form.",
        );
      }
      const changed = res.json.changed;
      const name = typeof published.name === "string" ? published.name : published.id;
      return ok(
        changed
          ? `Published "${name}" — live at ${published.url}.`
          : `Form "${name}" is already live with nothing staged.`,
        {
          formId: published.id,
          slug: published.slug,
          status: "published",
          changed,
          url: published.url,
        },
      );
    },
  );
}
