import type {
  Block,
  CalculatedField,
  Condition,
  Field,
  FieldValue,
  FormPage,
  FormSchema,
  FormSettings,
  GroupInstanceValue,
  JumpRule,
  RepeatingGroupField,
  ResponseData,
} from "./types.js";
import { isField } from "./types.js";
import { canonicalValue } from "./canonical.js";
// Deliberate module cycle with calc.ts (hoisted functions, call-time use only):
// the joint fixpoint below evaluates calculated fields, and the evaluator
// reuses this module's condition machinery. See the note in calc.ts.
import { evaluateCalculatedField } from "./calc.js";

function isAnswered(value: FieldValue): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Bridge number<->numeric-string only; never make unrelated types loosely equal. */
function valueEquals(value: FieldValue, target: Condition["value"]): boolean {
  if (value === target) return true;
  if (typeof value === "number" && typeof target === "string" && target.trim() !== "")
    return Number(target) === value;
  if (typeof target === "number" && typeof value === "string" && value.trim() !== "")
    return Number(value) === target;
  return false;
}

/** Numeric controls and raw headless clients commonly produce decimal strings
 * while the canonical submitted value is a number. Conditions run before
 * submission normalization, so bridge finite numeric strings here as well.
 * @internal also THE numeric bridge for calc `value` refs (calc.ts) — one
 * bridging rule across conditions and calculations, never two. */
export function conditionNumber(value: FieldValue | Condition["value"]): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `resolve` maps a fieldId to its effective value: a controlling field that is
 * itself currently hidden reads as unanswered, so a stale answer behind a hidden
 * trigger can't keep a dependent field visible.
 */
function evalCondition(cond: Condition, resolve: (fieldId: string) => FieldValue): boolean {
  const value = resolve(cond.fieldId);
  switch (cond.op) {
    case "answered":
      return isAnswered(value);
    case "not_answered":
      return !isAnswered(value);
    case "eq":
      if (Array.isArray(value)) return value.some((v) => v === cond.value);
      return valueEquals(value, cond.value);
    case "neq":
      // Unanswered never satisfies neq — don't reveal before the field is answered.
      if (!isAnswered(value)) return false;
      if (Array.isArray(value)) return !value.some((v) => v === cond.value);
      return !valueEquals(value, cond.value);
    case "contains":
      if (typeof value === "string")
        return value.toLowerCase().includes(String(cond.value ?? "").toLowerCase());
      if (Array.isArray(value)) return value.some((v) => v === cond.value);
      return false;
    case "gt":
    case "lt": {
      const left = conditionNumber(value);
      const right = conditionNumber(cond.value);
      return (
        left !== null &&
        right !== null &&
        (cond.op === "gt" ? left > right : left < right)
      );
    }
  }
}

/**
 * All conditions must hold (AND); no conditions = true. THE shared evaluator —
 * both block visibility (`visibleIf`) and page jumps (`JumpRule.when`) run
 * through this over the SAME whole-form fixpoint resolver, so a jump gated by a
 * logic-hidden controller field behaves identically to a visibility rule.
 */
export function conditionsMet(
  conds: Condition[],
  resolve: (fieldId: string) => FieldValue,
): boolean {
  if (conds.length === 0) return true;
  return conds.every((cond) => evalCondition(cond, resolve));
}

function blockVisibleWith(block: Block, resolve: (fieldId: string) => FieldValue): boolean {
  if (!block.visibleIf || block.visibleIf.length === 0) return true;
  return conditionsMet(block.visibleIf, resolve);
}

/**
 * A resolver that hides in-scope fields absent from `visible`. In-scope fields
 * read their CANONICAL value (see canonical.ts): trimmed, wire-format numerics
 * coerced, empty answers (unchecked checkbox, "", [], {}) absent — the exact
 * shape validateResponse keeps, so a condition can never match live a value
 * shape the server's recompute won't see. Out-of-scope ids (e.g. an earlier
 * page's field when scoping to one page) fall back to raw data. An in-scope
 * CALCULATED id never reads raw data — its value is engine-computed (`calc`),
 * so a stale or client-forged value under that key is ignored by construction
 * (key absent from `calc` = unanswered).
 */
function makeResolver(
  canonical: ResponseData,
  raw: ResponseData,
  scoped: Set<string>,
  visible: Set<string>,
  calcIds: Set<string>,
  calc: ResponseData,
): (fieldId: string) => FieldValue {
  return (fieldId) => {
    if (scoped.has(fieldId)) {
      if (!visible.has(fieldId)) return undefined;
      return calcIds.has(fieldId) ? calc[fieldId] : canonical[fieldId];
    }
    return raw[fieldId];
  };
}

/** The converged joint logic state — see {@link resolveLogicState}. */
export interface LogicState {
  /** Field ids visible after conditional logic. */
  visible: Set<string>;
  /** Computed values for visible calculated fields; null results are absent. */
  calc: ResponseData;
  /** Every in-scope calculated id — these never resolve from raw data. */
  calcIds: Set<string>;
  /** Resolver over the converged state: in-scope hidden → undefined,
   *  calculated → computed value, everything else → raw data. */
  resolve: (fieldId: string) => FieldValue;
}

/**
 * THE shared logic fixpoint, resolved jointly over {visible set, calc values}:
 * hiding a field can hide (or reveal, via not_answered) its dependents, a calc
 * value can flip a visibility/jump condition, and hiding a calc's source nulls
 * the calc — so iterate both together until neither changes. Bounded by the
 * number of fields (the longest possible acyclic dependency chain; schema
 * validation hard-errors calc reference cycles). Every consumer — visibility,
 * jumps, the validator's reachability walk, auto-submit, the controller —
 * resolves through this one function. NO second engine.
 * @internal shared with calc.ts's computeCalculated; not in the public barrel.
 */
export function resolveLogicState(fields: Field[], data: ResponseData): LogicState {
  const scoped = new Set(fields.map((f) => f.id));
  const calcFields = fields.filter((f): f is CalculatedField => f.kind === "calculated");
  const calcIds = new Set(calcFields.map((f) => f.id));
  // Canonical in-scope values, computed ONCE per resolve (static across the
  // fixpoint iterations below): every condition and calculation reads the same
  // shape validateResponse keeps — see canonical.ts. Without this, an unchecked
  // checkbox (`false`, dropped as empty server-side) or a padded string
  // (trimmed server-side) satisfies an `eq` live that the server's recompute
  // over the kept answers then resolves the other way.
  const canonical: ResponseData = {};
  for (const f of fields) {
    if (f.kind === "calculated") continue;
    const value = canonicalValue(f, data[f.id]);
    if (value === undefined) continue;
    // THE `answered` semantic for a repeating group, decided here (contract
    // decision 11): a group read by any condition counts as answered iff its
    // instance count ≥ max(1, minInstances). Below that threshold the group
    // resolves as UNANSWERED (key absent), so `answered` is false,
    // `not_answered` true, and eq/contains/gt/lt read undefined (all safely
    // false — an array of objects never loosely equals a scalar anyway).
    // Rationale: minInstances is the group's own definition of "complete
    // enough to submit"; a half-added set that would 422 must not flip outer
    // logic as if it were a given answer. max(1, …) keeps a min-0 group from
    // reading as answered while it has zero instances. The group stays ONE
    // opaque field at top level — child values never leak into this fixpoint
    // (scope walls, decision 3).
    if (f.kind === "repeating_group") {
      const count = Array.isArray(value) ? value.length : 0;
      if (count < Math.max(1, f.minInstances ?? 1)) continue;
    }
    canonical[f.id] = value;
  }
  let visible = scoped;
  let calc: ResponseData = {};
  for (let i = 0; i <= fields.length; i++) {
    // Calc pass first, in form order. Each field reads values already
    // recomputed THIS pass (so a forward chain settles in one iteration) and
    // last pass's values otherwise. A currently-hidden calculated field is
    // skipped — logic-hidden means unanswered, exactly like a hidden source.
    let nextCalc = calc;
    if (calcFields.length > 0) {
      nextCalc = { ...calc };
      const resolveCalc = makeResolver(canonical, data, scoped, visible, calcIds, nextCalc);
      for (const field of calcFields) {
        const value = visible.has(field.id) ? evaluateCalculatedField(field, resolveCalc) : null;
        if (value === null) delete nextCalc[field.id];
        else nextCalc[field.id] = value;
      }
    }
    const resolve = makeResolver(canonical, data, scoped, visible, calcIds, nextCalc);
    const nextVisible = new Set<string>();
    for (const f of fields) if (blockVisibleWith(f, resolve)) nextVisible.add(f.id);
    const stable =
      nextVisible.size === visible.size &&
      [...nextVisible].every((id) => visible.has(id)) &&
      calcEquals(calc, nextCalc);
    visible = nextVisible;
    calc = nextCalc;
    if (stable) break;
  }
  return {
    visible,
    calc,
    calcIds,
    resolve: makeResolver(canonical, data, scoped, visible, calcIds, calc),
  };
}

function calcEquals(a: ResponseData, b: ResponseData): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => a[key] === b[key]);
}

/**
 * Visible field ids resolved to the joint fixpoint — the visibility half of
 * {@link resolveLogicState}.
 */
function visibleFieldIds(fields: Field[], data: ResponseData): Set<string> {
  return resolveLogicState(fields, data).visible;
}

/** All conditions must hold (AND). No conditions = visible. */
export function isBlockVisible(block: Block, data: ResponseData): boolean {
  return blockVisibleWith(block, (fieldId) => data[fieldId]);
}

export function visibleBlocks(page: FormPage, data: ResponseData): Block[] {
  const state = resolveLogicState(page.blocks.filter(isField), data);
  return page.blocks.filter((b) => blockVisibleWith(b, state.resolve));
}

/**
 * Blocks to render on `page`, resolved against the WHOLE-FORM visibility
 * fixpoint rather than just this page's own fields. A field whose `visibleIf`
 * references an answer on another page must appear/validate here exactly when
 * the server would keep that answer — and the server (validateResponse →
 * visibleFields) uses the whole-form fixpoint, hiding any controlling field
 * that is itself logic-hidden. Scoping per page instead reads a stale answer
 * behind a hidden cross-page trigger as still-answered, so the client would
 * render (and validate) a field whose answer the server then silently drops.
 * Use this for anything that must agree with validateResponse; the per-page
 * `visibleBlocks` remains for callers holding only a single page.
 */
export function visiblePageBlocks(
  form: FormSchema,
  page: FormPage,
  data: ResponseData,
): Block[] {
  const state = resolveLogicState(allFields(form), data);
  return page.blocks.filter((b) =>
    isField(b) ? state.visible.has(b.id) : blockVisibleWith(b, state.resolve),
  );
}

/** Every field in the form (across pages), in order. */
export function allFields(form: FormSchema): Field[] {
  return form.pages.flatMap((p) => p.blocks.filter(isField));
}

/**
 * The scope key for a response limit: the string form of the answer to
 * `settings.responseLimit.scopeField`, or null when there is no scope field or the
 * answer is not a usable scalar. A non-scalar answer (checkbox boolean,
 * multi_select/ranking array, matrix object) means "no scope" — the limit
 * spans the whole form rather than silently mis-bucketing. Shared by the SDK's
 * per-visitor key and the server's per-person dedup so both scope identically.
 */
export function responseScopeValue(
  settings: FormSettings,
  data: ResponseData,
): string | null {
  const field = settings.responseLimit?.scopeField;
  if (!field) return null;
  const value = data[field];
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  // Canonicalize scope keys independently of answer storage: `" A "` and `A`
  // must share a browser-limit bucket, including for custom fields whose raw
  // answer strings intentionally keep whitespace. Empty isn't a scope.
  const normalized = value.trim();
  return normalized || null;
}

/** Fields currently visible given the response data. */
export function visibleFields(form: FormSchema, data: ResponseData): Field[] {
  const fields = allFields(form);
  const visible = visibleFieldIds(fields, data);
  return fields.filter((f) => visible.has(f.id));
}

/**
 * THE scoped per-instance visibility resolver for a repeating group's
 * children (contract decisions 3 + 4): given ONE instance's values, the
 * template children currently visible in that instance, in template order.
 * Both renderers (which rows to draw in instance n) and validateResponse
 * (which children to require/keep in instance n) consume THIS one helper —
 * no second engine. It literally IS the shared engine: the children run
 * through the same {@link resolveLogicState} fixpoint a page of top-level
 * fields would, over the instance's values — so canonical-value discipline
 * (trim/coerce/empty-drop before any condition reads a sibling) and
 * hidden-sibling cascading (a hidden controller reads as unanswered) behave
 * exactly like top level, one scope down. Scope walls are enforced at schema
 * time: a child's visibleIf can only name same-group siblings, so the
 * instance's own values are the complete condition universe — outer answers
 * can never matter here, and child values never leak out (the group is one
 * opaque field in the top-level fixpoint). No calc pass runs because
 * `calculated` children are schema-rejected (decision 2). A logic-hidden
 * child is unanswered for its siblings AND skipped by per-instance
 * validation, mirroring the top-level discipline.
 */
export function visibleGroupChildren(
  group: RepeatingGroupField,
  instanceValues: GroupInstanceValue,
): Field[] {
  // Defensive: a forged non-object instance reads as "nothing answered".
  const values: ResponseData =
    instanceValues && typeof instanceValues === "object" && !Array.isArray(instanceValues)
      ? instanceValues
      : {};
  const state = resolveLogicState(group.fields, values);
  return group.fields.filter((f) => state.visible.has(f.id));
}

// ---------- Page flow: jumps + early end (P1 logic depth) ----------

/** A whole-form resolver: field values read through the same joint
 *  {visibility, calc} fixpoint the server validates with, so a logic-hidden
 *  controller reads as unanswered and jump rules see calculated values. */
function formResolver(form: FormSchema, data: ResponseData): (fieldId: string) => FieldValue {
  return resolveLogicState(allFields(form), data).resolve;
}

/** Where navigation goes when leaving a page. */
export type NextPage = { to: string } | { end: true } | { linear: true };

/**
 * Evaluate a page's `next` jump rules top-to-bottom against the current data;
 * the first whose conditions all match decides the step ("end" → finish the
 * form). No rule (or no `next`) → the default linear next page. THE single
 * function the client renderer, the server validator, and the funnel share so
 * they always agree on flow.
 */
export function resolveNextPage(
  form: FormSchema,
  currentPageId: string,
  data: ResponseData,
): NextPage {
  const page = form.pages.find((p) => p.id === currentPageId);
  const rules: JumpRule[] | undefined = page?.next;
  if (!rules || rules.length === 0) return { linear: true };
  const resolve = formResolver(form, data);
  for (const rule of rules) {
    if (conditionsMet(rule.when, resolve)) {
      return rule.to === "end" ? { end: true } : { to: rule.to };
    }
  }
  return { linear: true };
}

/**
 * The ORDERED list of reachable page ids for the given data: walk from
 * `pages[0]` following `resolveNextPage` (linear → next index; jump → target id;
 * end → stop). A rule that points backward could loop, so stop on the first
 * revisit and cap the walk at `pages.length` steps. THE single ordered engine
 * the client renderer, the server validator, and navigation all agree through —
 * a no-jump form yields `[pages[0].id, …, pages[N].id]`, so everything built on
 * it reduces to today's linear behavior. {@link reachablePageIds} is the set of
 * this exact walk (one walk, no divergence).
 */
export function reachablePageSequence(form: FormSchema, data: ResponseData): string[] {
  const seq: string[] = [];
  if (form.pages.length === 0) return seq;
  const seen = new Set<string>();
  let index = 0;
  for (let steps = 0; steps <= form.pages.length; steps++) {
    const page = form.pages[index];
    if (!page || seen.has(page.id)) break;
    seen.add(page.id);
    seq.push(page.id);
    const nav = resolveNextPage(form, page.id, data);
    if ("end" in nav) break;
    if ("to" in nav) {
      const target = form.pages.findIndex((p) => p.id === nav.to);
      if (target < 0) break; // dangling target (normalization drops these) → stop
      index = target;
    } else {
      index += 1;
      if (index >= form.pages.length) break;
    }
  }
  return seq;
}

/**
 * The page ids reachable for the given data. The unordered set of
 * {@link reachablePageSequence} — one shared walk keeps the ordered navigation
 * and the reachability the validator uses provably in agreement. THE function
 * the client renderer and server validator both use to decide which pages/fields
 * are in play.
 */
export function reachablePageIds(form: FormSchema, data: ResponseData): Set<string> {
  return new Set(reachablePageSequence(form, data));
}

/**
 * Whether `pageId` is terminal for the given data — pressing the footer button
 * there submits rather than advancing. True when a matched jump rule resolves to
 * "end", or when the page is the LAST element of the reachable sequence (the
 * last reachable page, including a cycle broken at its revisit, so a backward
 * jump can never loop — the pre-revisit page becomes terminal and Submit
 * appears). For a no-jump form this is exactly "the last page".
 */
export function isTerminalPage(form: FormSchema, pageId: string, data: ResponseData): boolean {
  if ("end" in resolveNextPage(form, pageId, data)) return true;
  const seq = reachablePageSequence(form, data);
  return seq.length > 0 && seq[seq.length - 1] === pageId;
}

/** Reachable field ids: fields on reachable pages, intersected with visibility. */
export function reachableFieldIds(form: FormSchema, data: ResponseData): Set<string> {
  const reachablePages = reachablePageIds(form, data);
  const visible = visibleFieldIds(allFields(form), data);
  const ids = new Set<string>();
  for (const page of form.pages) {
    if (!reachablePages.has(page.id)) continue;
    for (const block of page.blocks) {
      if (isField(block) && visible.has(block.id)) ids.add(block.id);
    }
  }
  return ids;
}

/** Fields that are both reachable AND visible — the set that gets validated and
 *  kept on submit. Equals {@link visibleFields} for a form with no jumps. */
export function reachableFields(form: FormSchema, data: ResponseData): Field[] {
  const ids = reachableFieldIds(form, data);
  return allFields(form).filter((f) => ids.has(f.id));
}
