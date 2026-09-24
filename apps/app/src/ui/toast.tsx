"use client";
// The mockup's toast stack (engine.css `#toast` and `.toast`, engine.js
// `toast()`): one row per event, newest at the bottom, centred above the
// page's foot, each row a tone dot and one sentence, gone after 4.2 seconds.
// On a phone the stack clears the thumb bar.
//
// The stack is one polite live region that is always mounted, so a screen
// reader announces a row the moment it is added. The dot's hue is the state
// vocabulary the badges use and never the gold.
import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "allowed" | "approval" | "denied" | "failed";

type Toast = { id: number; text: string; tone: ToastTone };

/**
 * engine.js: `setTimeout(function(){t.remove();},4200)`.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const TOAST_MS = 4200;

const DOT: Record<ToastTone, string> = {
  allowed: "bg-success",
  approval: "bg-info",
  denied: "bg-warning",
  failed: "bg-error",
};

/** The rows on screen and the one way to add a row. */
export function useToasts(): {
  toasts: readonly Toast[];
  toast: (text: string, tone?: ToastTone) => void;
} {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timersRef.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  const toast = useCallback((text: string, tone: ToastTone = "allowed") => {
    nextIdRef.current += 1;
    const id = nextIdRef.current;
    setToasts((rows) => [...rows, { id, text, tone }]);
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setToasts((rows) => rows.filter((row) => row.id !== id));
    }, TOAST_MS);
    timersRef.current.add(timer);
  }, []);
  return { toasts, toast };
}

export function ToastStack({
  toasts,
  testId,
}: {
  toasts: readonly Toast[];
  testId: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-toast-stack=""
      className="pointer-events-none fixed bottom-[70px] left-1/2 z-[60] grid w-max max-w-[92vw] -translate-x-1/2 justify-items-center gap-2 max-md:bottom-[calc(88px+env(safe-area-inset-bottom))]"
    >
      {toasts.map((row) => (
        <div
          key={row.id}
          data-toast=""
          data-tone={row.tone}
          className="flex max-w-[min(560px,92vw)] items-center gap-2.5 rounded-[11px] border border-rule bg-card px-4 py-[11px] text-[12.5px] text-card-foreground shadow-lg"
        >
          <span
            aria-hidden="true"
            className={`size-[7px] flex-none rounded-full ${DOT[row.tone]}`}
          />
          <span>{row.text}</span>
        </div>
      ))}
    </div>
  );
}
