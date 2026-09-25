"use client";
// Re-render the server page on an interval while `active`, so a page waiting
// on work that happens outside the browser (a merge on GitHub, a repository
// sync) shows the result without a reload. It pauses while the tab is hidden
// and stops as soon as the page it rendered says there is nothing to wait for.
import { useEffect } from "react";
import { useNavigate } from "@/ui/navigation";

export function LiveRefresh({
  active,
  intervalMs = 5000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") navigate.refresh();
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [active, intervalMs, navigate]);
  return null;
}
