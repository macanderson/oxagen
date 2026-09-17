// platform-operator.ts — minting and recognising the one binding that reaches
// a `platformOnly` capability (apps/app/ARCHITECTURE.md §3.9 item 12, INV-31).
//
// A `platformOnly` contract declares `surfaces: []`, so no surface can dispatch
// it, and `defaultRoles: {}` with `defaultEffect: "deny"`. Neither of those is
// the boundary: the kernel's IAM check allows every capability for a
// non-enterprise organisation, so `defaultRoles` decides nothing below
// enterprise, and a caller that reaches `invoke()` directly passes no
// `opts.surface` and therefore never meets the surface allowlist. The boundary
// is this module: `_invokeCore` refuses a `platformOnly` capability unless the
// context carries a binding THIS module minted.
//
// The registry is a module-private WeakSet, the pattern
// `createDeployedAgentInvocationContext` already uses (kernel.ts). A structural
// brand alone is not enough — a cast defeats it — so membership, not shape, is
// what the kernel checks. The WeakSet also means a binding is collected with
// the operator run that made it; nothing accumulates.
//
// The one caller is `tools/scripts/billing-terms.ts`. An arch test
// (src/test/platform-operator-field.test.ts) fails if a second appears.

import type { PlatformOperatorBinding } from "./types";

/** Bindings this module minted. Membership is the authorization, not shape. */
const kernelIssuedPlatformOperators = new WeakSet<PlatformOperatorBinding>();

/**
 * Mint a platform-operator binding for one operator run.
 *
 * `requestId` is the correlation key: the kernel writes it on the audit row
 * for every capability the run invokes, so an operator's credit decisions are
 * findable after the fact by a single id.
 */
export function createPlatformOperatorContext(args: {
  requestId: string;
}): PlatformOperatorBinding {
  const binding = {
    principalKind: "platform_operator",
    requestId: args.requestId,
  } as unknown as PlatformOperatorBinding;
  kernelIssuedPlatformOperators.add(binding);
  return binding;
}

/**
 * True only for a binding this module actually minted. A literal `true`, a
 * spread copy of a minted binding and a JSON round-trip of one are all false:
 * each is a different object, and only the original is in the set.
 */
export function isKernelIssuedPlatformOperator(
  value: unknown,
): value is PlatformOperatorBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    kernelIssuedPlatformOperators.has(value as PlatformOperatorBinding)
  );
}
