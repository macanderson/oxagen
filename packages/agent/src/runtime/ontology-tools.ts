/**
 * The ontology read set — the capabilities an agent asks the business graph
 * with, declared in one place instead of inferred from a surfaces array.
 *
 * ## Why this exists when the tools already reach the model
 *
 * `materializeTools` materializes every capability whose `surfaces` include
 * `"agent"`, and the graph reads are among them, so a chat or durable turn
 * already carries them. Censused against the shipped registry on 2026-08-31:
 * 271 of 340 registered capabilities carry the agent surface, and all eight
 * below are among them. The count is dated because it drifts; the guarantee
 * lives in `ontology-tools.test.ts`, not in this sentence.
 *
 * What that does not buy is the guarantee. The set is named nowhere, so
 * dropping `"agent"` from one contract removes an agent's ability to traverse
 * the graph with nothing failing, and a run that narrows itself with
 * `toolPolicy.allowlist` loses the set entirely unless its enqueuer happened
 * to spell all eight names.
 *
 * So the set is declared here, held read-only by
 * {@link assertOntologyReadOnly}, and unioned into a narrowed run's allowlist
 * by {@link withOntologyReads}.
 *
 * ## The mechanism is the existing one, not a second one
 *
 * These reach the model exactly the way `get_execution_trace` does — a plain
 * `registerCapability` carrying `"agent"` in `surfaces`, picked up by
 * `materializeTools`. Nothing here adds a delivery path: {@link
 * withOntologyReads} widens the allowlist of the one materialization a caller
 * already performs.
 *
 * That has a consequence for anything reasoning about an agent's tool set.
 * These are not workspace tools, so a check shaped like "every tool the prompt
 * names is in `buildWorkspaceTools`" false-positives on them, exactly as it
 * does on `get_execution_trace`. The correct set is workspace tools UNION
 * materialized capabilities.
 *
 * ## What this deliberately does not do
 *
 * It does not open a second path to the graph. There is no Neo4j driver here,
 * no `@oxagen/ontology` import, and no handler call — these are capability
 * *names*, and the only thing that turns one into an answer is the existing
 * `materializeTools` -> `invoke()` path, where IAM, billing admission, the
 * entitlement gate, the decision-rules gate and `runInTenantScope` all run.
 * Narrowing the allowlist a run already passes is the whole mechanism, which
 * is what keeps every gate on the call and adds no enforcement point to audit.
 */
import { isMutatingCapability } from "./materialize-tools";
import type { RegistryCapability } from "../registry-loader";

/**
 * The graph reads an agent reasons over, by registered capability name
 * (verb-first snake_case, ADR-025 — not the older dotted contract filenames).
 *
 * Traversal first, then node lookup, then schema. An agent that only has
 * `query_ontology` cannot use it: that capability requires a `startNodeId` it
 * must find with `search_graph` or `search_nodes` first, which is why the
 * lookup half is part of the same set rather than a separate opt-in.
 */
export const ONTOLOGY_READ_CAPABILITIES = Object.freeze([
  // Traversal.
  "query_ontology",
  "get_ontology_neighbors",
  // Lookup — how an agent gets the node id traversal needs.
  "search_graph",
  "search_nodes",
  "get_node",
  "list_nodes",
  // Schema, so an agent can name real labels and relationship types.
  "get_node_labels",
  "get_graph_stats",
] as const);

export type OntologyReadCapability =
  (typeof ONTOLOGY_READ_CAPABILITIES)[number];

const ONTOLOGY_READ_SET: ReadonlySet<string> = new Set(
  ONTOLOGY_READ_CAPABILITIES,
);

/**
 * Leading verbs that read. A registered name is verb-first snake_case, so its
 * first segment is the whole question.
 *
 * An allowlist rather than a denylist of mutating verbs: a verb nobody
 * anticipated must fail this check, and a denylist is the shape that lets one
 * through. The other rules read the contract's own metadata and this reads its
 * name, because a capability that writes while declaring `mutates: false` and
 * a low risk grade passes both of those and fails this one.
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  "get",
  "list",
  "search",
  "query",
  "read",
  "describe",
  "count",
]);

/** Why a capability is not admissible to the ontology read set. */
export interface OntologyReadViolation {
  capability: string;
  reason: string;
}

/**
 * Is this capability DANGEROUS — a separate question from whether it writes.
 *
 * These three fields grade blast radius. Until #2600 they were also standing
 * in for "does this mutate", and that conflation was the bug: a cheap,
 * low-risk, approval-free write was invisible to them. `capabilityMutates`
 * answers the mutation question now, from a field that means it.
 *
 * So this is not the old check surviving under a new name. It asks a
 * different question, and this set wants both answers because it is
 * **auto-granted**: `toolPolicy.ontology: true` unions these eight into a
 * narrowed run's allowlist without the enqueuer naming a single one. A set
 * handed out that way must exclude dangerous capabilities whatever their
 * mutation bit claims — and one declaring destructive sensitivity *and*
 * `mutates: false` is contradicting itself, which for an auto-granted set has
 * to fail closed rather than be believed.
 *
 * Costs nothing in practice: no legitimate graph read is high-risk.
 */
function isRiskShaped(cap: RegistryCapability): boolean {
  return (
    cap.sensitivity === "destructive" ||
    cap.agent?.riskLevel === "high" ||
    cap.agent?.requiresApproval === true
  );
}

/**
 * Judge one capability against the admission rules for the auto-granted set.
 *
 * Four independent questions, each able to reject on its own: is it still
 * registered, does it write, is it dangerous, and does its name read like a
 * write. Returns `null` when it may be in the set.
 *
 * `capability` being `undefined` is a violation rather than a skip: an
 * unregistered name in this list is a graph read an agent silently lost, and
 * silence is the failure this module exists to prevent.
 */
export function ontologyReadViolation(
  name: string,
  capability: RegistryCapability | undefined,
): OntologyReadViolation | null {
  if (capability === undefined) {
    return {
      capability: name,
      reason:
        "not registered — the contract was renamed or removed, and every " +
        "agent silently lost this graph read",
    };
  }
  if (isMutatingCapability(capability)) {
    return {
      capability: name,
      reason:
        "does not declare `mutates: false` — the ontology set is read-only, " +
        "and a capability that declares nothing is treated as writing",
    };
  }
  if (isRiskShaped(capability)) {
    return {
      capability: name,
      reason:
        "is risk-shaped (destructive sensitivity, high agent risk, or " +
        "requiresApproval) — this set is auto-granted, so a dangerous " +
        "capability is refused whatever its mutates bit says",
    };
  }
  const verb = name.split("_")[0] ?? "";
  if (!READ_VERBS.has(verb)) {
    return {
      capability: name,
      reason:
        `leads with "${verb}", which is not a read verb ` +
        `(${[...READ_VERBS].join(", ")}) — the ontology set is read-only`,
    };
  }
  return null;
}

/**
 * Every violation in {@link ONTOLOGY_READ_CAPABILITIES}, given a way to look a
 * capability up. Empty means the set is admissible.
 *
 * Takes a lookup rather than reading the registry itself so the rule is a pure
 * function a test can drive with a fixture, and so the caller decides whether
 * loading the registry is worth it.
 */
export function ontologyReadViolations(
  lookup: (name: string) => RegistryCapability | undefined,
): OntologyReadViolation[] {
  const violations: OntologyReadViolation[] = [];
  for (const name of ONTOLOGY_READ_CAPABILITIES) {
    const violation = ontologyReadViolation(name, lookup(name));
    if (violation) violations.push(violation);
  }
  return violations;
}

/** Raised when the declared ontology set is no longer read-only. */
export class OntologyReadSetError extends Error {
  constructor(readonly violations: readonly OntologyReadViolation[]) {
    super(
      "the ontology read set is not read-only: " +
        violations.map((v) => `${v.capability} ${v.reason}`).join("; "),
    );
    this.name = "OntologyReadSetError";
  }
}

/** Throw {@link OntologyReadSetError} unless every declared name still reads. */
export function assertOntologyReadOnly(
  lookup: (name: string) => RegistryCapability | undefined,
): void {
  const violations = ontologyReadViolations(lookup);
  if (violations.length > 0) throw new OntologyReadSetError(violations);
}

/** True for a capability an agent may use to read the ontology. */
export function isOntologyReadCapability(name: string): boolean {
  return ONTOLOGY_READ_SET.has(name);
}

/**
 * Union the ontology reads into a run's declared tool allowlist.
 *
 * `undefined` in, `undefined` out: a run that narrows nothing already
 * materializes every agent-surface capability, and the graph reads are among
 * them — widening an absent allowlist into a concrete one would *narrow* that
 * run to eight tools, which is the opposite of what asking for the ontology
 * means.
 *
 * `enabled: false` returns the caller's own set unchanged rather than a copy
 * of it, so the no-op path allocates nothing and a run that did not ask keeps
 * exactly the tools it declared.
 */
export function withOntologyReads(
  allowlist: ReadonlySet<string> | undefined,
  enabled: boolean,
): ReadonlySet<string> | undefined {
  if (allowlist === undefined) return undefined;
  if (!enabled) return allowlist;
  return new Set<string>([...allowlist, ...ONTOLOGY_READ_CAPABILITIES]);
}
