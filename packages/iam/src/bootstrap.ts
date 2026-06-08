// bootstrap.ts — IAM runtime adapter for kernel.invoke() (OXA-1390, OXA-1498).
//
// Surfaces (apps/api, apps/mcp) import bootstrapIAMRuntime() and call it ONCE
// at process start to wire the real IAM enforcement into kernel.invoke().
//
// WHY AN ADAPTER: checkIAM() returns { result: ResolveResult, principal } but
// KernelIAMCheckFn expects { outcome, reason?, principal }. The adapter
// flattens ResolveResult into those fields so the two packages remain
// independently typed.
//
// GRACEFUL DEGRADATION IS PRESERVED: fetchAuthz() (inside checkIAM) already
// catches Postgres 42P01 (relation does not exist) and returns empty AuthzData,
// so the resolver falls through to each contract's defaultEffect. This file
// adds NO degradation of its own — it only wires real implementations.
//
// IDEMPOTENT: calling bootstrapIAMRuntime() more than once (e.g. in tests or
// hot-reload scenarios) is safe — setKernelIAMRuntime() simply overwrites the ref.
//
// NOTE: The defineContract() parallel dispatch path and its setIAMRuntime() /
// clearIAMRuntime() injection points were removed because no contracts used
// defineContract() — all 43 contracts call registerCapability() directly and
// dispatch through kernel.invoke(). The dead defineContract.ts file was
// deleted in the release-audit-ce1cec3 fix bundle.

import { setKernelIAMRuntime, type KernelIAMCheckFn } from "@oxagen/oxagen/kernel";
import { checkIAM } from "./check-iam";
import { requireEnv } from "@oxagen/config/env";

/**
 * Wire the real IAM enforcement runtime into kernel.invoke() (OXA-1498).
 *
 * kernel.invoke() reads IAM_ENFORCEMENT_ENABLED to decide whether to BLOCK
 * on deny (true) or only LOG would-deny decisions (false). Both paths ALWAYS
 * resolve authz and emit the ClickHouse audit event.
 *
 * Call once per process at surface bootstrap (apps/api/src/index.ts,
 * apps/mcp/src/middleware.ts) before any capability can be invoked.
 * Safe to call multiple times — idempotent overwrite.
 */
export function bootstrapIAMRuntime(): void {
  // Wire the kernel IAM path. The adapter flattens checkIAM's ResolveResult
  // into the { outcome, reason?, principal } shape that KernelIAMCheckFn expects.
  const kernelIAMAdapter: KernelIAMCheckFn = async (args) => {
    const { result, principal } = await checkIAM(args);
    const outcome = result.outcome;
    const reason = result.outcome === "deny" ? result.reason : undefined;
    return { outcome, reason, principal };
  };

  // Read the enforcement flag at bootstrap time so we don't re-read env on
  // every capability invocation. The flag is immutable for the process lifetime.
  const enforced =
    requireEnv(["IAM_ENFORCEMENT_ENABLED"] as const).IAM_ENFORCEMENT_ENABLED === true;

  setKernelIAMRuntime(kernelIAMAdapter, enforced);
}
