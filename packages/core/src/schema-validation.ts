// zod/mini (tree-shakeable v4 API): normalizeFormSchema is on the SDK render
// path, so keep the classic zod barrel out of consumer bundles.
import * as z from "zod/mini";
import type {
  Block,
  CalcExpr,
  Condition,
  Field,
  FieldKind,
  FormPage,
  FormSchema,
  FormSettings,
  FormTheme,
  JumpRule,
  RepeatingGroupField,
  SelectOption,
} from "./types.js";
import { isField } from "./types.js";

/**
 * Boundary validation for a whole FormSchema. Server routes use this before
 * storing user/authored schemas; SDK renderers also run it before rendering
 * server-provided schemas. The output is safe for render loops and validators:
 * required per-kind arrays/strings exist, numeric ranges are clamped, and
 * active URL/CSS values are constrained to data-only values.
 */

const FIELD_KINDS = [
  "short_text",
  "long_text",
  "email",
  "url",
  "phone",
  "number",
  "select",
  "multi_select",
  "dropdown",
  "checkbox",
  "rating",
  "linear_scale",
  "ranking",
  "matrix",
  "signature",
  "date",
  "file_upload",
  "hidden",
  "calculated",
  "repeating_group",
  "custom",
] as const;
const CONTENT_KINDS = ["heading", "paragraph", "divider"] as const;
const ALL_KINDS = [...FIELD_KINDS, ...CONTENT_KINDS] as const;

const idSchema = z.string().check(z.minLength(1), z.maxLength(128));
// looseObject = passthrough: per-kind fields (min/max/options/etc.) must survive
// the parse so normalizeBlock can read them off the raw block.
const optionSchema = z.looseObject({
  id: idSchema,
  label: z.string().check(z.maxLength(1000)),
  icon: z.optional(z.unknown()),
});

const blockSchema = z.looseObject({
  id: idSchema,
  kind: z.enum(ALL_KINDS),
  label: z.optional(z.string().check(z.maxLength(2000))),
  options: z.optional(z.array(optionSchema).check(z.maxLength(200))),
  rows: z.optional(z.array(optionSchema).check(z.maxLength(200))),
  columns: z.optional(z.array(optionSchema).check(z.maxLength(200))),
});

const pageSchema = z.object({
  id: idSchema,
  title: z.optional(z.string().check(z.maxLength(500))),
  blocks: z.array(blockSchema).check(z.maxLength(500)),
  // Optional conditional page flow. Kept as unknown here (this schema is strict,
  // so it would otherwise be dropped at parse) and normalized by hand below once
  // the page-id set is known — a jump to a missing page is dropped, never kept.
  next: z.optional(z.unknown()),
});

const schemaShape = z.object({
  version: z.literal(1),
  title: z._default(z.optional(z.string().check(z.maxLength(2000))), ""),
  description: z.optional(z.string().check(z.maxLength(5000))),
  pages: z.array(pageSchema).check(z.minLength(1), z.maxLength(50)),
  settings: z._default(z.optional(z.record(z.string(), z.unknown())), {}),
});

const MAX_SCHEMA_VERSION = 1;
export const FILLO_SCHEMA_VERSION = 1 as const;
declare const __FILLO_SDK_VERSION__: string | undefined;
/** Injected from package.json at build time (tsup define) — never hand-edited. */
export const FILLO_SDK_VERSION =
  typeof __FILLO_SDK_VERSION__ === "string" ? __FILLO_SDK_VERSION__ : "0.0.0-dev";

/**
 * The oldest published @usefillo/* SDK that can still render a form the current
 * server serves. This is a DELIBERATE floor — bump it BY HAND only when a
 * genuinely wire-breaking change ships (a new required request/response field an
 * old SDK can't produce or read). It must never be tied to FILLO_SDK_VERSION:
 * the server used to serve its own build version as the min, so every release
 * 426'd every customer still on an older pinned SDK. Field-kind/schema-shape
 * breaks are gated separately by FILLO_SCHEMA_VERSION, so this floor stays low.
 */
export const FILLO_MIN_SDK_VERSION = "0.4.0";

/**
 * The floor served INSTEAD of FILLO_MIN_SDK_VERSION for challenge-enabled
 * forms: the first release that ships the Turnstile widget. An older SDK passes
 * the base floor but renders no widget, so the server would reject its every
 * submit — the raised floor makes it fail fast with the clear "update
 * @usefillo/*" error instead of a form that silently can't submit.
 */
export const FILLO_CHALLENGE_MIN_SDK_VERSION = "0.9.0";

/**
 * The floor served INSTEAD of FILLO_MIN_SDK_VERSION for forms whose live
 * schema contains a calculated field: the first release that ships the kind.
 * An older SDK's zod enum strips the unknown block, so it renders the form
 * WITHOUT the calc row — piping shows blanks and any visibility/jump rule
 * reading the calc id misbehaves. That's wrong-form-behavior, not merely
 * missing chrome, so it fails fast with the "update @usefillo/*" error
 * instead (the Turnstile-floor precedent; the form GET picks the max of the
 * applicable floors).
 */
export const FILLO_CALC_MIN_SDK_VERSION = "0.11.0";

/**
 * The floor served INSTEAD of FILLO_MIN_SDK_VERSION for forms whose live
 * schema contains a repeating_group field: the first release that ships the
 * kind. Stricter than the calc case (recon risk 5): an old SDK's zod enum
 * doesn't just strip one row, it drops the WHOLE templated section silently —
 * worse than a blank row, because there is no visual trace a question ever
 * existed. Non-negotiable; the form GET picks the max of the applicable
 * floors (the Turnstile/calc precedent).
 */
export const FILLO_GROUP_MIN_SDK_VERSION = "0.13.0";

function str(value: unknown, max: number, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function optionalStr(value: unknown, max: number): string | undefined {
  const s = str(value, max);
  return s === "" ? undefined : s;
}

/** Display affixes (prefix/suffix) keep their edge spacing — a ` kg` suffix
 *  must render as "3 kg", not "3kg", in formatAnswer text — so only
 *  length-cap here. Whitespace-only still means unset. */
function optionalAffix(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.slice(0, max);
  return s.trim() === "" ? undefined : s;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = finite(value);
  if (n === undefined) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function options(value: unknown, max = 200): SelectOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .flatMap((item): SelectOption[] => {
      if (!item || typeof item !== "object") return [];
      const rec = item as Record<string, unknown>;
      const id = str(rec.id, 128);
      const label = str(rec.label, 1000);
      const icon: SelectOption["icon"] =
        rec.icon === "thumbs_up" || rec.icon === "thumbs_down" ? rec.icon : undefined;
      return id && label ? [cleanObject({ id, label, icon })] : [];
    });
}

/** Generalized beyond SelectOption[] (still its main caller) so repeating
 *  groups can reuse the exact same per-block duplicate-id scan for child ids —
 *  the function only ever looked at `.id`. */
function duplicateOptionId(items: readonly { id: string }[]): string | undefined {
  const ids = new Set<string>();
  for (const { id } of items) {
    if (ids.has(id)) return id;
    ids.add(id);
  }
  return undefined;
}

function conditions(value: unknown): Condition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.slice(0, 20).flatMap((item): Condition[] => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const op = rec.op;
    if (
      op !== "eq" &&
      op !== "neq" &&
      op !== "contains" &&
      op !== "gt" &&
      op !== "lt" &&
      op !== "answered" &&
      op !== "not_answered"
    ) {
      return [];
    }
    const fieldId = str(rec.fieldId, 128);
    if (!fieldId) return [];
    const raw = rec.value;
    const value =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? raw
        : undefined;
    return [{ fieldId, op, ...(value !== undefined ? { value } : {}) }];
  });
  return normalized.length ? normalized : undefined;
}

/**
 * Whether every NON-calculated field a jump condition transitively depends on
 * is in `allowed` (a field on the jump's source page or earlier). A condition
 * naming a CALCULATED field really depends on that calc's own sources — its
 * `value` refs and `if.when` refs, chained through other calculated fields —
 * and those may sit on LATER pages even though the calc id itself looks
 * answerable "now". A calc whose transitive sources are all already-given
 * answers is deterministic at jump time, so the calc's own page/position is
 * irrelevant; a later-page source is not. A ref cycle just stops the walk —
 * `validateCalculatedFields` hard-errors cycles right after these rules are
 * built, so no schema carrying one survives normalization anyway.
 */
function jumpDepsAllowed(
  fieldId: string,
  calcRefs: Map<string, Set<string>>,
  allowed: Set<string>,
  seen: Set<string>,
): boolean {
  const refs = calcRefs.get(fieldId);
  if (refs === undefined) return allowed.has(fieldId);
  if (seen.has(fieldId)) return true;
  seen.add(fieldId);
  for (const ref of refs) {
    if (!jumpDepsAllowed(ref, calcRefs, allowed, seen)) return false;
  }
  return true;
}

/**
 * Normalize a page's `next` jump rules. Each rule's `when` runs through the same
 * `conditions()` sanitizer as `visibleIf` (op enum, cap 20, malformed dropped);
 * `to` must be "end" or a page id present in `pageIds`. Every drop below fails
 * safe to LINEAR flow, never an accidental always-jump — a jump can only depend
 * on an answer already given, so the server's final-data reachability walk
 * equals the client's answers-so-far walk. A rule is dropped when it:
 *  - has a dangling target (not "end" and not a real page id);
 *  - is a self-jump (`to` === the source page — it can loop and never advances);
 *  - depends on a field NOT on the source page or an earlier one
 *    (`allowedFieldIds`) — including TRANSITIVELY, through a condition on a
 *    calculated field whose sources sit on a later page (`jumpDepsAllowed`);
 *  - carries a present-but-non-array `when` (object/string/number — malformed,
 *    which must never fall through to an unconditional always-jump);
 *  - supplied a non-empty `when` that sanitizes to nothing.
 * An intentionally empty/absent `when` stays an unconditional jump. Returns
 * undefined when nothing valid survives (absent `next` = linear).
 */
function jumpRules(
  value: unknown,
  pageIds: Set<string>,
  sourceId: string,
  allowedFieldIds: Set<string>,
  calcRefs: Map<string, Set<string>>,
): JumpRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules = value.slice(0, 50).flatMap((item): JumpRule[] => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const to = typeof rec.to === "string" ? rec.to : undefined;
    if (!to || (to !== "end" && !pageIds.has(to))) return [];
    // A self-jump targets the page you're leaving: it can never advance and
    // would loop. Drop it — the page falls back to linear flow.
    if (to === sourceId) return [];
    const rawWhen = rec.when;
    // A present-but-non-array `when` is malformed; it must NOT slip through as an
    // unconditional always-jump. (An absent `when` is a deliberate always-jump.)
    if (rawWhen !== undefined && !Array.isArray(rawWhen)) return [];
    const when = conditions(rawWhen);
    // Author supplied conditions but they all sanitized away → drop (fail safe),
    // never silently promote to an unconditional jump.
    if (Array.isArray(rawWhen) && rawWhen.length > 0 && when === undefined) return [];
    // A jump may only depend on an answer already given — a field on the source
    // page or an earlier one, expanded transitively through calculated fields'
    // refs. A dependency on a LATER page's field would let the client (answers
    // so far) and the server (final data) disagree about which pages are
    // reachable, so drop the rule and fall back to linear.
    if (when && when.some((c) => !jumpDepsAllowed(c.fieldId, calcRefs, allowedFieldIds, new Set())))
      return [];
    return [{ when: when ?? [], to }];
  });
  return rules.length ? rules : undefined;
}

/** Field kinds a calc `value` ref may read (v1): plain numeric answers and
 *  other calculated fields (chaining). Nothing else coerces implicitly. */
const CALC_OPERAND_KINDS: readonly FieldKind[] = ["number", "rating", "linear_scale", "calculated"];

/**
 * Defensively normalize a raw calc AST. Returns null for ANY malformed node —
 * the caller turns that into a HARD error (a calculated field must never be
 * silently dropped or degrade into a differently-computing form): unknown op,
 * blank fieldId, non-finite const, empty/overlong/non-array n-ary args,
 * missing sub/div/round/if operands, an `if` whose `when` isn't an array of
 * well-formed conditions, or runaway nesting. round.decimals clamps to 0–6.
 */
function normalizeCalc(value: unknown, depth = 0): CalcExpr | null {
  if (depth > 32) return null; // runaway nesting — reject, don't stack-overflow
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  switch (rec.op) {
    case "value": {
      const fieldId = str(rec.fieldId, 128);
      return fieldId ? { op: "value", fieldId } : null;
    }
    case "const": {
      const n = finite(rec.value);
      return n === undefined ? null : { op: "const", value: n };
    }
    case "add":
    case "mul":
    case "min":
    case "max": {
      if (!Array.isArray(rec.args) || rec.args.length < 1 || rec.args.length > 50) return null;
      const args: CalcExpr[] = [];
      for (const raw of rec.args) {
        const arg = normalizeCalc(raw, depth + 1);
        if (!arg) return null;
        args.push(arg);
      }
      return { op: rec.op, args };
    }
    case "sub":
    case "div": {
      const left = normalizeCalc(rec.left, depth + 1);
      const right = normalizeCalc(rec.right, depth + 1);
      return left && right ? { op: rec.op, left, right } : null;
    }
    case "round": {
      const arg = normalizeCalc(rec.arg, depth + 1);
      if (!arg) return null;
      return cleanObject({
        op: "round" as const,
        arg,
        decimals: finite(rec.decimals) === undefined ? undefined : int(rec.decimals, 0, 6, 0),
      });
    }
    case "if": {
      if (!Array.isArray(rec.when)) return null;
      // Reuse the standard condition sanitizer, but unlike visibleIf a dropped
      // condition here would silently CHANGE the computed value — so any entry
      // it can't keep makes the whole node malformed (hard error upstream).
      const when = conditions(rec.when) ?? [];
      if (when.length !== rec.when.length) return null;
      const then = normalizeCalc(rec.then, depth + 1);
      const els = normalizeCalc(rec.else, depth + 1);
      return then && els ? { op: "if", when, then, else: els } : null;
    }
    default:
      return null;
  }
}

/** Every fieldId a calc expression reads, recursively: `valueRefs` are the
 *  numeric operands (kind-checked), `whenRefs` come from `if.when` conditions
 *  (any kind, per the Condition model). Both count as dependency edges. */
function collectCalcRefs(expr: CalcExpr, valueRefs: Set<string>, whenRefs: Set<string>): void {
  switch (expr.op) {
    case "value":
      valueRefs.add(expr.fieldId);
      return;
    case "const":
      return;
    case "add":
    case "mul":
    case "min":
    case "max":
      for (const arg of expr.args) collectCalcRefs(arg, valueRefs, whenRefs);
      return;
    case "sub":
    case "div":
      collectCalcRefs(expr.left, valueRefs, whenRefs);
      collectCalcRefs(expr.right, valueRefs, whenRefs);
      return;
    case "round":
      collectCalcRefs(expr.arg, valueRefs, whenRefs);
      return;
    case "if":
      for (const cond of expr.when) whenRefs.add(cond.fieldId);
      collectCalcRefs(expr.then, valueRefs, whenRefs);
      collectCalcRefs(expr.else, valueRefs, whenRefs);
      return;
  }
}

/**
 * Normalize + structurally validate every calculated field once the whole
 * field universe is known. These are HARD errors with fix-it messages (the
 * duplicate-id style), never silent drops: a calculated field that degraded
 * would compute a different number in every downstream consumer. Writes the
 * normalized calc AST back onto the block. `childToGroup` names the
 * repeating-group scope wall (decision 3) in the missing-field message when a
 * "missing" ref actually exists, just one scope too deep. Returns an error,
 * or null.
 */
function validateCalculatedFields(pages: FormPage[], childToGroup: Map<string, string>): string | null {
  const kinds = new Map<string, FieldKind>();
  for (const page of pages) {
    for (const block of page.blocks) if (isField(block)) kinds.set(block.id, block.kind);
  }

  // id → the calculated ids it references (value refs AND if.when refs) —
  // the dependency edges the cycle check below walks.
  const deps = new Map<string, string[]>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== "calculated") continue;
      const calc = normalizeCalc(block.calc);
      if (!calc) {
        return `Field ${block.id} has a malformed calc expression — build it from value/const/add/sub/mul/div/min/max/round/if nodes`;
      }
      block.calc = calc;
      const valueRefs = new Set<string>();
      const whenRefs = new Set<string>();
      collectCalcRefs(calc, valueRefs, whenRefs);
      for (const ref of valueRefs) {
        const kind = kinds.get(ref);
        if (kind === undefined) {
          const owningGroup = childToGroup.get(ref);
          if (owningGroup !== undefined) {
            return `Calculated field ${block.id} references ${ref}, which is a child of repeating group ${owningGroup} — calculations can't reach inside a repeating group (calc operands must be top-level fields)`;
          }
          return `Calculated field ${block.id} references a missing field: ${ref} — remove the reference or restore that field`;
        }
        if (!CALC_OPERAND_KINDS.includes(kind)) {
          return `Calculated field ${block.id} references non-numeric field ${ref} (${kind}) — calculations can read number, rating, linear_scale, and calculated fields only`;
        }
      }
      deps.set(
        block.id,
        [...valueRefs, ...whenRefs].filter((ref) => kinds.get(ref) === "calculated"),
      );
    }
  }

  // Cycle check — self-reference included, through any value/if/round/args
  // nesting. A cycle can never converge on one deterministic number, so it is
  // a hard error rather than a runtime fallback.
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): string | null => {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "visiting") {
      const chain = [...path.slice(path.indexOf(id)), id].join(" → ");
      return `Calculated field ${id} depends on its own result (${chain}) — break the cycle so the value can be computed`;
    }
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) {
      const error = visit(dep, [...path, id]);
      if (error) return error;
    }
    state.set(id, "done");
    return null;
  };
  for (const id of deps.keys()) {
    const error = visit(id, []);
    if (error) return error;
  }
  return null;
}

/**
 * DoS guard, separate from the structural checks above: the joint
 * {visible, calc} fixpoint re-evaluates every calculated expression for up to
 * fields.length passes, synchronously, on the PUBLIC submit path — so total
 * calc evaluation work must be bounded where schemas ENTER the system (builder
 * saves and publishable-key sync both normalize through here). A hostile but
 * structurally-valid schema — hundreds of chained calcs or huge ASTs — is
 * rejected at authoring/sync time with a hard error, so it can never reach a
 * respondent-facing recompute. The bounds are far above anything the visual
 * editor or a sane defineForm produces (the builder emits single-level
 * expressions of a handful of nodes) but fatal for abuse. Nesting depth is
 * separately capped at 32 by normalizeCalc.
 */
const MAX_CALC_FIELDS = 100;
const MAX_CALC_TOTAL_NODES = 5000;

/** AST size of one normalized calc expression — every op node counts as 1
 *  (`if.when` conditions ride the node that carries them). */
function countCalcNodes(expr: CalcExpr): number {
  switch (expr.op) {
    case "value":
    case "const":
      return 1;
    case "add":
    case "mul":
    case "min":
    case "max":
      return 1 + expr.args.reduce((n, arg) => n + countCalcNodes(arg), 0);
    case "sub":
    case "div":
      return 1 + countCalcNodes(expr.left) + countCalcNodes(expr.right);
    case "round":
      return 1 + countCalcNodes(expr.arg);
    case "if":
      return 1 + countCalcNodes(expr.then) + countCalcNodes(expr.else);
  }
}

/**
 * Hard error when the schema's AGGREGATE calc complexity exceeds the caps
 * above — fix-it messages in the duplicate-id style. Runs after
 * validateCalculatedFields so it walks the normalized ASTs it wrote back.
 */
function calcComplexityError(pages: FormPage[]): string | null {
  let calcFields = 0;
  let totalNodes = 0;
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== "calculated") continue;
      calcFields += 1;
      totalNodes += countCalcNodes(block.calc);
    }
  }
  if (calcFields > MAX_CALC_FIELDS) {
    return `Form has ${calcFields} calculated fields — the maximum is ${MAX_CALC_FIELDS}; remove some or consolidate them into fewer expressions`;
  }
  if (totalNodes > MAX_CALC_TOTAL_NODES) {
    return `Calculated expressions total ${totalNodes} operations — the maximum is ${MAX_CALC_TOTAL_NODES} across the form; simplify or split up the calculations`;
  }
  return null;
}

// ---------- Repeating groups (bet 08 P3) ----------

/**
 * v1 child-kind allowlist (contract decision 2). Deliberately excludes
 * nested repeating_group (never in v1 — recon risk kept out on purpose),
 * calculated (excluding it dissolves the per-instance validate→calc→phone
 * ordering hazard: with no calc children, only normalizePhoneFields learns to
 * recurse one level), file_upload, signature, matrix, ranking, hidden, and
 * custom. Each exclusion is instance-plumbing complexity taken on
 * deliberately later, not silently.
 */
const GROUP_CHILD_ALLOWED_KINDS: readonly FieldKind[] = [
  "short_text",
  "long_text",
  "email",
  "url",
  "phone",
  "number",
  "select",
  "multi_select",
  "dropdown",
  "checkbox",
  "date",
  "rating",
  "linear_scale",
];

const MAX_GROUP_TEMPLATE_CHILDREN = 12;

/**
 * Authoring-time worst-case payload budget (contract decision 1): the
 * respondent must never discover the 256KB submit body cap mid-fill, because
 * by then the answers already typed are stuck. ~180KB leaves headroom for the
 * rest of the submission (every other page's answers) under that cap. Mirrors
 * the MAX_CALC complexity-cap precedent — a hard error at authoring/sync
 * time, never a mid-fill surprise.
 */
const MAX_GROUP_ESTIMATED_BYTES = 180_000;

/**
 * Conservative worst-case JSON byte estimate for ONE child's answer, keyed
 * off the same bounds `validateField` actually enforces for that kind (so the
 * estimate tracks reality instead of an arbitrary number). ~20 bytes of flat
 * overhead stands in for the `"childId":` key plus quotes/comma.
 */
function worstCaseChildBytes(child: Field): number {
  const overhead = child.id.length + 20;
  switch (child.kind) {
    case "short_text":
    case "email":
    case "url":
      return overhead + (child.maxLength ?? 2000);
    case "long_text":
      return overhead + (child.maxLength ?? 20_000);
    case "phone":
      return overhead + 32;
    case "number":
      return overhead + 32;
    case "select":
    case "dropdown": {
      const longestOption = child.options.reduce((max, o) => Math.max(max, o.id.length), 0);
      return overhead + Math.max(longestOption, child.allowOther ? 500 : 0);
    }
    case "multi_select": {
      const everyOption = child.options.reduce((sum, o) => sum + o.id.length + 3, 0);
      return overhead + everyOption + (child.allowOther ? 500 : 0);
    }
    case "checkbox":
      return overhead + 8;
    case "date":
      return overhead + 16;
    case "rating":
    case "linear_scale":
      return overhead + 8;
    default:
      // Unreachable once GROUP_CHILD_ALLOWED_KINDS is enforced (validated
      // right after this estimate runs) — a small flat constant keeps the
      // estimator total-defined either way rather than throwing.
      return overhead + 64;
  }
}

/**
 * Worst-case bytes for the WHOLE group: every child's worst case summed per
 * instance (plus a small per-instance object overhead for braces/commas),
 * times maxInstances — never data-derived (an authoring-time estimate over
 * the SCHEMA, not a measurement of any actual response).
 */
function groupSizeEstimate(field: RepeatingGroupField): number {
  const perInstance = field.fields.reduce((sum, child) => sum + worstCaseChildBytes(child), 24);
  return perInstance * (Number.isFinite(field.maxInstances) ? field.maxInstances : 0);
}

/**
 * Structural + bounds hard errors for every repeating_group block, fix-it
 * messages in the duplicate-id/calc style — never a silent degrade. Runs
 * after the main per-block loop (ids are already known unique) and BEFORE any
 * scope-wall check that assumes no nested groups survived (the allowlist
 * check right here is what guarantees that). Writes the resolved
 * minInstances back onto the block: normalizeBlock only extracts structurally
 * (the calc-AST precedent), this pass is where the bound becomes
 * authoritative.
 */
function validateRepeatingGroups(pages: FormPage[]): string | null {
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== "repeating_group") continue;

      if (!Number.isInteger(block.maxInstances) || block.maxInstances < 1 || block.maxInstances > 20) {
        return `Repeating group ${block.id} needs maxInstances to be a whole number between 1 and 20`;
      }
      const minInstances = block.minInstances ?? 1;
      if (!Number.isInteger(minInstances) || minInstances < 0 || minInstances > block.maxInstances) {
        return `Repeating group ${block.id} needs minInstances to be a whole number between 0 and maxInstances (${block.maxInstances})`;
      }
      block.minInstances = minInstances;

      // An empty container is invalid (contract decision 10 — a fresh block
      // must be valid, so createBlock seeds one child rather than zero).
      if (block.fields.length === 0) {
        return `Repeating group ${block.id} has no template fields — add at least one field to repeat`;
      }
      if (block.fields.length > MAX_GROUP_TEMPLATE_CHILDREN) {
        return `Repeating group ${block.id} has ${block.fields.length} template fields — the maximum is ${MAX_GROUP_TEMPLATE_CHILDREN}; split it into fewer fields`;
      }

      for (const child of block.fields) {
        if (!GROUP_CHILD_ALLOWED_KINDS.includes(child.kind)) {
          return `Repeating group ${block.id} has a "${child.kind}" child (${child.id}) — allowed child kinds are ${GROUP_CHILD_ALLOWED_KINDS.join(", ")}`;
        }
      }

      const duplicateChild = duplicateOptionId(block.fields);
      if (duplicateChild) {
        return `Duplicate child id in repeating group ${block.id}: ${duplicateChild}`;
      }

      // Scope wall, inward half (contract decision 3): a child's visibleIf
      // may reference ONLY same-group siblings. The outward half — nothing
      // OUTSIDE a group may reference one of its children — is
      // groupScopeWallError, which runs after every group has passed this
      // check (so it can assume no nested groups survive).
      const siblingIds = new Set(block.fields.map((f) => f.id));
      for (const child of block.fields) {
        for (const cond of child.visibleIf ?? []) {
          if (!siblingIds.has(cond.fieldId)) {
            return `Field ${child.id} in repeating group ${block.id} has a visibleIf referencing "${cond.fieldId}" — a child's visibleIf can only reference another field in the SAME group`;
          }
        }
      }

      const estimate = groupSizeEstimate(block);
      if (estimate > MAX_GROUP_ESTIMATED_BYTES) {
        return `Repeating group ${block.id} could reach ~${Math.ceil(estimate / 1000)}KB at ${block.maxInstances} instances — the maximum is ~${Math.round(MAX_GROUP_ESTIMATED_BYTES / 1000)}KB; lower maxInstances, shorten text limits, or trim the template`;
      }
    }
  }
  return null;
}

/**
 * Every child id across every group, mapped to its containing group id —
 * scope-wall bookkeeping (contract decision 3). An id in this map is NOT in
 * the top-level namespace: anything outside its own group referencing it —
 * visibility, jumps, calc operands, piping — is a hard error. A child id that
 * COLLIDES with a real top-level field id is excluded here on purpose: from
 * any construct outside the group, that string unambiguously names the real
 * top-level field (children aren't a global namespace — the collision is the
 * author's problem, not the wall's). Safe with no recursion beyond one level:
 * validateRepeatingGroups (which must run first) already rejects nested
 * groups via the child-kind allowlist.
 */
function collectGroupChildIds(pages: FormPage[]): Map<string, string> {
  const topLevelIds = new Set<string>();
  for (const page of pages) {
    for (const block of page.blocks) if (isField(block)) topLevelIds.add(block.id);
  }
  const childToGroup = new Map<string, string>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== "repeating_group") continue;
      for (const child of block.fields) {
        // First-wins when the same child id recurs in two groups (legal —
        // per-group namespace) so wall messages are deterministic.
        if (!topLevelIds.has(child.id) && !childToGroup.has(child.id)) {
          childToGroup.set(child.id, block.id);
        }
      }
    }
  }
  return childToGroup;
}

/**
 * The OUTWARD half of the scope wall (contract decision 3): nothing outside a
 * group may reference one of its children. Checks every block's OWN
 * visibleIf (fields, content blocks, and a group's own visibleIf are all
 * top-level constructs) plus every page's RAW pre-jumpRules jump conditions —
 * raw, because jumpRules() would otherwise silently DROP a rule referencing
 * an unrecognized id (the existing "later page" fail-safe) before this ever
 * sees it, and a child id must be a loud schema error here, never a quietly
 * dropped rule. Calc gets its own wall message inside validateCalculatedFields
 * (naming the group beats the generic "missing field" text). Piping's token
 * grammar can't express a child reference at all (its regex has no dot), so
 * it needs no wall — see the normalizeBlock repeating_group case comment.
 */
function groupScopeWallError(
  pages: FormPage[],
  rawPages: readonly { id: string; next: unknown }[],
  childToGroup: Map<string, string>,
): string | null {
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const cond of block.visibleIf ?? []) {
        const owner = childToGroup.get(cond.fieldId);
        if (owner !== undefined) {
          return `Field ${block.id}'s visibleIf references "${cond.fieldId}", which is a child of repeating group ${owner} — fields outside a repeating group can't reference its children`;
        }
      }
    }
  }
  for (const page of rawPages) {
    if (!Array.isArray(page.next)) continue;
    for (const rule of page.next) {
      if (!rule || typeof rule !== "object") continue;
      const when = (rule as Record<string, unknown>).when;
      if (!Array.isArray(when)) continue;
      for (const cond of when) {
        if (!cond || typeof cond !== "object") continue;
        const fieldId = (cond as Record<string, unknown>).fieldId;
        if (typeof fieldId !== "string") continue;
        const owner = childToGroup.get(fieldId);
        if (owner !== undefined) {
          return `A jump rule on page ${page.id} references "${fieldId}", which is a child of repeating group ${owner} — jumps can't reference a repeating group's children`;
        }
      }
    }
  }
  return null;
}

function baseBlock(rec: Record<string, unknown>) {
  return {
    id: str(rec.id, 128),
    visibleIf: conditions(rec.visibleIf),
  };
}

function baseField<K extends Field["kind"]>(rec: Record<string, unknown>, kind: K) {
  const base = baseBlock(rec);
  return {
    ...base,
    kind,
    label: str(rec.label, 2000, "Untitled field"),
    description: optionalStr(rec.description, 5000),
    required: bool(rec.required),
    placeholder: optionalStr(rec.placeholder, 500),
  };
}

function normalizeUrl(value: unknown): string | undefined {
  const raw = optionalStr(value, 2000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function normalizeResponseLimit(value: unknown): FormSettings["responseLimit"] {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const by =
    rec.by === "browser" || rec.by === "field" || rec.by === "identify" ? rec.by : undefined;
  if (!by) return undefined;
  // A field-keyed limit is meaningless without the field that identifies people.
  const field = by === "field" ? optionalStr(rec.field, 128) : undefined;
  if (by === "field" && !field) return undefined;
  const scopeField = optionalStr(rec.scopeField, 128);
  // Only identify() may update in place — a self-claim (field) or a browser
  // must never overwrite someone else's response.
  const onRepeat = rec.onRepeat === "update" && by === "identify" ? "update" : "keep";
  return {
    by,
    ...(field ? { field } : {}),
    ...(scopeField ? { scopeField } : {}),
    onRepeat,
  };
}

function normalizeTrust(value: unknown): FormSettings["trust"] {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  // Validate each enum; drop unknown values (the allowlist below SILENTLY DROPS
  // unknown settings, so an invalid policy must normalize to "absent" = today's
  // accept-everything behavior, never a partial/garbage object).
  const unverified =
    rec.unverified === "allow" || rec.unverified === "quarantine" ? rec.unverified : undefined;
  // "off" and absent both mean no challenge; only "turnstile" enables one, so we
  // store it only when set (absent = off) to keep the object minimal.
  const challenge = rec.challenge === "turnstile" ? "turnstile" : undefined;
  if (!unverified && !challenge) return undefined;
  return {
    ...(unverified ? { unverified } : {}),
    ...(challenge ? { challenge } : {}),
  };
}

export function normalizeSettings(value: unknown): FormSettings {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const submitMode: FormSettings["submitMode"] =
    rec.submitMode === "button" || rec.submitMode === "auto" ? rec.submitMode : undefined;
  return {
    submitMode,
    submitLabel: optionalStr(rec.submitLabel, 100),
    successTitle: optionalStr(rec.successTitle, 200),
    successMessage: optionalStr(rec.successMessage, 5000),
    redirectUrl: normalizeUrl(rec.redirectUrl),
    showProgress: bool(rec.showProgress),
    responseLimit: normalizeResponseLimit(rec.responseLimit),
    trust: normalizeTrust(rec.trust),
    notifyEmail: z.email().check(z.maxLength(254)).safeParse(rec.notifyEmail).success
      ? (rec.notifyEmail as string)
      : undefined,
    sendReceipt: bool(rec.sendReceipt),
    saveProgress: bool(rec.saveProgress),
    draftAnswersVisible: bool(rec.draftAnswersVisible),
    resumeEmails: bool(rec.resumeEmails),
    resumeUrl: normalizeUrl(rec.resumeUrl),
    draftDigest: bool(rec.draftDigest),
  };
}

function cleanObject<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

function normalizeBlock(input: unknown): Block | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  const kind = rec.kind;
  const base = baseBlock(rec);
  if (!base.id || typeof kind !== "string") return null;

  switch (kind) {
    case "heading":
      return cleanObject({ ...base, kind, text: str(rec.text, 2000, "Section") });
    case "paragraph":
      return cleanObject({ ...base, kind, text: str(rec.text, 5000) });
    case "divider":
      return cleanObject({ ...base, kind });
    case "short_text":
    case "email":
    case "url":
      return cleanObject({
        ...baseField(rec, kind),
        maxLength: finite(rec.maxLength) === undefined ? undefined : int(rec.maxLength, 1, 2000, 2000),
      });
    case "phone": {
      const cc = optionalStr(rec.defaultCountry, 2)?.toUpperCase();
      return cleanObject({
        ...baseField(rec, kind),
        defaultCountry: cc && /^[A-Z]{2}$/.test(cc) ? cc : undefined,
      });
    }
    case "long_text":
      return cleanObject({
        ...baseField(rec, kind),
        maxLength: finite(rec.maxLength) === undefined ? undefined : int(rec.maxLength, 1, 20000, 20000),
      });
    case "number":
      return cleanObject({
        ...baseField(rec, kind),
        min: finite(rec.min),
        max: finite(rec.max),
        // Display-only (decision 1 in the number-formatting contract) —
        // mirrors the calculated field's decimals/prefix/suffix carry-through
        // exactly, plus notation which calculated doesn't have.
        decimals: finite(rec.decimals) === undefined ? undefined : int(rec.decimals, 0, 6, 0),
        prefix: optionalAffix(rec.prefix, 100),
        suffix: optionalAffix(rec.suffix, 100),
        // The only supported values; anything else drops silently rather than
        // erroring (an old/garbage value is just "no grouping").
        notation:
          rec.notation === "grouped"
            ? ("grouped" as const)
            : rec.notation === "grouped-comma"
              ? ("grouped-comma" as const)
              : rec.notation === "grouped-dot"
                ? ("grouped-dot" as const)
                : undefined,
      });
    case "select":
    case "multi_select":
    case "dropdown": {
      const opts = options(rec.options);
      if (opts.length === 0) return null;
      return cleanObject({
        ...baseField(rec, kind),
        options: opts,
        allowOther: bool(rec.allowOther),
        shuffleOptions: bool(rec.shuffleOptions),
      });
    }
    case "checkbox": {
      const appearance = rec.appearance === "toggle" ? ("toggle" as const) : undefined;
      return cleanObject({
        ...baseField(rec, kind),
        appearance,
      });
    }
    case "signature":
    case "date":
      return cleanObject(baseField(rec, kind));
    case "rating": {
      const max = int(rec.max, 1, 10, 5);
      return cleanObject({
        ...baseField(rec, kind),
        max,
        insightsMetric: rec.insightsMetric === "csat" && max === 5
          ? ("csat" as const)
          : undefined,
      });
    }
    case "linear_scale": {
      const min = int(rec.min, 0, 9, 1);
      const max = int(rec.max, min + 1, 10, 10);
      const insightsMetric =
        rec.insightsMetric === "nps" && min === 0 && max === 10
          ? ("nps" as const)
          : rec.insightsMetric === "csat" && min === 1 && max === 5
            ? ("csat" as const)
            : undefined;
      return cleanObject({
        ...baseField(rec, kind),
        min,
        max,
        minLabel: optionalStr(rec.minLabel, 100),
        maxLabel: optionalStr(rec.maxLabel, 100),
        insightsMetric,
      });
    }
    case "ranking": {
      const opts = options(rec.options);
      if (opts.length < 2) return null;
      return cleanObject({ ...baseField(rec, kind), options: opts });
    }
    case "matrix": {
      const rows = options(rec.rows);
      const columns = options(rec.columns);
      if (rows.length === 0 || columns.length === 0) return null;
      return cleanObject({ ...baseField(rec, kind), rows, columns });
    }
    case "hidden":
      return cleanObject({
        ...baseField(rec, kind),
        // Hidden fields render nothing, so a required one with no matching URL
        // param / default would be permanently unsubmittable — never required.
        required: false,
        paramName: optionalStr(rec.paramName, 128),
        defaultValue: optionalStr(rec.defaultValue, 1000),
      });
    case "calculated":
      return cleanObject({
        ...baseField(rec, kind),
        // A derived value isn't answerable, so it can't be required (the
        // hidden-field precedent) — a required one could never be satisfied.
        required: false,
        // Kept raw here on purpose: the calc AST is normalized and structurally
        // validated in normalizeFormSchema once the full field universe is
        // known (missing refs, operand kinds, cycles are HARD errors there — a
        // calculated field must never be silently dropped or degraded).
        calc: rec.calc as CalcExpr,
        decimals: finite(rec.decimals) === undefined ? undefined : int(rec.decimals, 0, 6, 0),
        prefix: optionalAffix(rec.prefix, 100),
        suffix: optionalAffix(rec.suffix, 100),
      });
    case "file_upload":
      return cleanObject({
        ...baseField(rec, kind),
        maxFiles: int(rec.maxFiles, 1, 20, 1),
        maxFileSizeMb: int(rec.maxFileSizeMb, 1, 5000, 500),
        accept: Array.isArray(rec.accept)
          ? rec.accept.flatMap((v) => {
              const item = optionalStr(v, 100);
              return item ? [item] : [];
            }).slice(0, 50)
          : undefined,
      });
    case "repeating_group": {
      // Recurse children through the EXISTING per-kind cases above (reuse,
      // never a parallel normalizer) — a child is a full Field, normalized
      // exactly like a top-level block would be. Non-field results (a raw
      // child shaped like a heading/paragraph/divider) can't satisfy
      // `fields: Field[]` and are dropped here; a well-formed field of a
      // kind the v1 allowlist forbids (matrix, calculated, another
      // repeating_group, …) is KEPT here and hard-errored by
      // validateRepeatingGroups once the full page set is known — the same
      // "structural now, policy later" split normalizeCalc/
      // validateCalculatedFields already use. The raw array is defensively
      // capped well above the real ≤12 rule just to bound normalization work
      // for a hostile huge array before that hard error ever runs.
      //
      // Piping note: {{child_id}} can never resolve a child's value from
      // outside this group — resolveText's token grammar is `[\w-]+` (no
      // dot), so it cannot even SPELL an instance-scoped reference. No
      // validation wall is needed for piping specifically (verified, not
      // implemented) — see the contract's decision 3.
      const rawFields = Array.isArray(rec.fields) ? rec.fields : [];
      const fields = rawFields.slice(0, 50).flatMap((raw): Field[] => {
        const child = normalizeBlock(raw);
        return child && isField(child) ? [child] : [];
      });
      return cleanObject({
        ...baseField(rec, kind),
        // A container's OWN completeness is governed by minInstances (0 is a
        // legitimate "this group is optional"), not the generic required
        // flag — a separately-true `required` would be redundant at best and
        // self-contradictory at worst (the hidden/calculated precedent).
        required: false,
        fields,
        // Bounds become authoritative in validateRepeatingGroups as HARD
        // ERRORS, not silent clamps (unlike rating.max/linear_scale.min-max)
        // — instances are respondent-controlled wire shape, not cosmetic
        // display config. maxInstances is schema-REQUIRED, so a missing/
        // non-finite raw value becomes NaN here (fails every bounds check on
        // its own) rather than a fabricated fallback the post-pass would
        // have to override anyway.
        maxInstances: finite(rec.maxInstances) ?? Number.NaN,
        minInstances: finite(rec.minInstances),
        addLabel: optionalStr(rec.addLabel, 100),
        itemLabel: optionalStr(rec.itemLabel, 100),
      });
    }
    case "custom":
      return cleanObject({
        ...baseField(rec, kind),
        component: str(rec.component, 128),
        config:
          rec.config && typeof rec.config === "object" && !Array.isArray(rec.config)
            ? (rec.config as Record<string, unknown>)
            : undefined,
      });
    default:
      return null;
  }
}

export interface SchemaValidationResult {
  ok: boolean;
  /** Present when ok — a normalized, structurally-valid schema. */
  schema?: FormSchema;
  /** Present when !ok — a short human-readable reason. */
  error?: string;
}

/** Normalize untrusted input into a renderer-safe FormSchema. */
export function normalizeFormSchema(input: unknown): SchemaValidationResult {
  const parsed = schemaShape.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".");
    return { ok: false, error: first ? `${path ? `${path}: ` : ""}${first.message}` : "Invalid schema" };
  }

  if (parsed.data.version > MAX_SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported schema version: ${parsed.data.version}` };
  }

  // First pass: normalize ids/title/blocks and capture raw `next` per page.
  const rebuilt = parsed.data.pages.map((page) => {
    const blocks = page.blocks.flatMap((raw): Block[] => {
      const block = normalizeBlock(raw);
      return block ? [block] : [];
    });
    return { id: str(page.id, 128), title: optionalStr(page.title, 500), blocks, next: page.next };
  });
  // The id universe jump targets may point at (duplicate/blank ids fail below).
  const targetIds = new Set(rebuilt.map((p) => p.id));
  // Every field id each calculated field's expression reads (value refs AND
  // if.when refs) — the edges `jumpDepsAllowed` expands a jump condition
  // through. Built from the raw calc ASTs because rules are constructed before
  // `validateCalculatedFields` normalizes them; a malformed calc contributes no
  // edges, which is moot — the whole schema hard-errors on it right after.
  const calcRefs = new Map<string, Set<string>>();
  for (const page of rebuilt) {
    for (const block of page.blocks) {
      if (block.kind !== "calculated") continue;
      const refs = new Set<string>();
      const calc = normalizeCalc(block.calc);
      if (calc) {
        const valueRefs = new Set<string>();
        const whenRefs = new Set<string>();
        collectCalcRefs(calc, valueRefs, whenRefs);
        for (const ref of valueRefs) refs.add(ref);
        for (const ref of whenRefs) refs.add(ref);
      }
      calcRefs.set(block.id, refs);
    }
  }
  // Field ids a page's jumps may reference: those on the page itself or an
  // earlier one. Accumulated as we walk pages in order, adding the current
  // page's fields BEFORE building its rules — so a jump can branch on an answer
  // given on the source page (the last one before leaving), matching the builder
  // which offers source-page-and-earlier fields as conditions.
  const priorFieldIds = new Set<string>();
  const pages = rebuilt.map((page) => {
    for (const block of page.blocks) {
      if (isField(block)) priorFieldIds.add(block.id);
    }
    return cleanObject({
      id: page.id,
      title: page.title,
      blocks: page.blocks,
      next: jumpRules(page.next, targetIds, page.id, new Set(priorFieldIds), calcRefs),
    });
  });

  const pageIds = new Set<string>();
  const seen = new Set<string>();
  for (const page of pages) {
    if (!page.id) return { ok: false, error: "Page ids cannot be blank" };
    if (pageIds.has(page.id)) return { ok: false, error: `Duplicate page id: ${page.id}` };
    pageIds.add(page.id);
    for (const block of page.blocks) {
      if (seen.has(block.id)) return { ok: false, error: `Duplicate block id: ${block.id}` };
      seen.add(block.id);

      if (block.kind === "number" && block.min !== undefined && block.max !== undefined && block.min > block.max) {
        return { ok: false, error: `Field ${block.id} has min greater than max` };
      }

      if (
        block.kind === "select" ||
        block.kind === "multi_select" ||
        block.kind === "dropdown" ||
        block.kind === "ranking"
      ) {
        const duplicate = duplicateOptionId(block.options);
        if (duplicate) {
          return { ok: false, error: `Duplicate option id in field ${block.id}: ${duplicate}` };
        }
      } else if (block.kind === "matrix") {
        const duplicateRow = duplicateOptionId(block.rows);
        if (duplicateRow) {
          return { ok: false, error: `Duplicate matrix row id in field ${block.id}: ${duplicateRow}` };
        }
        const duplicateColumn = duplicateOptionId(block.columns);
        if (duplicateColumn) {
          return {
            ok: false,
            error: `Duplicate matrix column id in field ${block.id}: ${duplicateColumn}`,
          };
        }
      }
    }
  }

  // Repeating groups: bounds, child allowlist, per-group child-id uniqueness,
  // the inward scope wall, and the worst-case size estimate — hard errors,
  // run first so the wall passes below can assume no nested groups survived.
  const groupError = validateRepeatingGroups(pages);
  if (groupError) return { ok: false, error: groupError };

  // The outward scope wall: no top-level visibleIf and no RAW jump condition
  // may reference a group child. Raw `next` (rebuilt, pre-jumpRules) because
  // jumpRules already silently dropped any such rule — a child ref must be a
  // loud error, not a quietly linearized page.
  const childToGroup = collectGroupChildIds(pages);
  const wallError = groupScopeWallError(pages, rebuilt, childToGroup);
  if (wallError) return { ok: false, error: wallError };

  // Calculated fields: normalize the calc AST and hard-error on structural
  // problems (malformed nodes, missing/non-numeric refs, reference cycles) —
  // needs the full field universe, so it runs after every block is rebuilt.
  // childToGroup lets the missing-ref error name the scope wall when the id
  // exists inside a group.
  const calcError = validateCalculatedFields(pages, childToGroup);
  if (calcError) return { ok: false, error: calcError };

  // Aggregate calc complexity caps (DoS guard) — additive to the structural
  // checks above; see calcComplexityError.
  const calcComplexity = calcComplexityError(pages);
  if (calcComplexity) return { ok: false, error: calcComplexity };

  if (pages.every((page) => page.blocks.length === 0)) {
    return { ok: false, error: "Schema must contain at least one valid block" };
  }

  const schema: FormSchema = {
    version: FILLO_SCHEMA_VERSION,
    title: str(parsed.data.title, 2000),
    pages,
    settings: normalizeSettings(parsed.data.settings),
  };
  const description = optionalStr(parsed.data.description, 5000);
  if (description) schema.description = description;

  return { ok: true, schema };
}

/** Validate an untrusted object as a FormSchema. Also enforces unique field ids. */
export function validateFormSchema(input: unknown): SchemaValidationResult {
  try {
    return normalizeFormSchema(input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid schema" };
  }
}

function safeCssToken(value: unknown, max: number): string | undefined {
  const token = optionalStr(value, max);
  if (!token) return undefined;
  if (/[;{}<>]/.test(token) || /url\s*\(/i.test(token)) return undefined;
  return token;
}

export function normalizeFormTheme(input: unknown): FormTheme | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const colorScheme: FormTheme["colorScheme"] =
    rec.colorScheme === "light" || rec.colorScheme === "dark" || rec.colorScheme === "auto"
      ? rec.colorScheme
      : undefined;
  const theme = cleanObject({
    colorScheme,
    primary: safeCssToken(rec.primary, 200),
    background: safeCssToken(rec.background, 200),
    text: safeCssToken(rec.text, 200),
    radius: safeCssToken(rec.radius, 64),
    fontFamily: safeCssToken(rec.fontFamily, 200),
  });
  return Object.keys(theme).length > 0 ? theme : null;
}
