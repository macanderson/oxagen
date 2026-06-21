/**
 * Shared types for the Ask-to-Fill feature.
 *
 * These are the single source of truth consumed by:
 *  - C (form.fill contract + handler)
 *  - B2 (useRegisterFillableForm, PageContextProvider)
 *  - D (AskBar UI)
 *
 * No runtime code here — types only. Import from this file, never inline.
 */

/** Supported field types the fill engine understands. */
export type FieldType = "text" | "textarea" | "number" | "select" | "boolean";

/**
 * Describes a single field on a form the agent may fill.
 * Every field must declare its current value so the engine can compute diffs.
 */
export interface FieldDescriptor {
  /** Machine identifier matching the form control's name/key. */
  name: string;
  /** Human-readable label shown in the Ask UI and sent to the model. */
  label: string;
  /** Semantic type that governs how the model fills the field. */
  type: FieldType;
  /** Current value of the field (may be null/undefined for empty fields). */
  current: unknown;
  /**
   * For `select` fields: the allowed options.
   * Required when type === "select".
   */
  options?: { label: string; value: string }[];
  /** Whether the field is required — used in the model system prompt. */
  required?: boolean;
}

/**
 * Per-field result from the fill engine.
 * Both current and proposed are always present so callers can render a diff.
 */
export interface FieldDiff {
  /** The field identifier, matching FieldDescriptor.name. */
  name: string;
  /** The value the field had before the fill operation. */
  current: unknown;
  /** The value the engine proposes for this field. */
  proposed: unknown;
  /** True when proposed !== current (strict equality). */
  changed: boolean;
  /** Model-provided rationale for the change (may be absent for unchanged fields). */
  reason?: string;
}

/** The complete result returned by fillFormAction and the form.fill handler. */
export interface FormFillResult {
  /** One FieldDiff per field in the original FillableFormSpec.fields array. */
  fields: FieldDiff[];
  /**
   * Set when the fill action failed (auth/IAM/billing denial, capability error,
   * or unexpected throw) and returned an all-unchanged fallback. Lets the caller
   * distinguish a genuine "AI proposed no changes" result from a swallowed
   * failure, so the UI can surface an actionable error instead of rendering
   * nothing. Absent on a successful fill.
   */
  error?: string;
}

/**
 * The spec for a form the page registers so the Ask system can fill it.
 * Passed to useRegisterFillableForm and to fillFormAction as the `spec` argument.
 */
export interface FillableFormSpec {
  /** Stable identifier for this form — unique within the current page. */
  formId: string;
  /** Human-readable name displayed in the Ask UI (e.g. "Create project"). */
  title: string;
  /** All fillable fields on the form. */
  fields: FieldDescriptor[];
}
