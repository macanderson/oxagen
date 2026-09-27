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
// THIS FILE ADDS NO DEGRADATION OF ITS OWN — it only wires real
// implementations. Missing-migration behaviour is decided one layer down and is
// FAIL-CLOSED, not graceful: fetchAuthz() catches Postgres 42P01 (relation does
// not exist) and returns a synthetic org-enforced DENY, never empty AuthzData,
// so an unmigrated database denies rather than falling through to each
// contract's defaultEffect (see fetch-authz.ts).
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
import { machineKeyDenial } from "./machine-key-scope";
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
    // A machine-bound key may invoke only what its purpose is for. This runs
    // BEFORE checkIAM on purpose: checkIAM's tier fast-path allows every
    // non-enterprise org outright, and an API-key principal passes every role
    // gate (it has no org_users row to read), so this is the only thing
    // standing between a narrow machine credential and the whole capability
    // surface. See machine-key-scope.ts for what that cost before.
    // `userId` goes with it because one purpose — a CLI session — is exempt
    // from the mandate only when a person came with the key, and this adapter
    // is the one place that knows what the surface resolved.
    const machineDenial = await machineKeyDenial({
      orgId: args.ctx.orgId,
      apiKeyId: args.ctx.apiKeyId,
      userId: args.ctx.userId,
      capabilityName: args.capability,
      // The daemon chain a local MCP gateway call is being served for (#3221).
      // Carried for every caller and read back only for a `tacho_gateway_v1`
      // key, which is the only credential whose use it can attest anything
      // about. It reaches no authorisation decision — the denial below is
      // computed from the key's own scope, exactly as before.
      gatewaySessionUuid: args.ctx.gatewaySessionUuid ?? null,
      gatewayChainGenesisHash: args.ctx.gatewayChainGenesisHash ?? null,
    });
    if (machineDenial !== undefined) {
      return {
        outcome: "deny",
        reason: machineDenial,
        principal: null,
        decision: null,
        decidedBy: "machine_key_scope",
      };
    }

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
    //
    // `decidedBy` is the resolver's rule id for the step that decided
    // (`7:role_grant`, `8:default`, `tier_gate`), so a denied page can name
    // the rule (#3841). Only the id travels: the step's description embeds
    // internal role ids. Null when the trace names no deciding step.
    return {
      outcome,
      reason,
      principal,
      decision: decision ?? null,
      decidedBy: result.trace.decidedBy?.rule ?? null,
    };
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
