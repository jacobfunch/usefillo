import { useRef, type ReactElement, type ReactNode } from "react";
import {
  codeFormFromJsx,
  FilloJsxError,
  isLikelyDevEnv,
  JSX_BLOCK_COMPONENTS,
  type CalculatedField,
  type CheckboxField,
  type ChoiceField,
  type CodeForm,
  type Condition,
  type CustomField,
  type DateField,
  type FileUploadField,
  type FilloClient,
  type FormSettings,
  type FormTheme,
  type HiddenField,
  type LinearScaleField,
  type NumberField,
  type PhoneField,
  type RankingField,
  type RatingField,
  type SelectOption,
  type SignatureField,
  type TextField,
} from "@usefillo/core";
import { FilloForm, type FilloFormProps } from "./FilloForm.js";

/**
 * The authoring namespace: `<Fillo.Form id="contact"><Fillo.Email id="email"
 * label="Work email"/></Fillo.Form>`. Field elements are inert descriptors
 * compiled (never rendered) into the exact CodeForm defineForm() emits, then
 * fed to the existing framed <FilloForm> — same policy-aware resolution and
 * staging, same badge, same responses. Define forms in a client module ("use client");
 * pass the compiled VALUE across server/client boundaries, never the JSX.
 */

type WithVisible<T> = Omit<T, "kind" | "visibleIf"> & {
  visibleIf?: Condition | Condition[];
};
type ChoiceProps = Omit<WithVisible<ChoiceField>, "options"> & {
  options?: SelectOption[];
  children?: ReactNode;
};
type ContentProps = {
  id: string;
  children?: string;
  text?: string;
  visibleIf?: Condition | Condition[];
};

/** Inert: rendering one throws; they exist to be read by the compiler. */
type Inert<P> = (props: P) => never;

const B = JSX_BLOCK_COMPONENTS;

interface FilloJsxFormBaseProps
  extends Omit<FilloFormProps, "form" | "formId" | "client" | "renderOnly" | "skipValidation"> {
  /** Project handle — the form's identity across syncs. */
  id: string;
  title?: string;
  description?: string;
  settings?: FormSettings;
  theme?: FormTheme;
  children?: ReactNode;
}

export type FilloJsxFormProps = FilloJsxFormBaseProps &
  (
    | { client: FilloClient; renderOnly?: false; skipValidation?: false }
    | { client?: FilloClient; renderOnly: true; skipValidation?: boolean }
    | { client?: FilloClient; renderOnly?: boolean; skipValidation: true }
  );

/** Shared core check (dev build OR localhost/loopback hostname). Console-warn
 * only — never render output — so the direct call is fine here; render paths
 * use the hydration-safe useIsDevEnv() from FilloForm.tsx instead. */
const isDevEnv = () => isLikelyDevEnv();

function JsxForm(props: FilloJsxFormProps) {
  const { id, title, description, settings, theme, client, children, ...rest } = props;
  // Pure walk per render (cheap over inert elements); memoize the CodeForm by
  // content so downstream reference-stability (normalize memo, sync effect
  // deps, controller identity) holds across re-renders.
  const compiled = codeFormFromJsx({ id, title, description, settings, theme }, children);
  const json = JSON.stringify(compiled.schema) + JSON.stringify(compiled.theme ?? null);
  const memo = useRef<{ json: string; form: CodeForm } | null>(null);
  if (memo.current && memo.current.json !== json && isDevEnv()) {
    // Schema identity must not depend on client state. An edit-and-reload is
    // fine; a hash that flips at runtime means conditional JSX children.
    console.warn(
      `[fillo] "${id}": form structure changed between renders. If you just edited the form, ignore this. ` +
        "Otherwise: conditional questions are visibleIf={when(…)…}, never {cond && <Fillo.…/>} — " +
        "a per-visitor schema churns drafts in your workspace.",
    );
  }
  if (!memo.current || memo.current.json !== json) {
    memo.current = { json, form: compiled };
  }
  // The compiled CodeForm makes this the code-backed FilloForm variant; a
  // missing client is the render-only path FilloForm already handles loudly.
  return <FilloForm {...({ form: memo.current.form, client, ...rest } as FilloFormProps)} />;
}

function defineFormFromJsx(element: ReactElement<FilloJsxFormProps>): CodeForm {
  if (!element || element.type !== JsxForm) {
    throw new FilloJsxError(
      "NON_FILLO_CHILD",
      "Fillo.defineForm() takes a <Fillo.Form> element: Fillo.defineForm(<Fillo.Form id=…>…</Fillo.Form>)",
    );
  }
  const { id, title, description, settings, theme, children } = element.props;
  return codeFormFromJsx({ id, title, description, settings, theme }, children);
}

export const Fillo = {
  Form: JsxForm,
  /** Compile a <Fillo.Form> element to a CodeForm at module scope — the same
   * value FilloProvider (headless) and the CLI consume. */
  defineForm: defineFormFromJsx,

  Text: B.Text as Inert<WithVisible<TextField>>,
  LongText: B.LongText as Inert<WithVisible<TextField>>,
  Email: B.Email as Inert<WithVisible<TextField>>,
  Url: B.Url as Inert<WithVisible<TextField>>,
  Phone: B.Phone as Inert<WithVisible<PhoneField>>,
  Number: B.Number as Inert<WithVisible<NumberField>>,
  Select: B.Select as Inert<ChoiceProps>,
  MultiSelect: B.MultiSelect as Inert<ChoiceProps>,
  Dropdown: B.Dropdown as Inert<ChoiceProps>,
  Checkbox: B.Checkbox as Inert<WithVisible<CheckboxField>>,
  Rating: B.Rating as Inert<WithVisible<RatingField>>,
  Scale: B.Scale as Inert<WithVisible<LinearScaleField>>,
  Ranking: B.Ranking as Inert<
    Omit<WithVisible<RankingField>, "options"> & { options?: SelectOption[]; children?: ReactNode }
  >,
  Matrix: B.Matrix as Inert<WithVisible<import("@usefillo/core").MatrixField>>,
  Signature: B.Signature as Inert<WithVisible<SignatureField>>,
  Date: B.Date as Inert<WithVisible<DateField>>,
  FileUpload: B.FileUpload as Inert<WithVisible<FileUploadField>>,
  Hidden: B.Hidden as Inert<WithVisible<HiddenField>>,
  Calculated: B.Calculated as Inert<WithVisible<CalculatedField>>,
  Custom: B.Custom as Inert<WithVisible<CustomField>>,
  Heading: B.Heading as Inert<ContentProps>,
  Paragraph: B.Paragraph as Inert<ContentProps>,
  Divider: B.Divider as Inert<{ id: string; visibleIf?: Condition | Condition[] }>,
  Page: B.Page as Inert<{ id: string; title?: string; children?: ReactNode }>,
  Option: B.Option as Inert<Omit<SelectOption, "id"> & { id: string }>,
} as const;
