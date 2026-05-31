// bootstrap.ts — IAM runtime adapter for setIAMRuntime() (OXA-1390, Phase 3).
//
// Surfaces (apps/api, apps/mcp) import bootstrapIAMRuntime() and call it ONCE
// at process start — before any defineContract().invoke() can run — to wire
// the real IAM enforcement functions into the @oxagen/oxagen contract boundary.
//
// WHY AN ADAPTER: checkIAM() returns { result: ResolveResult, principal } but
// IAMCheckFn (define-contract.ts) expects { outcome, reason?, principal }.
// The adapter flattens ResolveResult into those fields so the two packages
// remain independently typed. createAccessRequest() is directly assignable.
//
// GRACEFUL DEGRADATION IS PRESERVED: fetchAuthz() (inside checkIAM) already
// catches Postgres 42P01 (relation does not exist) and returns empty AuthzData,
// so the resolver falls through to each contract's defaultEffect. This file
// adds NO degradation of its own — it only wires real implementations.
//
// IDEMPOTENT: calling bootstrapIAMRuntime() more than once (e.g. in tests or
// hot-reload scenarios) is safe — setIAMRuntime() simply overwrites the refs.

import { setIAMRuntime, type IAMCheckFn, type CreateAccessRequestFn } from "@oxagen/oxagen";
import { checkIAM } from "./check-iam.js";
import { createAccessRequest } from "./access-request.js";

/**
 * Adapter: maps checkIAM's { result: ResolveResult, principal } return shape
 * to the IAMCheckFn-expected { outcome, reason?, principal } shape.
 */
const iamCheckAdapter: IAMCheckFn = async (args) => {
  const { result, principal } = await checkIAM(args);

  // Extract outcome and the optional reason string from the discriminated union.
  const outcome = result.outcome;
  const reason = "reason" in result ? result.reason : undefined;

  return { outcome, reason, principal };
};

/**
 * createAccessRequest is structurally identical to CreateAccessRequestFn —
 * assigned directly with no adapter required.
 */
const createAccessRequestAdapter: CreateAccessRequestFn = createAccessRequest;

/**
 * Wire the real IAM enforcement runtime into defineContract().invoke().
 *
 * Call once per process at surface bootstrap (apps/api/src/index.ts,
 * apps/mcp/src/middleware.ts) before any capability can be invoked.
 * Safe to call multiple times — idempotent overwrite.
 */
export function bootstrapIAMRuntime(): void {
  setIAMRuntime({
    checkIAM: iamCheckAdapter,
    createAccessRequest: createAccessRequestAdapter,
  });
}
