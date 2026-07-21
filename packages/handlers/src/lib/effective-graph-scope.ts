// effective-graph-scope.ts — the ONE place the effective agent GraphScope is
// computed (Agent RBAC Phase 3b, docs/specs/agent-rbac/spec.md §3.3/§3.6).
//
//   effective scope = role ceiling ∩ agent definition's graphAccess declaration
//
// The role ceiling comes from the run's cached IAM resolution
// (`ctx.agentRun.resolution` → per-capability EffectivePermissions →
// `resourceScope.graph`); the declaration comes from `ctx.agentRun.graphAccess`
// (the deployed definition's graph block, threaded onto the run context by the
// run driver). The intersection itself is @oxagen/oxagen's exported
// `intersectGraphScope` — the same math the resolver uses for agent ∩ human ∩
// parent-run ceilings — so there is exactly one narrowing rule in the system.
//
// Every ontology.* / semantic.* / graph vector-search handler calls
// `effectiveGraphScope(ctx, contract.name)` once and passes the result to
// `scopedSession(scope)`. Human / API-key / service invocations carry no
// `ctx.agentRun`, return `undefined`, and remain byte-identical pass-throughs.

import type { CheckedContext } from "@oxagen/oxagen";
import { intersectGraphScope } from "@oxagen/oxagen/iam";
import type {
  GraphScope as IamGraphScope,
  EffectivePermissions,
} from "@oxagen/oxagen/iam";
import type { GraphAccess } from "@oxagen/oxagen/agent-schema";
import type { GraphScope } from "@oxagen/ontology/graph-scope";

/**
 * Map an agent definition's `graphAccess` declaration onto the GraphScope
 * shape the seam enforces.
 *
 * - `retrieval.scopeToTypes` is ONE list covering node labels AND relationship
 *   types ("Node/edge types the agent may traverse"), so it constrains both
 *   dimensions; a label name in the rel-type allowlist (or vice versa) is
 *   harmless — nothing matches it in the other dimension. Undefined/EMPTY ⇒
 *   all permitted types (the schema's documented semantics), i.e. the
 *   dimension is left unconstrained.
 * - `mode` always maps (the zod schema defaults it to "read", so a parsed
 *   declaration enforces read unless extend was granted deliberately).
 * - `budget.maxHops/maxNodes/maxTraversalMs` map 1:1; `minRelevance` is a
 *   retrieval-quality dial, not a GraphScope dimension, and is ignored here.
 */
export function declaredGraphScope(
  graphAccess: GraphAccess | undefined,
): IamGraphScope | undefined {
  if (graphAccess === undefined) return undefined;

  const scope: IamGraphScope = { mode: graphAccess.mode };

  const types = graphAccess.retrieval.scopeToTypes;
  if (types !== undefined && types.length > 0) {
    scope.labels = [...types];
    scope.relationshipTypes = [...types];
  }

  const { maxHops, maxNodes, maxTraversalMs } = graphAccess.budget;
  scope.budget = {
    maxHops,
    maxNodes,
    ...(maxTraversalMs !== undefined ? { maxTraversalMs } : {}),
  };

  return scope;
}

/**
 * Resolve the run's cached per-capability permissions. The kernel resolves the
 * invoked capability BEFORE the handler runs, so `byCapability` normally holds
 * the entry; if this exact capability is somehow absent, any cached entry is an
 * equivalent source of the ceiling — `resourceScope` is run-constant (it is
 * collected from the principals' grants/roles + the parent-run scope, none of
 * which vary per capability; see collectResourceScope in resolve.ts).
 */
function cachedPermissions(
  ctx: CheckedContext,
  capability: string,
): EffectivePermissions | undefined {
  const resolution = ctx.agentRun?.resolution;
  if (!resolution) return undefined;
  const exact = resolution.byCapability.get(capability);
  if (exact !== undefined) return exact;
  for (const entry of resolution.byCapability.values()) return entry;
  return undefined;
}

/**
 * Compute the effective GraphScope for this invocation.
 *
 * Returns `undefined` (⇒ scopedSession pass-through, byte-identical behavior)
 * when:
 *  - the context carries no agentRun (human / API-key / service call), or
 *  - the run is fully unrestricted on the graph dimension (no role ceiling and
 *    no declaration — e.g. a legacy agent with nothing declared): there is
 *    nothing to enforce, matching the spec's "enforced as declared" posture.
 *
 * Otherwise returns role-ceiling ∩ declaration. A missing side of the
 * intersection contributes no restriction — it can never widen the other side.
 */
export function effectiveGraphScope(
  ctx: CheckedContext,
  capability: string,
): GraphScope | undefined {
  const run = ctx.agentRun;
  if (!run) return undefined;

  const ceiling = cachedPermissions(ctx, capability)?.resourceScope.graph;
  const declared = declaredGraphScope(run.graphAccess);

  const effective = intersectGraphScope(ceiling, declared);
  if (effective === undefined) return undefined;
  if (
    effective.labels === undefined &&
    effective.relationshipTypes === undefined &&
    effective.mode === undefined &&
    (effective.budget === undefined ||
      Object.keys(effective.budget).length === 0)
  ) {
    return undefined;
  }
  // @oxagen/oxagen's GraphScope and @oxagen/ontology's GraphScope are kept
  // structurally identical by contract (see the note atop
  // packages/ontology/src/graph-scope.ts) — this is a plain structural
  // assignment, not a cast.
  return effective;
}

/**
 * Narrow a scope to its node-only dimensions for a query that matches NO
 * relationships (existence checks, start-node resolution, pure vector search).
 * The relationship-type allow-list is vacuously satisfied by such a query —
 * it can neither traverse nor return an out-of-scope relationship — but the
 * seam's bypass guard is textual and per-query, so passing the constrained
 * dimension would demand a marker the query has no genuine predicate for.
 * Labels, mode, and budget still bind in full.
 */
export function nodeOnlyGraphScope(
  scope: GraphScope | undefined,
): GraphScope | undefined {
  if (scope === undefined) return undefined;
  if (scope.relationshipTypes === undefined) return scope;
  const { relationshipTypes: _dropped, ...rest } = scope;
  return rest;
}
