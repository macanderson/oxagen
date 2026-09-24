"use client";
// Reads the Exports tab again while the export Build bundle queued is still
// building, so its badge turns ready and Download appears without a reload.
// export_data answers the instant it queues and the archive is written by a
// background job, so the page asks every few seconds and stops once the card
// that renders this is gone (ready or failed).
import { useEffect } from "react";
import { useNavigate } from "@/ui/navigation";

/** How long the tab waits between reads of a building export. */
const EVERY_MS = 5_000;

export function BundleRefresh() {
  const navigate = useNavigate();
  useEffect(() => {
    const timer = setInterval(() => {
      navigate.refresh();
    }, EVERY_MS);
    return () => {
      clearInterval(timer);
    };
  }, [navigate]);
  return null;
}
