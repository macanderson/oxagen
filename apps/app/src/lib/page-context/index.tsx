"use client";
/**
 * page-context/index.tsx
 *
 * PageContextProvider — client component that holds the current page entity
 * and the registered fillable form. Wrap the app shell or route segment with
 * this provider so AskBar, AskDrawer, and FillOverlay can subscribe.
 *
 * Exported hooks:
 *   usePageContext()             — consume the full context value
 *   useRegisterPageEntity()      — register/unregister the page entity on mount/unmount
 *   useRegisterFillableForm()    — register/unregister the fillable form on mount/unmount
 */

import * as React from "react";
import type { PageContextValue, PageEntity, RegisteredFillableForm } from "./types";
import type { FormFillResult } from "@/lib/ask/fill-types";
export type { PageContextValue, PageEntity, RegisteredFillableForm } from "./types";
export type { FillableFormSpec, FieldDescriptor, FieldDiff, FormFillResult, FieldType } from "@/lib/ask/fill-types";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const PageContext = React.createContext<PageContextValue | null>(null);
PageContext.displayName = "PageContext";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function PageContextProvider({ children }: { children: React.ReactNode }) {
  const [entity, setEntity] = React.useState<PageEntity | null>(null);
  const [fillableForm, setFillableForm] = React.useState<RegisteredFillableForm | null>(null);
  const [fillResult, setFillResult] = React.useState<FormFillResult | null>(null);
  const [isFilling, setIsFilling] = React.useState(false);
  const [isAskOpen, setIsAskOpen] = React.useState(false);
  const [isCommandOpen, setIsCommandOpen] = React.useState(false);

  const value = React.useMemo<PageContextValue>(
    () => ({
      entity,
      fillableForm,
      fillResult,
      isFilling,
      _setEntity: setEntity,
      _setFillableForm: setFillableForm,
      _setFillResult: setFillResult,
      _setIsFilling: setIsFilling,
      isAskOpen,
      openAsk: () => setIsAskOpen(true),
      closeAsk: () => setIsAskOpen(false),
      isCommandOpen,
      openCommand: () => setIsCommandOpen(true),
      closeCommand: () => setIsCommandOpen(false),
    }),
    [entity, fillableForm, fillResult, isFilling, isAskOpen, isCommandOpen],
  );

  return <PageContext.Provider value={value}>{children}</PageContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Consume the PageContext. Must be used inside a PageContextProvider. */
export function usePageContext(): PageContextValue {
  const ctx = React.useContext(PageContext);
  if (!ctx) {
    throw new Error("usePageContext must be used inside PageContextProvider");
  }
  return ctx;
}

/**
 * Register the current page entity.
 * Registers on mount, clears on unmount.
 *
 * The effect key is derived from entity properties so it only re-fires when
 * the entity actually changes, not on every render of the registering component.
 *
 * @example
 * useRegisterPageEntity({ kind: "workspace", id: ws.id, label: ws.name, summary: ws.description })
 */
export function useRegisterPageEntity(entity: PageEntity): void {
  const { _setEntity } = usePageContext();
  // Derive a stable string from all entity fields so the effect only re-fires
  // when a field value actually changes, not when the caller re-renders with a
  // new object reference holding identical values.
  const kind = entity.kind;
  const id = entity.id;
  const label = entity.label;
  const summary = entity.summary;
  React.useEffect(() => {
    _setEntity({ kind, id, label, summary });
    return () => {
      _setEntity(null);
    };
  }, [_setEntity, kind, id, label, summary]);
}

/**
 * Register a fillable form for the current page.
 * Registers on mount, clears on unmount.
 *
 * The `spec` and `apply` together describe the form the AI fill engine can
 * propose values for, and the callback to invoke when the user accepts.
 *
 * @example
 * useRegisterFillableForm({
 *   formId: "create-project",
 *   title: "Create project",
 *   fields: [...],
 *   apply: (values, mode, fieldName) => { ... }
 * })
 */
export function useRegisterFillableForm(form: RegisteredFillableForm): void {
  const { _setFillableForm } = usePageContext();
  // Derive a stable key from formId + field names so the effect only re-fires
  // when the form shape actually changes rather than on every render.
  const formId = form.formId;
  const fieldsKey = form.fields.map((f) => f.name).join(",");
  // `apply` is a callback; capture a stable ref so it does not re-register on
  // every render when the caller creates a new function reference each time.
  // The ref is updated in a layout effect (not inline during render) to stay
  // compatible with the react-hooks/refs lint rule.
  const applyRef = React.useRef(form.apply);
  React.useLayoutEffect(() => {
    applyRef.current = form.apply;
  });
  const stableApply = React.useCallback<typeof form.apply>(
    (...args) => applyRef.current(...args),
    [],
  );
  React.useEffect(() => {
    _setFillableForm({
      formId,
      title: form.title,
      fields: form.fields,
      apply: stableApply,
    });
    return () => {
      _setFillableForm(null);
    };
  }, [_setFillableForm, formId, form.title, form.fields, fieldsKey, stableApply]);
}
