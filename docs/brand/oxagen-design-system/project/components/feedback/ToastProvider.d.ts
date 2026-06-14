import * as React from "react";

export type ToastTone = "default" | "success" | "warning" | "danger" | "cyan";

export interface ToastOptions {
  title?: React.ReactNode;
  description?: React.ReactNode;
  tone?: ToastTone;
  icon?: React.ReactNode;
  /** Auto-dismiss ms. Default 4000. */
  duration?: number;
}

/**
 * Toast system. Wrap the app in <ToastProvider>; call useToast().push(opts) to
 * raise a spring-animated, auto-dismissing toast (stacks bottom-right).
 */
export function ToastProvider(props: { children?: React.ReactNode }): React.ReactElement;
export function useToast(): { push: (opts: ToastOptions) => string; dismiss: (id: string) => void };
