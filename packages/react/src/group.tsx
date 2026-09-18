import type {
  Field,
  FieldValue,
  GroupInstanceValue,
  RepeatingGroupField as RepeatingGroupSchema,
  ResponseData,
} from "@usefillo/core";
import { visibleGroupChildren } from "@usefillo/core";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { FieldComponentProps, FilloApi } from "./api.js";
import { useStrings } from "./appearance.js";
import { FilloContext, useFilloAnnounce, useFilloFieldIds } from "./context.js";
import { BlockRenderer, FieldShell } from "./fields.js";

/**
 * Stable fallback for a rendered-but-not-yet-stored instance (display
 * padding beyond the saved array, contract §Data mechanics: rendered count =
 * max(value.length, minInstances)). Reusing one module-level object means an
 * unanswered padding slot's `data` view (built from it below) keeps the same
 * reference across unrelated renders, instead of a fresh `{}` every time
 * quietly defeating BlockRenderer's memo for that slot's children.
 */
const EMPTY_INSTANCE: GroupInstanceValue = {};

/** Every element a respondent could Tab to, minus anything already disabled. */
const FOCUSABLE_SELECTOR =
  'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The new/target card's first focusable DATA control — deliberately skips
 * the card's own Remove button (earlier in DOM order, in the header) so
 * "focus the new card's first focusable control" (contract §Instance UX)
 * lands somewhere useful for filling the instance in, the GOV.UK
 * "add another" convention this contract follows.
 */
function firstFieldControl(card: HTMLElement): HTMLElement | null {
  const candidates = card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  for (const el of candidates) {
    if (!el.classList.contains("fillo-group-remove")) return el;
  }
  return null;
}

/**
 * Pad (never truncate below what's asked) the stored array up to `count`,
 * copying rather than mutating — the one materialization shape every group
 * write shares: "any write materializes the full rendered set" (contract
 * §Data mechanics), so add/remove/child-edit all commit through this.
 */
function materializeInstances(value: FieldValue, count: number): GroupInstanceValue[] {
  const base = Array.isArray(value) ? (value as GroupInstanceValue[]) : [];
  const out = base.slice(0, count);
  while (out.length < count) out.push({});
  return out;
}

type PendingFocus =
  | { target: "add" }
  | { target: "instance-card"; index: number }
  | { target: "instance-control"; index: number };

/**
 * One instance card: role="group" labelled "«item» n of m", a header (title
 * + Remove) and its VISIBLE children rendered through the PUBLIC
 * BlockRenderer — untouched — via a synthesized child-scoped api slice
 * (contract decision 8, the shipped Matrix idiom one level deeper).
 *
 * The slice's `data`/`scopedChildren` are memoized on THIS instance's own
 * `instanceValue` object: the group's read-patch-write discipline (see
 * `materializeInstances` + `patchInstance` in RepeatingGroup below) only
 * ever produces a NEW object reference at the index that actually changed,
 * so a sibling instance's `instanceValue` — and therefore this memo — stays
 * referentially stable across an unrelated edit anywhere else in the form.
 * That stability is what blockPropsEqual's auto-submit branch (which compares
 * `api.data` BY REFERENCE) needs to avoid fanning one keystroke out to every
 * card in every instance.
 */
function GroupInstance({
  group,
  index,
  count,
  item,
  instanceValue,
  api,
  atFloor,
  onPatch,
  onRemove,
  cardRef,
}: {
  group: RepeatingGroupSchema;
  index: number;
  count: number;
  item: string;
  instanceValue: GroupInstanceValue;
  api: FilloApi;
  atFloor: boolean;
  onPatch: (index: number, childId: string, value: FieldValue) => void;
  onRemove: (index: number) => void;
  cardRef: (el: HTMLDivElement | null) => void;
}) {
  const strings = useStrings();
  const groupId = group.id;
  const n = index + 1;
  const label = strings.groupInstanceLabel(item, n, count);

  // visibleGroupChildren is the ONE scoped per-instance engine (core's
  // logic.ts) — same function validateResponse uses server-side, so a
  // sibling-hidden child here is exactly a sibling-hidden child there. Each
  // visible child is re-keyed to the compound DOM/data/error id
  // "${groupId}.${index}.${childId}" (dot-safe, verified) — passing THAT
  // through BlockRenderer's own `useFilloFieldIds(block.id)` is what gives
  // every instance's same-named child a unique DOM id with zero changes to
  // BlockRenderer itself.
  const { scopedChildren, data } = useMemo(() => {
    const prefix = `${groupId}.${index}.`;
    const visible = visibleGroupChildren(group, instanceValue);
    const scoped: Field[] = [];
    const scopedData: ResponseData = {};
    for (const child of visible) {
      const compoundId = prefix + child.id;
      scoped.push({ ...child, id: compoundId });
      scopedData[compoundId] = instanceValue[child.id];
    }
    return { scopedChildren: scoped, data: scopedData };
  }, [group, instanceValue, groupId, index]);

  // The other half of the compound-key mapping: BlockRendererInner calls
  // this as setValue(compoundId, v) (block.id is the rewritten id above), so
  // strip the known prefix back to the child's plain id and read-patch-write
  // the whole array through the group's own setValue (never mutating
  // `instanceValue` in place).
  const setValue = useCallback(
    (fieldId: string, v: FieldValue) => {
      const prefix = `${groupId}.${index}.`;
      const childId = fieldId.startsWith(prefix) ? fieldId.slice(prefix.length) : fieldId;
      onPatch(index, childId, v);
    },
    [groupId, index, onPatch],
  );

  // errors already arrives compound-keyed — validateResponse writes child
  // errors under this exact "${groupId}.${index}.${childId}" key (contract
  // decision 5) — so it passes straight through unscoped, as stable a
  // reference as the parent api's own.
  const childApi: FilloApi = { ...api, data, errors: api.errors, setValue };

  return (
    <div ref={cardRef} className="fillo-group-instance" role="group" aria-label={label} tabIndex={-1}>
      <div className="fillo-group-instance-header">
        <p className="fillo-group-instance-title">{label}</p>
        <button
          type="button"
          className="fillo-group-remove"
          aria-label={strings.groupRemoveLabel(item, n)}
          disabled={atFloor}
          title={atFloor ? `At least ${Math.max(group.minInstances ?? 1, 0)} required` : undefined}
          onClick={() => onRemove(index)}
        >
          ×
        </button>
      </div>
      {scopedChildren.map((child) => (
        <BlockRenderer key={child.id} block={child} api={childApi} />
      ))}
    </div>
  );
}

/**
 * Repeating group (contract decisions 8-9, roadmap 08 P3): instance cards +
 * Add, each child rendered through the PUBLIC BlockRenderer via a
 * synthesized child-scoped api slice — see GroupInstance above for the slice
 * itself. This component owns instance scoping (materialize/patch/add/
 * remove) and the add/remove focus + announcement contract; BlockRenderer
 * needs zero changes.
 */
export function RepeatingGroup({ field, error, setValue, api, ids: providedIds }: FieldComponentProps) {
  const ids = useFilloFieldIds(field.id, providedIds);
  const strings = useStrings();
  const announce = useFilloAnnounce();
  const group = field as RepeatingGroupSchema;
  const item = group.itemLabel || group.label;

  // BlockRenderer's own memo (blockPropsEqual, fields.tsx) gates a re-render
  // of THIS field on prev/next api.data["guests"]/api.errors["guests"] alone
  // — the plain top-level key. A child's compound-keyed error
  // ("guests.0.name") landing or clearing on a submit pass that leaves the
  // group's OWN data/count-error untouched changes neither, so that gate
  // bails out and freezes this whole subtree on its pre-submit render —
  // starving every instance's children of the fresh errors they need, with
  // no way to express that dependency inside blockPropsEqual's single-key
  // comparison (and BlockRenderer itself must stay untouched, contract
  // decision 8). Reading the context directly sidesteps it: React
  // propagates a changed context value to consuming fibers even through a
  // memo-bailed-out ancestor (documented React behavior — a changed context
  // value is not blocked by an intermediate memo/PureComponent bail-out),
  // so `liveApi` — and everything derived from it below, including what
  // gets handed to each instance's child-scoped slice — stays current
  // independent of whether BlockRendererInner above actually re-ran. Falls
  // back to the `api` prop so a caller that hands BlockRenderer a hand-built
  // api OUTSIDE any <FilloProvider>/<FilloForm> (no context to read) still
  // gets the prior, if staler, behavior instead of a crash.
  const liveApi = useContext(FilloContext) ?? api;
  const value = liveApi.data[field.id];

  const storedInstances = Array.isArray(value) ? (value as GroupInstanceValue[]) : undefined;
  const floor = Math.max(group.minInstances ?? 1, 0);
  const renderedCount = Math.max(storedInstances?.length ?? 0, floor);
  const atMax = renderedCount >= group.maxInstances;
  const atFloor = renderedCount <= floor;

  const instanceRefs = useRef<Array<HTMLDivElement | null>>([]);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);

  // Runs after every committed write to THIS group — `value` is this
  // field's own data[groupId], a fresh reference on add/remove/child-edit
  // alike. Acts only when the write that just landed was an add/remove that
  // asked for a specific focus target; a plain child edit leaves
  // pendingFocus null and this is a no-op. Mirrors Ranking's post-move
  // refocus effect (fields.tsx) — the reorder-disables-the-pressed-button
  // pattern, one container up.
  useEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (!pending) return;
    if (pending.target === "add") {
      addButtonRef.current?.focus();
      return;
    }
    const card = instanceRefs.current[pending.index];
    if (!card) return;
    if (pending.target === "instance-card") {
      card.focus(); // the previous card's own tabIndex=-1 wrapper (contract §Instance UX)
      return;
    }
    (firstFieldControl(card) ?? card).focus();
  }, [value]);

  function patchInstance(index: number, childId: string, v: FieldValue) {
    const instances = materializeInstances(value, renderedCount);
    instances[index] = { ...(instances[index] ?? {}), [childId]: v };
    setValue(instances);
  }

  function handleAdd() {
    if (atMax) return;
    const instances = materializeInstances(value, renderedCount);
    instances.push({});
    const n = instances.length;
    pendingFocus.current = { target: "instance-control", index: n - 1 };
    setValue(instances);
    announce(strings.groupInstanceAdded(item, n, n));
  }

  function handleRemove(index: number) {
    if (atFloor) return;
    const instances = materializeInstances(value, renderedCount);
    instances.splice(index, 1);
    pendingFocus.current = index > 0 ? { target: "instance-card", index: index - 1 } : { target: "add" };
    setValue(instances);
    announce(strings.groupInstanceRemoved(item, instances.length));
  }

  return (
    <FieldShell field={group} error={error} ids={ids}>
      <div className="fillo-group">
        {Array.from({ length: renderedCount }, (_, index) => (
          <GroupInstance
            key={index}
            group={group}
            index={index}
            count={renderedCount}
            item={item}
            instanceValue={storedInstances?.[index] ?? EMPTY_INSTANCE}
            api={liveApi}
            atFloor={atFloor}
            onPatch={patchInstance}
            onRemove={handleRemove}
            cardRef={(el) => {
              instanceRefs.current[index] = el;
            }}
          />
        ))}
        <button
          ref={addButtonRef}
          type="button"
          className="fillo-group-add"
          disabled={atMax}
          aria-disabled={atMax ? true : undefined}
          title={atMax ? `Maximum ${group.maxInstances} reached` : undefined}
          onClick={handleAdd}
        >
          {group.addLabel || strings.groupAdd}
        </button>
      </div>
    </FieldShell>
  );
}
