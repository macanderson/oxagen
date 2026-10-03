"use client";
// Re-render the server page on an interval while `active`, so a page waiting
// on work that happens outside the browser (a merge on GitHub, a repository
// sync) shows the result without a reload. It pauses while the tab is hidden
// and stops as soon as the page it rendered says there is nothing to wait for.
//
// A tick is skipped while the last refresh is still rendering. The router runs
// refreshes and server actions through one queue, one at a time, so on a page
// whose render takes longer than the interval, refreshes would pile up without
// end, and an action the page sends would wait behind all of them. That is
// the suspected cause of the wizard's steering panel sitting on "Reading…"
// while a new workspace's steering repo provisioned.
import { useEffect, useRef, useTransition } from "react";
import { useNavigate } from "@/ui/navigation";

export function LiveRefresh({
  active,
  intervalMs = 5000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const navigate = useNavigate();
  const [pending, startTransition] = useTransition();
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = pending;
  }, [pending]);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      startTransition(() => {
        navigate.refresh();
      });
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [active, intervalMs, navigate]);
  return null;
}
