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
 *            told — here and in the tool description — to ask the person first.
 *   Tier C — destructive. Irreversible or credential-revoking. `confirm` is the
 *            target typed out exactly; the server compares it and 409s on a
 *            mismatch, so a guessed value can never delete anything.
 *
 * This is the same gate `fillo <command> --confirm` implements for a human at a
 * terminal. The boolean cannot be inferred from context and the string cannot be
 * derived from the tool's own arguments without the person supplying it, which
 * is the point: consent has to enter the loop from outside the model.
 */

/** Tier B. Optional so the refusal (not a schema error) can carry the reason. */
export const OUTWARD_CONFIRM = z
  .boolean()
  .optional()
  .describe(
    "Set true ONLY after the human has approved this action. Ask them first and quote what it " +
      "will do — never set this on your own initiative.",
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
    `${action} reaches beyond this workspace, so it needs a person's go-ahead. Tell the human ` +
      "exactly what it will do, wait for their answer, then call this tool again with " +
      "confirm=true. Nothing has changed.",
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
      `The exact ${target}, typed to authorize this irreversible action. Ask the human to ` +
        "confirm it first — do not fill this in from context on your own.",
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
