// bootstrap.ts — IAM runtime adapter for kernel.invoke().
//
// Surfaces (apps/api, apps/mcp) import bootstrapIAMRuntime() and call it ONCE
// at process start to wire the real IAM enforcement into kernel.invoke().
//
// WHY AN ADAPTER: checkIAM() returns { result: ResolveResult, principal,
// decision } but KernelIAMCheckFn expects { outcome, reason?, principal,
// decision }. The adapter flattens ResolveResult into those fields so the two
// packages remain independently typed.
//
// GRACEFUL DEGRADATION IS PRESERVED: fetchAuthz() (inside checkIAM) already
// catches Postgres 42P01 (relation does not exist) and returns empty AuthzData,
// so the resolver falls through to each contract's defaultEffect. This file
// adds NO degradation of its own — it only wires real implementations.
//
// IDEMPOTENT: calling bootstrapIAMRuntime() more than once (e.g. in tests or
// hot-reload scenarios) is safe — setKernelIAMRuntime() simply overwrites the ref.
//
// Every contract calls registerCapability() directly and dispatches through
// kernel.invoke() — there is no parallel dispatch path to wire here.

import {
  setKernelIAMRuntime,
  setKernelAccessRequestCreator,
  type KernelIAMCheckFn,
  type KernelAccessRequestCreatorFn,
} from "@oxagen/oxagen/kernel";
import { checkIAM } from "./check-iam";
import { createAccessRequest } from "./access-request";

/**
 * Wire the real IAM enforcement runtime into kernel.invoke().
 *
 * Enforcement is always on — denied invocations are blocked. Non-enterprise
 * orgs are unconditionally allowed by checkIAM's tier_gate fast-path, so
 * enforcement never produces false lockouts for the 90% of customers who
 * don't need ACL management.
 */
export function bootstrapIAMRuntime(): void {
  const kernelIAMAdapter: KernelIAMCheckFn = async (args) => {
    const { result, principal, decision } = await checkIAM({
      ...args,
      // Agent RBAC spec §3.4: the discriminator that keeps the non-enterprise
      // tier fast-path human-only. Derived from the run context the kernel
      // already threads through ctx — agent runs carry ctx.agentRun; every
      // other surface resolves as "human" exactly as before.
      principalKind: args.ctx.agentRun?.principalKind ?? "human",
    });
    const outcome = result.outcome;
    const reason = result.outcome === "deny" ? result.reason : undefined;
    // The platform-created azd_ reference travels back to the kernel, which
    // attaches it to the CheckedContext on an allow and to the thrown
    // CapabilityError otherwise. Agent-run execution fails closed when it is
    // null — an unrecorded decision is not an allowed one.
    return { outcome, reason, principal, decision: decision ?? null };
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
