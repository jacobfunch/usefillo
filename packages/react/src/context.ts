import { allFields, type Field, type FieldValue, type FilloError } from "@usefillo/core";
import { createContext, useContext, useId, useMemo } from "react";
import type { FilloApi, FilloFieldIds } from "./api.js";

export const FilloContext = createContext<FilloApi | null>(null);
export const FilloInstanceIdContext = createContext<string | null>(null);

/**
 * Renderer sync/dev-chrome state that flows OUTSIDE the form engine: whether
 * dev chrome is active (`preview` prop or dev environment) and the sync
 * warning, when one arrived (today `"storage_required"` plus the dashboard
 * URL that fixes it). Internal — field components read it to pre-empt
 * requests the server is known to refuse (the upload dropzone). Null outside
 * the built-in providers.
 */
export interface FilloChromeState {
  devChrome: boolean;
  /** Explicit local preview: no submission or upload transport is connected. */
  renderOnly?: boolean;
  /** Server-authoritative ability to start a new upload. */
  uploadsAvailable?: boolean;
  /** Server-authoritative per-file ceiling for the active storage lane. */
  uploadFileSizeLimitMb?: number;
  warningCode?: string;
  warningUrl?: string;
  /** Preserve full SDK diagnostics for the host while built-in fields render
   * only localized, respondent-safe copy. */
  onError?: (error: FilloError) => void;
}

export const FilloChromeContext = createContext<FilloChromeState | null>(null);

/** @internal Read the renderer's dev-chrome/sync state (null when absent). */
export function useFilloChrome(): FilloChromeState | null {
  return useContext(FilloChromeContext);
}

/**
 * Push text through the form's persistent polite live region (contract
 * §Announcements). A single shared channel serializes every announcement —
 * ranking moves, phone country/filter updates, submitting, resume — so
 * assistive tech never has to arbitrate between competing regions.
 */
export type FilloAnnounce = (text: string) => void;

const noopAnnounce: FilloAnnounce = () => {};

/** Default is a no-op so field components work uninstrumented outside
 * <FilloForm> (e.g. a bare <FilloProvider> composition, which renders no
 * layout and so provides no channel). */
export const FilloAnnounceContext = createContext<FilloAnnounce>(noopAnnounce);

/** @internal Announce text through the form's persistent live region. */
export function useFilloAnnounce(): FilloAnnounce {
  return useContext(FilloAnnounceContext);
}

function useFilloInstanceId(): string {
  const instanceId = useContext(FilloInstanceIdContext);
  const fallbackId = useId().replace(/:/g, "");
  return instanceId ?? fallbackId;
}

export function createFilloFieldIds(instanceId: string, fieldId: string): FilloFieldIds {
  const base = `fillo-${instanceId}-${fieldId}`;
  return {
    inputId: base,
    labelId: `${base}-label`,
    descriptionId: `${base}-desc`,
    errorId: `${base}-error`,
    name: base,
  };
}

/**
 * The full form engine — data, errors, pages, submit, status. Use inside a
 * <FilloForm> or <FilloProvider> to build completely custom layouts.
 */
export function useFillo(): FilloApi {
  const api = useContext(FilloContext);
  if (!api) throw new Error("useFillo must be used inside <FilloForm> or <FilloProvider>");
  return api;
}

export function useFilloFieldIds(fieldId: string, ids?: FilloFieldIds): FilloFieldIds {
  const instanceId = useFilloInstanceId();
  return ids ?? createFilloFieldIds(instanceId, fieldId);
}

export interface FieldHandle {
  /** The field's schema entry, or undefined if no field has this id. */
  field: Field | undefined;
  value: FieldValue;
  error: string | undefined;
  setValue: (value: FieldValue) => void;
}

/**
 * Drive a single field by id — render it however you like, wherever you like.
 * The engine still validates it, runs logic and handles submit. This is the
 * lowest-level hook: with it you owe Fillo nothing but the field id.
 */
export function useField(fieldId: string): FieldHandle {
  const api = useFillo();
  // Flatten the field list once per form, not per render — builders keep the
  // normalized form reference stable until the schema actually changes.
  const fieldsById = useMemo(() => {
    const map = new Map<string, Field>();
    for (const f of allFields(api.form)) map.set(f.id, f);
    return map;
  }, [api.form]);
  const field = fieldsById.get(fieldId);
  return {
    field,
    value: api.data[fieldId],
    error: api.errors[fieldId],
    setValue: (value: FieldValue) => api.setValue(fieldId, value),
  };
}
