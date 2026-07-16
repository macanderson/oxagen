"use client";

import * as React from "react";

/**
 * Countdown to a deadline, ticking once a second. Shared by ConsentCard and
 * ApprovalCard (both render an "expires in …" affordance over the same
 * approval/consent deadline).
 *
 * `stop` freezes the ticker (pass it once the card is settled), and the effect
 * self-clears the moment the deadline is crossed. Without that self-clear the
 * interval re-renders a resolved/expired card every second for the rest of the
 * conversation's life (mirrors useElapsed in background-task-tray).
 */
export function useCountdown(expiresAt: string, stop: boolean): number {
  const target = React.useMemo(() => new Date(expiresAt).getTime(), [expiresAt]);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (stop || Date.now() >= target) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= target) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [stop, target]);
  return Math.max(0, target - now);
}

/** Format a remaining-ms duration as `Xm Ys` (or `Ys` under a minute). */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
