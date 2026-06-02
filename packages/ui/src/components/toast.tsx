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

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => (
    <ToastPrimitive.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "group pointer-events-auto relative flex w-full items-center justify-between gap-2 overflow-hidden rounded-md border bg-background p-4 pr-8 shadow-lg",
        "transition-[opacity,transform] data-[starting-style]:opacity-0 data-[starting-style]:translate-x-full data-[ending-style]:opacity-0",
      )}
    >
      <div className="grid gap-1">
        <ToastPrimitive.Title className="text-sm font-semibold" />
        <ToastPrimitive.Description className="text-sm opacity-90" />
      </div>
      <ToastPrimitive.Close
        className="absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-1 group-hover:opacity-100"
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
