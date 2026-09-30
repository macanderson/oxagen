// oxagen-assistant.ts: minting and recognising the binding that marks a call
// as Stella's, the in-app assistant's (ADR-235).
//
// Stella is Oxagen's own agent. The customer's workspace does not govern it
// and does not monitor it. So the kernel's workspace decision-rules gate does
// not run for a call that carries this binding. The person's own IAM check
// still runs, and so do the billing, budget, and entitlement gates, the usage
// recorder, and the security event emitter. The binding decides the rules
// alone: the turn keeps its calls out of the workspace's monitoring by other
// means, for a turn an API key starts as well (ADR-235).
//
// The binding widens what a call may do, so no request can be allowed to
// claim it. The registry is a module-private WeakSet, the pattern
// `createPlatformOperatorContext` (platform-operator.ts) and
// `createDeployedAgentInvocationContext` (kernel.ts) already use. A cast
// defeats a structural brand, so the kernel checks membership, not shape. A
// literal, a spread copy, and a JSON round trip of a minted binding are each a
// different object, and the kernel refuses each one as a forged binding.
//
// Two callers mint one: the assistant turn
// (packages/agent/src/runtime/assistant-turn.ts) and the resume of a call one
// of its turns parked (packages/agent/src/runtime/approval-resume.ts). An arch
// test (src/test/oxagen-assistant-field.test.ts) fails if a third appears.

import type { OxagenAssistantBinding } from "./types";

/** Bindings this module minted. Membership is the authorization, not shape. */
const kernelIssuedAssistantBindings = new WeakSet<OxagenAssistantBinding>();

/**
 * Mint the binding for one Stella turn, or for the resume of a call a Stella
 * turn parked.
 *
 * `requestId` is the correlation key. It is the request the turn answers, so
 * the binding names the turn it was minted for.
 */
export function createOxagenAssistantBinding(args: {
  requestId: string;
}): OxagenAssistantBinding {
  const binding = {
    principalKind: "oxagen_assistant",
    requestId: args.requestId,
  } as unknown as OxagenAssistantBinding;
  kernelIssuedAssistantBindings.add(binding);
  return binding;
}

/** True only for a binding this module minted. */
export function isKernelIssuedOxagenAssistant(
  value: unknown,
): value is OxagenAssistantBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    kernelIssuedAssistantBindings.has(value as OxagenAssistantBinding)
  );
}

/**
 * True when `ctx` is a call Stella makes: it carries a minted binding and it
 * names no customer agent.
 *
 * A context that carries an agent run or a deployed-agent invocation acts as
 * a customer's agent, and the customer's workspace governs that agent however
 * the context was built. A handler that starts one from Stella's context by
 * spreading it gets a context the workspace still governs.
 */
export function isOxagenAssistantCall(ctx: {
  oxagenAssistant?: unknown;
  agentRun?: unknown;
  deployedAgentInvocation?: unknown;
}): boolean {
  return (
    ctx.agentRun === undefined &&
    ctx.deployedAgentInvocation === undefined &&
    isKernelIssuedOxagenAssistant(ctx.oxagenAssistant)
  );
}
