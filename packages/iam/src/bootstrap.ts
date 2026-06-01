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
import { setKernelIAMRuntime, type KernelIAMCheckFn } from "@oxagen/oxagen/kernel";
import { checkIAM } from "./check-iam.js";
import { createAccessRequest } from "./access-request.js";
import { requireEnv } from "@oxagen/config/env";

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
 * Wire the real IAM enforcement runtime into both dispatch paths:
 *   1. defineContract().invoke() — the contract-level IAM boundary.
 *   2. kernel.invoke() — the kernel-level IAM boundary (OXA-1498).
 *
 * kernel.invoke() reads IAM_ENFORCEMENT_ENABLED to decide whether to BLOCK
 * on deny (true) or only LOG would-deny decisions (false, default). Both
 * paths ALWAYS resolve authz and emit the ClickHouse audit event.
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

  // Wire the kernel IAM path. The kernel adapter mirrors the IAM check adapter
  // (same underlying checkIAM call) but returns the flattened result shape that
  // kernel.invoke() expects (KernelIAMCheckResult).
  const kernelIAMAdapter: KernelIAMCheckFn = async (args) => {
    const { result, principal } = await checkIAM(args);
    const outcome = result.outcome;
    const reason = "reason" in result ? (result as { reason?: string }).reason : undefined;
    return { outcome, reason, principal };
  };

  // Read the enforcement flag at bootstrap time so we don't re-read env on
  // every capability invocation. The flag is immutable for the process lifetime.
  const enforced =
    requireEnv(["IAM_ENFORCEMENT_ENABLED"] as const).IAM_ENFORCEMENT_ENABLED === true;

  setKernelIAMRuntime(kernelIAMAdapter, enforced);
}
