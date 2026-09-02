"use client";

import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

export default function AutomationsError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <ErrorState
        title="Couldn't load Automations"
        description="Something went wrong rendering this section. Try again."
        retry={reset}
      />
    </div>
  );
}
