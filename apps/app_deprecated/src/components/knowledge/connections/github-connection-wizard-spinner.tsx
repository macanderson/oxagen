"use client";

/**
 * github-connection-wizard-spinner.tsx — Inline spinner used across wizard steps.
 */

import { RefreshCw } from "lucide-react";

export function Spinner({ className }: { className?: string }) {
  return (
    <RefreshCw
      className={`h-4 w-4 animate-spin ${className ?? ""}`}
      aria-hidden="true"
    />
  );
}
