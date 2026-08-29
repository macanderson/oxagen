// denial.ts — DenialResponse factory and type guard.
//
// DenialResponse is the structured value returned by kernel.invoke()
// when the IAM resolver decides deny or pending_approval. The handler is never
// called in these cases. isDenial() narrows the union so callers can handle
// allow vs. denial cleanly without catching exceptions.

import type { DenialResponse } from "@oxagen/oxagen";

export type { DenialResponse };

/**
 * Construct a DenialResponse for a denied invocation.
 */
export function denial(args: {
  outcome: "deny" | "pending_approval";
  reason: string;
  requestId?: string;
}): DenialResponse {
  const response: DenialResponse = {
    __capabilityDenied: true,
    outcome: args.outcome,
    reason: args.reason,
    ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
  };
  return response;
}

/**
 * Type guard — true if the value is a DenialResponse. Re-exported from
 * @oxagen/oxagen types for convenience; callers can import either location.
 */
export { isDenial } from "@oxagen/oxagen";
