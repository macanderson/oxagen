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

import {
  setKernelIAMRuntime,
  setKernelAccessRequestCreator,
  type KernelIAMCheckFn,
  type KernelAccessRequestCreatorFn,
} from "@oxagen/oxagen/kernel";
import { checkIAM } from "./check-iam";
import { createAccessRequest } from "./access-request";

/**
 * Wire the real IAM enforcement runtime into kernel.invoke() (OXA-1498).
 *
 * Enforcement is always on — denied invocations are blocked. Non-enterprise
 * orgs are unconditionally allowed by checkIAM's tier_gate fast-path, so
 * enforcement never produces false lockouts for the 90% of customers who
 * don't need ACL management.
 */
export function bootstrapIAMRuntime(): void {
  const kernelIAMAdapter: KernelIAMCheckFn = async (args) => {
    const { result, principal } = await checkIAM({
      ...args,
      // Agent RBAC spec §3.4: the discriminator that keeps the non-enterprise
      // tier fast-path human-only. Derived from the run context the kernel
      // already threads through ctx — agent runs carry ctx.agentRun; every
      // other surface resolves as "human" exactly as before.
      principalKind: args.ctx.agentRun?.principalKind ?? "human",
    });
    const outcome = result.outcome;
    const reason = result.outcome === "deny" ? result.reason : undefined;
    return { outcome, reason, principal };
  };

  setKernelIAMRuntime(kernelIAMAdapter, /* enforced */ true);

  // Wire the JIT access-request creator so a `pending_approval` resolution mints
  // an org.access_requests row the caller can poll. The kernel calls this only
  // on the enforced pending_approval deny path; it can never grant access —
  // createAccessRequest already degrades to null when the principal is absent.
  const accessRequestCreator: KernelAccessRequestCreatorFn = (args) =>
    createAccessRequest(args);

  setKernelAccessRequestCreator(accessRequestCreator);
}
