// A toast (mockups engine.css `#toast` and `.toast`): one row per event,
// centred above the bottom edge, and above the mobile tab bar on a phone. The
// region is a polite live region that renders before its row, so a screen
// reader announces the row when it arrives. The dot is the state hue; a toast
// here only ever reports something that went through.
import type { ReactNode } from "react";

export function ToastRegion({ children }: { children?: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-[70px] left-1/2 z-[300] grid w-max max-w-[92vw] -translate-x-1/2 justify-items-center gap-2 max-md:bottom-[calc(88px+env(safe-area-inset-bottom))]"
    >
      {children}
    </div>
  );
}

export function Toast({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex max-w-[min(560px,92vw)] items-center gap-2.5 rounded-[11px] border border-rule bg-card px-4 py-[11px] text-[12.5px] text-card-foreground shadow-md max-md:max-w-[368px]"
    >
      <span
        aria-hidden
        className="size-[7px] flex-none rounded-full bg-success"
      />
      <span>{children}</span>
    </div>
  );
}
