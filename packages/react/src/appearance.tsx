import { createContext, useContext } from "react";
import {
  DEFAULT_FIELD_STRINGS,
  DEFAULT_STRINGS,
  slotClass,
  type Field,
  type FilloAppearance,
  type FilloRendererStrings,
  type SlotState,
} from "@usefillo/core";

/**
 * Appearance flows by context so every default renderer (and FormField in
 * composition mode) resolves slot classes without prop-drilling. The badge is
 * not a slot — appearance can never reach it.
 */
export const FilloAppearanceContext = createContext<FilloAppearance | undefined>(undefined);

export function useSlotClass(base: string, state: SlotState): string {
  const appearance = useContext(FilloAppearanceContext);
  return slotClass(base, appearance, state);
}

/** The raw appearance object — for renderers that resolve slots inside loops. */
export function useFilloAppearance(): FilloAppearance | undefined {
  return useContext(FilloAppearanceContext);
}

/** Slot classes + data contract for a field's chrome — the shared shape for
 * renderers that build their own wrapper instead of using FieldShell
 * (phone/upload/signature have layout FieldShell can't express). */
export function useFieldSlots(field: Field, error: string | undefined) {
  const appearance = useContext(FilloAppearanceContext);
  const state = {
    kind: field.kind,
    fieldId: field.id,
    invalid: Boolean(error),
    required: Boolean(field.required),
  };
  return {
    wrapperProps: (base: string) => ({
      className: slotClass(base, appearance, { slot: "field", ...state }),
      "data-fillo": "field" as const,
      "data-field": field.id,
      "data-kind": field.kind,
      "data-invalid": error ? "" : undefined,
      "data-required": field.required ? "" : undefined,
    }),
    label: slotClass("fillo-label", appearance, { slot: "label", ...state }),
    description: slotClass("fillo-description", appearance, { slot: "fieldDescription", ...state }),
    error: slotClass("fillo-error", appearance, { slot: "error", ...state }),
    control: (base: string) => slotClass(base, appearance, { slot: "control", ...state }),
  };
}

export const FilloStringsContext = createContext<FilloRendererStrings>({
  ...DEFAULT_STRINGS,
  ...DEFAULT_FIELD_STRINGS,
});

/** Resolved renderer strings (chrome + field defaults merged with the `strings` prop). */
export function useStrings(): FilloRendererStrings {
  return useContext(FilloStringsContext);
}
