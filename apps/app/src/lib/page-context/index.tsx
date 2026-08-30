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
import type {
  PageContextValue,
  PageEntity,
  RegisteredFillableForm,
} from "./types";
import type { FormFillResult } from "@/lib/ask/fill-types";
export type {
  PageContextValue,
  PageEntity,
  RegisteredFillableForm,
} from "./types";
export type {
  FillableFormSpec,
  FieldDescriptor,
  FieldDiff,
  FormFillResult,
  FieldType,
} from "@/lib/ask/fill-types";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const PageContext = React.createContext<PageContextValue | null>(null);
PageContext.displayName = "PageContext";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function PageContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [entity, setEntity] = React.useState<PageEntity | null>(null);
  const [fillableForm, setFillableForm] =
    React.useState<RegisteredFillableForm | null>(null);
  const [fillResult, setFillResult] = React.useState<FormFillResult | null>(
    null,
  );
  const [isFilling, setIsFilling] = React.useState(false);
  const [isAskOpen, setIsAskOpen] = React.useState(false);
  const [isCommandOpen, setIsCommandOpen] = React.useState(false);
  const [isWandOpen, setIsWandOpen] = React.useState(false);
  const [pendingAskText, setPendingAskText] = React.useState<string | null>(
    null,
  );
  const [pendingAskAutoSubmit, setPendingAskAutoSubmit] = React.useState(false);

  // Stable callbacks: useCallback with [] dep so these function references
  // never change. This prevents the pageCtx object from being recreated (via
  // the useMemo below) on every isAskOpen/isCommandOpen state change. Inline
  // arrows inside a useMemo would produce new references on every memo run,
  // causing all consumers of usePageContext() to re-render unnecessarily and
  // potentially entering a "Maximum update depth exceeded" loop when those
  // consumers have effects that depend on the full pageCtx object.
  const openAsk = React.useCallback(() => setIsAskOpen(true), []);
  const closeAsk = React.useCallback(() => setIsAskOpen(false), []);
  const openCommand = React.useCallback(() => setIsCommandOpen(true), []);
  const closeCommand = React.useCallback(() => setIsCommandOpen(false), []);
  const openWand = React.useCallback(() => setIsWandOpen(true), []);
  const closeWand = React.useCallback(() => setIsWandOpen(false), []);
  const openAskWithText = React.useCallback(
    (text: string, autoSubmit = false) => {
      setPendingAskText(text);
      setPendingAskAutoSubmit(autoSubmit);
      setIsAskOpen(true);
    },
    [],
  );
  const _clearPendingAskText = React.useCallback(() => {
    setPendingAskText(null);
    setPendingAskAutoSubmit(false);
  }, []);

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
      openAsk,
      closeAsk,
      isCommandOpen,
      openCommand,
      closeCommand,
      isWandOpen,
      openWand,
      closeWand,
      pendingAskText,
      pendingAskAutoSubmit,
      openAskWithText,
      _clearPendingAskText,
    }),
    [
      entity,
      fillableForm,
      fillResult,
      isFilling,
      isAskOpen,
      openAsk,
      closeAsk,
      isCommandOpen,
      openCommand,
      closeCommand,
      isWandOpen,
      openWand,
      closeWand,
      pendingAskText,
      pendingAskAutoSubmit,
      openAskWithText,
      _clearPendingAskText,
    ],
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
  // Derive stable string keys from field names and current values so the effect
  // only re-fires when form content actually changes — not on every render when
  // the caller passes a new array literal with identical data.
  const fieldsKey = form.fields.map((f) => f.name).join(",");
  const fieldsCurrentKey = form.fields
    .map((f) => `${f.name}:${String(f.current ?? "")}`)
    .join("|");
  const formTitle = form.title;
  // Snapshot the fields array at the time the stable keys are computed so the
  // effect closure captures the latest values without depending on the unstable
  // object reference itself.
  const fieldsRef = React.useRef(form.fields);
  React.useLayoutEffect(() => {
    fieldsRef.current = form.fields;
  });
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
      title: formTitle,
      fields: fieldsRef.current,
      apply: stableApply,
    });
    return () => {
      _setFillableForm(null);
    };
    // Depend only on stable primitive keys — not the `form.fields` array
    // reference, which is a new object on every render and was the source of
    // the infinite-render loop. `fieldsRef`/`applyRef` are refs (stable), and
    // fieldsKey/fieldsCurrentKey re-fire the effect when content genuinely
    // changes.
  }, [
    _setFillableForm,
    formId,
    formTitle,
    fieldsKey,
    fieldsCurrentKey,
    stableApply,
  ]);
}
