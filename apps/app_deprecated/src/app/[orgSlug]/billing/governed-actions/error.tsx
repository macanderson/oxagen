"use client";
/**
 * error.tsx — the error boundary for the governed-action meter.
 *
 * Scoped to this segment so a fault here never takes down the billing shell or
 * the sibling tabs. The three panel reads already degrade individually; this
 * catches what is left (an auth resolve failing, a render throw).
 */

import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

export default function GovernedActionsError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <ErrorState
        title="Couldn't load governed actions"
        description="The governed-action meter failed to render. No figure on this page is shown until it can be read, so nothing here is stale — try again."
        retry={reset}
      />
    </div>
  );
}
