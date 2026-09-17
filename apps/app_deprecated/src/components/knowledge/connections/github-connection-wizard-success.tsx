"use client";

/**
 * github-connection-wizard-success.tsx — Terminal success state shown after
 * the initial sync has been triggered.
 */

import { CheckCircle2 } from "lucide-react";

export function SuccessState({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/12">
        <CheckCircle2 className="h-6 w-6 text-success" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">Sync started!</p>
        <p className="text-xs text-muted-foreground">
          Your GitHub repositories are being indexed. This may take a few
          minutes. You can check the status on the Sources page.
        </p>
      </div>
      <button
        type="button"
        className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        onClick={onClose}
        data-testid="wizard-done-btn"
      >
        Done
      </button>
    </div>
  );
}
