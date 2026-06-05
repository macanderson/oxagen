"use client";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Toast — shadcn-shaped wrapper over Base UI's imperative toast system.
 *
 * Mount once at the app root:
 *   <ToastProvider><App /><ToastViewport /></ToastProvider>
 *
 * Then enqueue toasts from anywhere under the provider:
 *   const toast = useToast();
 *   toast.add({ title: "Saved", description: "Your changes are live." });
 */
const ToastProvider = ToastPrimitive.Provider;

/** Returns the Base UI toast manager (`.add`, `.update`, `.close`, …). */
function useToast() {
  return ToastPrimitive.useToastManager();
}

/**
 * Toast theming by `type` — the string passed to `useToast().add({ type })`.
 * Errors get a solid danger (red) treatment per standard web practice so they
 * read as failures, not neutral notices; success/warning/info follow the same
 * semantic token pairs that back Badge/Alert. The default (no/unknown type) is
 * the opaque neutral surface. Backgrounds are fully opaque — never translucent.
 */
const TOAST_VARIANTS: Record<string, string> = {
  error: "border-destructive bg-destructive text-destructive-foreground",
  destructive: "border-destructive bg-destructive text-destructive-foreground",
  success: "border-success bg-success text-success-foreground",
  warning: "border-warning bg-warning text-warning-foreground",
  info: "border-info bg-info text-info-foreground",
};
const TOAST_DEFAULT_VARIANT = "border-border bg-background text-foreground";

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => (
    <ToastPrimitive.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "group pointer-events-auto relative flex w-full items-center justify-between gap-2 overflow-hidden rounded-md border p-4 pr-8 shadow-lg",
        (toast.type && TOAST_VARIANTS[toast.type]) ?? TOAST_DEFAULT_VARIANT,
        "transition-[opacity,transform] duration-[var(--motion-base)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[starting-style]:translate-x-full data-[ending-style]:opacity-0",
      )}
    >
      <div className="grid gap-1">
        <ToastPrimitive.Title className="text-sm font-semibold" />
        <ToastPrimitive.Description className="text-sm opacity-90" />
      </div>
      <ToastPrimitive.Close
        className="absolute right-2 top-2 rounded-md p-1 text-current opacity-50 transition-opacity hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-1 group-hover:opacity-70"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ));
}

function ToastViewport({ className }: { className?: string }) {
  return (
    <ToastPrimitive.Portal>
      <ToastPrimitive.Viewport
        className={cn(
          "fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-[420px]",
          className,
        )}
      >
        <ToastList />
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Portal>
  );
}

export { ToastProvider, ToastViewport, useToast };
