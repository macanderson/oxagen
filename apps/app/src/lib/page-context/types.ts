/**
 * page-context/types.ts — shared types for the PageContext system.
 *
 * Used by:
 *   - PageContextProvider / usePageContext / useRegisterPageEntity / useRegisterFillableForm
 *   - AskBar, AskDrawer, FillOverlay (consume context)
 *   - D (downstream shell consumers)
 *
 * No runtime code here — types only.
 */

import type { FillableFormSpec, FormFillResult } from "@/lib/ask/fill-types";

/**
 * Describes the entity the current page is "about".
 * Registered via useRegisterPageEntity so the Ask system can carry
 * rich context into the AI fill / chat calls.
 */
export interface PageEntity {
  /** Semantic kind, e.g. "project", "workspace", "agent", "user". */
  kind: string;
  /** Database / public identifier. */
  id: string;
  /** Human-readable label (e.g. "Production workspace"). */
  label?: string;
  /**
   * One-or-two sentence summary that is appended to the agent system prompt.
   * Keep it ≤200 chars.
   */
  summary?: string;
}

/**
 * A fillable form registered by a page.
 * The `apply` callback is called by the FillOverlay when the user accepts
 * field proposals from the AI fill engine.
 *
 * mode "field" + fieldName  → apply a single accepted field value.
 * mode "all"                → apply all accepted field values at once.
 */
export interface RegisteredFillableForm extends FillableFormSpec {
  /**
   * Called when the user accepts proposed values from the fill overlay.
   *
   * @param values  Map of field name → proposed value to apply.
   * @param mode    "field" for single-field accept, "all" for accept-all.
   * @param fieldName  Present only when mode === "field".
   */
  apply: (
    values: Record<string, unknown>,
    mode: "field" | "all",
    fieldName?: string,
  ) => void;
}

/** The full shape of the PageContext value. */
export interface PageContextValue {
  /** The entity the current page describes, if any. */
  entity: PageEntity | null;
  /** The fillable form registered on the current page, if any. */
  fillableForm: RegisteredFillableForm | null;
  /** The current fill result from a pending AI fill, if any. */
  fillResult: FormFillResult | null;
  /** True while a fill is in-flight. */
  isFilling: boolean;

  // Setters used by registration hooks — not for direct consumer use.
  _setEntity: (entity: PageEntity | null) => void;
  _setFillableForm: (form: RegisteredFillableForm | null) => void;
  _setFillResult: (result: FormFillResult | null) => void;
  _setIsFilling: (value: boolean) => void;

  /** Ask drawer open state — managed by the provider. */
  isAskOpen: boolean;
  openAsk: () => void;
  closeAsk: () => void;

  /** Command menu open state. */
  isCommandOpen: boolean;
  openCommand: () => void;
  closeCommand: () => void;
}
