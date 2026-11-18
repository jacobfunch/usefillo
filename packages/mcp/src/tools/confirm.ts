import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fail } from "../result.js";

/**
 * The human layer, expressed as tool input.
 *
 * Fillo sorts every agent-reachable action into three tiers, and the tier is a
 * property of the action, not of who asked:
 *
 *   Tier A — routine. Reversible or contained. Runs on the credential alone.
 *   Tier B — outward. It reaches past the workspace or changes who can act
 *            (publishing, starting a third-party destination, releasing held
 *            responses, inviting a member). `confirm: true`, and the model is
 *            tied to the user's authorization in the task or workflow.
 *   Tier C — destructive. Irreversible or credential-revoking. `confirm` is the
 *            target typed out exactly; the server compares it and 409s on a
 *            mismatch, so a guessed value can never delete anything.
 *
 * These inputs record authorization already given in the user's request or
 * a subsequent answer. The server still enforces scopes, roles, and targets.
 * A boolean or typed string supplied by a model cannot prove human presence.
 */

/** Tier B. Optional so the refusal (not a schema error) can carry the reason. */
export const OUTWARD_CONFIRM = z
  .boolean()
  .optional()
  .describe(
    "Set true when the user has authorized this action on the specified target in the task or " +
      "workflow. Ask only if that authorization is missing.",
  );

/**
 * Refuse a Tier B call that arrived without consent. Returns undefined when the
 * human has approved it and the tool may proceed.
 */
export function blockOutward(
  confirm: boolean | undefined,
  action: string,
): CallToolResult | undefined {
  if (confirm === true) return undefined;
  return fail(
    `${action} requires the user's authorization. If the human already requested this action ` +
      "on this target, call again with confirm=true. Otherwise explain the action and ask for " +
      "their decision. Nothing has changed.",
  );
}

/**
 * Tier C. `target` names the value the human must type — always the same value
 * the server compares against, so the 409 on a mismatch quotes something the
 * person can verify and retry with.
 */
export function typedConfirm(target: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(256)
    .describe(
      `The exact ${target} for this irreversible action. Supply it only when the user explicitly ` +
        "authorized this action on this target. Otherwise ask for their decision.",
    );
}

/**
 * The local half of a Tier C gate, for the one route pair whose scoped mount
 * takes no body `confirm` (deleting a response by id). Everywhere else the
 * server owns the comparison and this is not used.
 */
export function mismatch(confirm: string, expected: string, target: string): CallToolResult | null {
  if (confirm.trim() === expected.trim()) return null;
  return fail(
    `The confirm value must be exactly the ${target} ("${expected}") — nothing was changed.`,
  );
}
