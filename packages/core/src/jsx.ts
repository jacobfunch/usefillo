import type {
  CheckboxField,
  ChoiceField,
  Condition,
  CustomField,
  FileUploadField,
  FormPage,
  FormSchema,
  FormSettings,
  FormTheme,
  HiddenField,
  LinearScaleField,
  NumberField,
  PhoneField,
  RatingField,
  RankingField,
  SelectOption,
  TextField,
} from "./types.js";
import { defineForm, type CodeForm } from "./define.js";

/**
 * JSX authoring: `<Fillo.Email id="email" …/>` elements are INERT descriptors —
 * never rendered, only walked. The walk is a pure function over element-shaped
 * objects ({type, props}) with zero react imports, so the same components and
 * compiler work in the browser, in RSC-adjacent client modules, and in Node
 * (CLI extraction). Output is the exact CodeForm defineForm() emits: the sync
 * pipeline, server, and dashboard never see JSX.
 *
 * Emission is canonical and sparse (only authored props, fixed key order) —
 * it feeds the pre-normalization content hash, so ANY change here re-syncs
 * every deployed JSX form. The wire-format snapshot test guards it.
 */

/** Stable error codes; messages carry the fix. Data-integrity errors throw in
 * production too — a silently dropped duplicate id would corrupt response keys. */
export class FilloJsxError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`[fillo] ${message} — https://fillo.so/docs/troubleshooting#jsx-${code.toLowerCase()}`);
    this.name = "FilloJsxError";
  }
}

// Symbol.for: survives minification AND duplicated core copies in one bundle.
const BRAND = Symbol.for("fillo.block");
const REACT_FRAGMENT = Symbol.for("react.fragment");

interface BlockSpec {
  /** Component name, for error messages: Fillo.<name>. */
  name: string;
  kind: string;
  /** Canonical emit order after id/kind; visibleIf always emits last. */
  props: readonly string[];
  /** Accepts <Fillo.Option> children as the options list. */
  optionChildren?: boolean;
  /** String children become the `text` prop (heading/paragraph). */
  textChildren?: boolean;
  /** Accepts Fillo FIELD elements as children, compiled into the `fields`
   *  template (repeating groups). The walk's flatten/classify/buildProps trio
   *  is reentrant, so children build through the exact same path as top-level
   *  blocks. Child ids are per-GROUP (checked here), not global. */
  blockChildren?: boolean;
  /** Content blocks carry no label/required/etc. */
  content?: boolean;
}

const FIELD_BASE = ["label", "description", "required", "placeholder"] as const;

const field = (name: string, kind: string, extra: string[], opts: Partial<BlockSpec> = {}): BlockSpec => ({
  name,
  kind,
  props: [...FIELD_BASE, ...extra],
  ...opts,
});
const content = (name: string, kind: string, textChildren: boolean): BlockSpec => ({
  name,
  kind,
  props: textChildren ? ["text"] : [],
  textChildren,
  content: true,
});

const CHOICE_EXTRA = ["options", "allowOther", "shuffleOptions"];

/** One entry per authorable block — the anti-fan-out manifest: components,
 * walk emission, and the docs table all derive from it. */
export const JSX_BLOCK_SPECS: readonly BlockSpec[] = [
  field("Text", "short_text", ["maxLength"]),
  field("LongText", "long_text", ["maxLength"]),
  field("Email", "email", ["maxLength"]),
  field("Url", "url", ["maxLength"]),
  field("Phone", "phone", ["defaultCountry"]),
  field("Number", "number", ["min", "max", "decimals", "prefix", "suffix", "notation"]),
  field("Select", "select", CHOICE_EXTRA, { optionChildren: true }),
  field("MultiSelect", "multi_select", CHOICE_EXTRA, { optionChildren: true }),
  field("Dropdown", "dropdown", CHOICE_EXTRA, { optionChildren: true }),
  field("Checkbox", "checkbox", ["appearance"]),
  field("Rating", "rating", ["max", "insightsMetric"]),
  field("Scale", "linear_scale", ["min", "max", "minLabel", "maxLabel", "insightsMetric"]),
  field("Ranking", "ranking", ["options"], { optionChildren: true }),
  field("Matrix", "matrix", ["rows", "columns"]),
  field("Signature", "signature", []),
  field("Date", "date", []),
  field("FileUpload", "file_upload", ["maxFiles", "maxFileSizeMb", "accept"]),
  field("Hidden", "hidden", ["paramName", "defaultValue"]),
  field("Calculated", "calculated", ["calc", "decimals", "prefix", "suffix"]),
  field("RepeatingGroup", "repeating_group", ["minInstances", "maxInstances", "addLabel", "itemLabel"], {
    blockChildren: true,
  }),
  field("Custom", "custom", ["component", "config"]),
  content("Heading", "heading", true),
  content("Paragraph", "paragraph", true),
  { name: "Divider", kind: "divider", props: [], content: true },
];

const PAGE_SPEC: BlockSpec = { name: "Page", kind: "__page", props: ["title"] };
const OPTION_SPEC: BlockSpec = { name: "Option", kind: "__option", props: ["label", "icon"] };

type Branded = { (props: unknown): never; [BRAND]?: BlockSpec };

function makeInert(spec: BlockSpec): Branded {
  const component: Branded = () => {
    throw new FilloJsxError(
      "RENDERED_INERT",
      `<Fillo.${spec.name}> was rendered by React. Fillo fields are schema declarations, valid only inside <Fillo.Form> or Fillo.defineForm(). If this form lives in a server component, move it to a client module ("use client")`,
    );
  };
  component[BRAND] = spec;
  return component;
}

/** The inert authoring components, keyed by their Fillo.* name. */
export const JSX_BLOCK_COMPONENTS: Record<string, Branded> = Object.fromEntries([
  ...JSX_BLOCK_SPECS.map((spec) => [spec.name, makeInert(spec)]),
  ["Page", makeInert(PAGE_SPEC)],
  ["Option", makeInert(OPTION_SPEC)],
]);

// ---------- The walk ----------

interface JsxElement {
  type: unknown;
  props: Record<string, unknown>;
}

const isElement = (v: unknown): v is JsxElement =>
  typeof v === "object" && v !== null && "type" in v && "props" in v;

const brandOf = (type: unknown): BlockSpec | undefined =>
  typeof type === "function" ? (type as Branded)[BRAND] : undefined;

/** Recurse arrays and fragments into a flat element list; skip the values JSX
 * emits for absent children (null/undefined/booleans). */
function flatten(children: unknown, out: JsxElement[] = []): JsxElement[] {
  if (children === null || children === undefined || typeof children === "boolean") return out;
  if (Array.isArray(children)) {
    for (const child of children) flatten(child, out);
    return out;
  }
  if (isElement(children)) {
    if (children.type === REACT_FRAGMENT) return flatten(children.props.children, out);
    out.push(children);
    return out;
  }
  throw new FilloJsxError(
    "NON_FILLO_CHILD",
    `Unexpected ${typeof children} child inside <Fillo.Form> — children define the schema; put text in <Fillo.Paragraph> and layout outside the form`,
  );
}

function classify(el: JsxElement): BlockSpec {
  const spec = brandOf(el.type);
  if (spec) return spec;
  const t = el.type;
  if (typeof t === "string") {
    throw new FilloJsxError(
      "NON_FILLO_CHILD",
      `<${t}> is layout, and <Fillo.Form> children define the schema only. Put markup outside the form, or compose your own layout with FilloProvider (headless)`,
    );
  }
  if (typeof t === "object" && t !== null) {
    throw new FilloJsxError(
      "OPAQUE_TYPE",
      `A child of <Fillo.Form> has an opaque component type (lazy/memo or a server-component boundary). Define the form in a client module ("use client") and pass the form VALUE across boundaries instead`,
    );
  }
  const name = typeof t === "function" && t.name ? ` (${t.name})` : "";
  throw new FilloJsxError(
    "WRAPPER_COMPONENT",
    `A plain component${name} is not a Fillo field — <Fillo.Form> never renders children, so wrappers are invisible to it. For reuse, call a plain function that RETURNS Fillo elements: {contactFields()}`,
  );
}

/** Whitelist + sparse canonical emission. Unknown props are loud — a typo'd
 * prop silently vanishing would be the builder-normalizer footgun again. */
function buildProps(spec: BlockSpec, el: JsxElement): Record<string, unknown> {
  const props = el.props;
  const allowed = new Set<string>([...spec.props, "id", "visibleIf", "children"]);
  for (const key of Object.keys(props)) {
    if (props[key] === undefined) continue;
    if (!allowed.has(key)) {
      const hint =
        key === "className" || key === "style"
          ? `styling lives on <Fillo.Form appearance={…}>, never in the schema`
          : `schema props for Fillo.${spec.name}: ${[...spec.props].join(", ")}`;
      throw new FilloJsxError("UNKNOWN_PROP", `Fillo.${spec.name} has no prop "${key}" — ${hint}`);
    }
  }
  const id = props.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new FilloJsxError(
      "MISSING_ID",
      `Every Fillo.${spec.name} needs a stable string id (1-128 chars) — ids key responses, logic, piping, and sync; never derive them from position`,
    );
  }

  const out: Record<string, unknown> = { id, kind: spec.kind };

  // Children first, so props-vs-children conflicts are caught before emission.
  if (spec.optionChildren && props.children !== undefined) {
    if (props.options !== undefined) {
      throw new FilloJsxError(
        "OPTION_PROP_CONFLICT",
        `Fillo.${spec.name} "${id}" has both an options prop and <Fillo.Option> children — pick one`,
      );
    }
    out.__childOptions = flatten(props.children).map((child) => buildOption(child, spec, id));
  } else if (spec.textChildren && props.children !== undefined) {
    const parts = Array.isArray(props.children) ? props.children : [props.children];
    if (!parts.every((p) => typeof p === "string" || typeof p === "number")) {
      throw new FilloJsxError(
        "TEXT_CHILD_REQUIRED",
        `Fillo.${spec.name} children must be plain text (piping tokens like {{name}} included) — expressions and elements can't serialize into the schema`,
      );
    }
    if (props.text !== undefined) {
      throw new FilloJsxError(
        "OPTION_PROP_CONFLICT",
        `Fillo.${spec.name} "${id}" has both a text prop and children — pick one`,
      );
    }
    out.__childText = parts.join("");
  } else if (spec.blockChildren && props.children !== undefined) {
    // Reentrant walk: each child runs through the SAME classify → buildProps
    // path a top-level block does, so per-kind props, options-children, and
    // error behavior are identical one level down. Only genuine FIELD elements
    // may appear — a Page/Option/content child would be silently dropped by
    // schema normalization (a group template holds fields only), and silent
    // drops are the exact footgun this walk exists to prevent.
    const childBlocks = flatten(props.children).map((child) => {
      const childSpec = classify(child);
      if (childSpec.kind === "__page" || childSpec.kind === "__option" || childSpec.content) {
        throw new FilloJsxError(
          "NON_FILLO_CHILD",
          `Fillo.${spec.name} "${id}" children must be field elements, found Fillo.${childSpec.name} — a repeating group's template holds answerable fields only`,
        );
      }
      return buildProps(childSpec, child);
    });
    // Child ids are per-GROUP wire keys (instance records key answers by
    // them). Unique within this group only — the same child id may recur in
    // another group, and global block ids never collide with them (the
    // schemaFromJsx duplicate scan deliberately skips children).
    const childIds = new Set<string>();
    for (const child of childBlocks) {
      const childId = child.id as string;
      if (childIds.has(childId)) {
        throw new FilloJsxError(
          "DUPLICATE_ID",
          `Two fields in repeating group "${id}" share the id "${childId}" — child ids key instance answers and must be unique within the group`,
        );
      }
      childIds.add(childId);
    }
    out.__childBlocks = childBlocks;
  } else if (props.children !== undefined) {
    throw new FilloJsxError(
      "NON_FILLO_CHILD",
      `Fillo.${spec.name} takes no children — its configuration is props-only`,
    );
  }

  for (const key of spec.props) {
    if (key === "options" && out.__childOptions !== undefined) {
      out.options = out.__childOptions;
      continue;
    }
    if (key === "text" && out.__childText !== undefined) {
      out.text = out.__childText;
      continue;
    }
    if (props[key] !== undefined) out[key] = props[key];
  }
  delete out.__childOptions;
  delete out.__childText;
  if (spec.textChildren && out.text === undefined) {
    throw new FilloJsxError("TEXT_CHILD_REQUIRED", `Fillo.${spec.name} "${id}" has no text`);
  }
  if (spec.blockChildren) {
    // Emitted AFTER the scalar props (canonical sparse order: id, kind, base
    // props, min/max/labels, fields, visibleIf last) — a fixed order because
    // this JSON feeds the content hash.
    if (out.__childBlocks === undefined) {
      throw new FilloJsxError(
        "TEXT_CHILD_REQUIRED",
        `Fillo.${spec.name} "${id}" has no fields — a repeating group needs at least one field element as a child (empty templates are invalid)`,
      );
    }
    out.fields = out.__childBlocks;
    delete out.__childBlocks;
  }

  if (props.visibleIf !== undefined) {
    const conditions = Array.isArray(props.visibleIf) ? props.visibleIf : [props.visibleIf];
    out.visibleIf = conditions;
  }
  return out;
}

function buildOption(el: JsxElement, parent: BlockSpec, parentId: string): SelectOption {
  const spec = classify(el);
  if (spec.kind !== "__option") {
    throw new FilloJsxError(
      "NON_FILLO_CHILD",
      `Fillo.${parent.name} "${parentId}" children must be <Fillo.Option> elements, found Fillo.${spec.name}`,
    );
  }
  // Options are wire data ({id, label, icon?}) — no kind marker.
  const props = el.props;
  for (const key of Object.keys(props)) {
    if (props[key] !== undefined && key !== "id" && key !== "label" && key !== "icon") {
      throw new FilloJsxError("UNKNOWN_PROP", `Fillo.Option has no prop "${key}" — it takes id, label, icon`);
    }
  }
  if (typeof props.id !== "string" || props.id.length === 0) {
    throw new FilloJsxError(
      "MISSING_ID",
      `Every <Fillo.Option> in "${parentId}" needs a stable string id — it's the stored answer value`,
    );
  }
  if (typeof props.label !== "string") {
    throw new FilloJsxError("MISSING_ID", `<Fillo.Option id="${props.id}"> needs a label`);
  }
  const option: SelectOption = { id: props.id, label: props.label };
  if (props.icon !== undefined) option.icon = props.icon as SelectOption["icon"];
  return option;
}

function assertUniqueOptionIds(blockId: string, options: SelectOption[], label: string): void {
  const optionIds = new Set<string>();
  for (const option of options) {
    if (optionIds.has(option.id)) {
      throw new FilloJsxError(
        "DUPLICATE_ID",
        `Two ${label} in "${blockId}" share the id "${option.id}" — option ids are stored answer values and must be unique within the field`,
      );
    }
    optionIds.add(option.id);
  }
}

/** Schema-relevant props on <Fillo.Form> — everything else (client, appearance,
 * onSubmitted, …) is renderer configuration the walk must ignore. */
export interface JsxFormMeta {
  id: string;
  title?: string;
  description?: string;
  settings?: FormSettings;
  theme?: FormTheme;
}

export function schemaFromJsx(children: unknown, meta: Omit<JsxFormMeta, "theme">): FormSchema {
  const elements = flatten(children);
  const pageSpecs = elements.map((el) => ({ el, spec: classify(el) }));
  const pages: FormPage[] = [];

  const isPage = (s: BlockSpec) => s.kind === "__page";
  if (pageSpecs.some(({ spec }) => isPage(spec))) {
    if (!pageSpecs.every(({ spec }) => isPage(spec))) {
      throw new FilloJsxError(
        "PAGE_MIX",
        `<Fillo.Form> children must be EITHER all <Fillo.Page> elements or all blocks — wrap the loose blocks in a page`,
      );
    }
    for (const { el } of pageSpecs) {
      const built = buildProps(PAGE_SPEC, { type: el.type, props: { ...el.props, children: undefined } });
      const blocks = flatten(el.props.children).map((child) => {
        const spec = classify(child);
        if (isPage(spec) || spec.kind === "__option") {
          throw new FilloJsxError("PAGE_MIX", `<Fillo.${spec.name}> can't appear inside <Fillo.Page>`);
        }
        return buildProps(spec, child);
      });
      pages.push({
        id: built.id as string,
        ...(built.title !== undefined ? { title: built.title as string } : {}),
        blocks: blocks as unknown as FormPage["blocks"],
      });
    }
  } else {
    const blocks = pageSpecs.map(({ el, spec }) => {
      if (spec.kind === "__option") {
        throw new FilloJsxError(
          "NON_FILLO_CHILD",
          `<Fillo.Option> only makes sense inside a choice field (Select/MultiSelect/Dropdown/Ranking)`,
        );
      }
      return buildProps(spec, el);
    });
    // Implicit single page. The id is a permanent wire-format constant: changing
    // it would re-hash (and re-sync) every deployed single-page JSX form.
    pages.push({ id: "main", blocks: blocks as unknown as FormPage["blocks"] });
  }

  const seen = new Set<string>();
  const pageIds = new Set<string>();
  for (const page of pages) {
    if (pageIds.has(page.id)) {
      throw new FilloJsxError(
        "DUPLICATE_ID",
        `Two pages share the id "${page.id}" — page ids must be unique within a form`,
      );
    }
    pageIds.add(page.id);
    for (const block of page.blocks) {
      if (seen.has(block.id)) {
        throw new FilloJsxError(
          "DUPLICATE_ID",
          `Two blocks share the id "${block.id}" — ids key responses and must be unique across the whole form`,
        );
      }
      seen.add(block.id);

      if ("options" in block) assertUniqueOptionIds(block.id, block.options, "options");
      if (block.kind === "matrix") {
        assertUniqueOptionIds(block.id, block.rows, "matrix rows");
        assertUniqueOptionIds(block.id, block.columns, "matrix columns");
      }
      // Group CHILDREN are deliberately NOT added to `seen` — child ids are a
      // per-group namespace (checked in buildProps), so "guest_name" may recur
      // in two different groups and may even coincide with a global id. Their
      // choice options still need per-field uniqueness, exactly like top level.
      if (block.kind === "repeating_group") {
        for (const child of block.fields) {
          if ("options" in child) assertUniqueOptionIds(child.id, child.options, "options");
        }
      }
    }
  }

  return {
    version: 1,
    title: meta.title ?? "",
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    pages,
    settings: meta.settings ?? {},
  };
}

/** Compile <Fillo.Form> props (or the element from Fillo.defineForm(jsx)) into
 * the same CodeForm defineForm() produces — the sync pipeline sees no JSX. */
export function codeFormFromJsx(meta: JsxFormMeta, children: unknown): CodeForm {
  if (typeof meta.id !== "string" || meta.id.length === 0) {
    throw new FilloJsxError("MISSING_ID", `<Fillo.Form> needs an id — it names the form in your workspace`);
  }
  const schema = schemaFromJsx(children, {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    settings: meta.settings,
  });
  return defineForm({
    id: meta.id,
    title: schema.title,
    description: schema.description,
    pages: schema.pages,
    settings: schema.settings,
    theme: meta.theme,
  });
}
