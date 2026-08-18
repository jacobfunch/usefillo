import { isField, type Block, type Field, type FieldValue, type FormSchema, type ResponseData } from "./types.js";
import { isTerminalPage, reachableFields } from "./logic.js";
import { validateResponse } from "./validation.js";
import type { FormStatus } from "./controller.js";

/**
 * The auto-submit decision, shared by every renderer (react, dom, and any
 * future surface) so "one tap, no button" behaves identically everywhere.
 */

export function isAutoSubmitBlock(block: Block): boolean {
  // A repeating_group is deliberately NEVER in this list (contract decision
  // 11): it is a multi-interaction container (add/remove/fill), so there is no
  // single discrete "answer moment" to submit on. It also counts as an
  // interactive question in needsExplicitSubmit and shouldAutoSubmit's
  // interactive filters (unlike hidden/calculated), so a page holding a group
  // always shows a button and never one-taps.
  return (
    isField(block) &&
    (block.kind === "select" ||
      block.kind === "dropdown" ||
      block.kind === "checkbox" ||
      block.kind === "rating" ||
      block.kind === "linear_scale")
  );
}

/**
 * Whether an auto-submit form still needs a visible submit button. Only a
 * single visible field that can auto-submit goes button-less; more than one
 * visible field → always a button. (Pass the visible blocks.)
 */
export function needsExplicitSubmit(visible: Block[]): boolean {
  // Hidden metadata fields and calculated display rows aren't questions the
  // user answers — exclude them so a single auto-submitting question stays
  // button-less even alongside them.
  const interactive = visible.filter(
    (b): b is Field => isField(b) && b.kind !== "hidden" && b.kind !== "calculated",
  );
  // Zero questions cannot trigger auto-submit, so they need a button. Exactly
  // one eligible discrete field is the only safely button-less shape.
  if (interactive.length !== 1) return true;
  return !isAutoSubmitBlock(interactive[0]!);
}

export interface AutoSubmitContext {
  form: FormSchema;
  data: ResponseData;
  status: FormStatus;
  /** Terminal-aware last-page flag from the controller. Advisory here —
   *  shouldAutoSubmit re-derives terminal from the RESULTING data (see below). */
  isLastPage: boolean;
  uploading: boolean;
}

export function shouldAutoSubmit(
  field: Field,
  value: FieldValue,
  ctx: AutoSubmitContext,
): boolean {
  if (ctx.form.settings.submitMode !== "auto") return false;
  if (ctx.status !== "idle" || ctx.uploading) return false;

  const hasDiscreteAnswer = (() => {
    switch (field.kind) {
      case "select":
      case "dropdown":
        return typeof value === "string" && field.options.some((option) => option.id === value);
      case "checkbox":
        return value === true;
      case "rating":
      case "linear_scale":
        return typeof value === "number";
      default:
        return false;
    }
  })();
  if (!hasDiscreteAnswer) return false;

  // The auto-submit-eligible kinds all carry primitive values. If this change
  // didn't actually move the field's value, the form's validity is unchanged
  // from the previous render — and had it been valid+submittable then, it would
  // already have submitted (status would no longer be "idle"). So skip the
  // O(form) validateResponse on no-op re-selections.
  if (value === ctx.data[field.id]) return false;

  const nextData = { ...ctx.data, [field.id]: value };
  // The answer must leave the form on a TERMINAL page — the last reachable page,
  // or a page whose jump rule now resolves to "end". Derived from the resulting
  // data via the same shared engine the validator uses, NOT the pre-answer
  // ctx.isLastPage: a renderer builds ctx from the snapshot BEFORE this change is
  // applied, so an answer that itself triggers a jump→end would look non-terminal
  // and strand a one-tap early-end respondent (no button, no auto-submit).
  const page = ctx.form.pages.find((p) => p.blocks.some((b) => b.id === field.id));
  if (!page || !isTerminalPage(ctx.form, page.id, nextData)) return false;

  // Auto-submit only a genuine single-question form: this answer must leave
  // exactly ONE field the user actually interacts with (this one). Hidden
  // metadata fields (page url, user id, …) and calculated display rows don't
  // count, so "thumbs up/down + hidden page" still one-taps. A revealed second
  // question shows a button.
  // Reachable (not merely visible) so an answer that ends the form early via a
  // jump leaves just this page's question in play; identical for no-jump forms.
  const interactive = reachableFields(ctx.form, nextData).filter(
    (f) => f.kind !== "hidden" && f.kind !== "calculated",
  );
  if (interactive.length !== 1 || interactive[0]?.id !== field.id) return false;

  return validateResponse(ctx.form, nextData).ok;
}
