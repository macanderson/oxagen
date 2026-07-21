// extend-proposal.ts — validation for agent extend-mode graph proposals
// (Agent RBAC Phase 3b, docs/specs/agent-rbac/spec.md §3.6 + §6 Q3 resolved).
//
// An agent granted `graphAccess.mode = "extend"` may PROPOSE new nodes/edges.
// Spec Q3 resolves that such proposals are validated at TWO gates:
//   (a) fail fast at PROPOSAL time against the label/relationship-type allow-list
//       (the direct extend-write capabilities — graph.node.upsert /
//       graph.edge.upsert — call assertProposalWithinScope before writing), and
//   (b) RE-VERIFY at APPROVAL time (semantic.edge.approve re-runs the allow-list
//       check before materialising the inferred edge), PLUS
//   (c) PROPERTY COMPLETENESS — a proposed inferred node/edge must populate the
//       full property schema its label/type declares in the ontology, so an
//       agent building inferred structure is forced to fill the complete schema;
//       an incomplete proposal is rejected with a typed error LISTING the missing
//       properties so the agent can retry complete.
//
// The vocabulary + completeness gates key off the workspace's pinned schema
// ENFORCEMENT MODE (the same switch the ingestion validator honours): only a
// `strict` workspace turns these into hard rejections — an unpinned or lenient
// workspace keeps today's behavior (advisory, no reject), so nothing regresses
// until a workspace opts into strict conformance. The scope allow-list gate
// (a/b) is unconditional whenever an agent GraphScope is active — it is the RBAC
// ceiling, not a schema-quality dial.
//
// Errors extend HTTPException(422) so the API surface maps them to a 4xx without
// a bespoke onError branch, while the structured `.code` / `.missingProperties`
// / `.allowed` fields ride on the instance for the agent runtime to read and act
// on (retry with a complete, in-scope proposal).

import { HTTPException } from "hono/http-exception";
import {
  validateNodeAgainstSchema,
  validateRelationshipAgainstSchema,
  type PinnedSchema,
} from "@oxagen/ingestion/validate";
import type { GraphScope } from "@oxagen/ontology/graph-scope";

const HTTP_UNPROCESSABLE = 422 as const;

/**
 * A proposed label / relationship-type is outside the allow-list (agent
 * GraphScope ceiling, or the workspace's active-vocabulary under strict
 * enforcement), or the scope is read-only and cannot propose at all.
 */
export class ExtendProposalScopeError extends HTTPException {
  readonly code = "extend_proposal_out_of_scope" as const;
  readonly dimension: "label" | "relationshipType" | "mode";
  readonly value: string;
  readonly allowed: readonly string[] | null;

  constructor(
    dimension: "label" | "relationshipType" | "mode",
    value: string,
    allowed: readonly string[] | null,
    message: string,
  ) {
    super(HTTP_UNPROCESSABLE, { message });
    this.name = "ExtendProposalScopeError";
    this.dimension = dimension;
    this.value = value;
    this.allowed = allowed;
  }
}

/**
 * A proposed node/edge does not populate every REQUIRED property its label /
 * relationship-type declares in the ontology schema. `missingProperties` is the
 * exact set the agent must fill in and retry.
 */
export class PropertyCompletenessError extends HTTPException {
  readonly code = "extend_proposal_incomplete_properties" as const;
  readonly targetKind: "node" | "relationship";
  readonly label: string;
  readonly missingProperties: readonly string[];

  constructor(
    targetKind: "node" | "relationship",
    label: string,
    missingProperties: readonly string[],
  ) {
    const plural = missingProperties.length === 1 ? "property" : "properties";
    super(HTTP_UNPROCESSABLE, {
      message:
        `Proposed ${targetKind} "${label}" is missing required ${plural}: ` +
        `${missingProperties.join(", ")}. Populate the full property schema and retry.`,
    });
    this.name = "PropertyCompletenessError";
    this.targetKind = targetKind;
    this.label = label;
    this.missingProperties = missingProperties;
  }
}

export interface ProposalTarget {
  /** Proposed node label (the target label of an inferred node/edge). */
  label: string;
  /** Proposed relationship type; omit/null for a bare node proposal. */
  relationshipType?: string | null;
}

/**
 * (a)/(b) Fail fast / re-verify: a proposed label/relationship-type must be
 * within the agent's effective GraphScope allow-list, and a read-mode scope may
 * not propose new structure at all. No-op when no agent scope is active (human /
 * legacy / API-key proposals are unaffected).
 */
export function assertProposalWithinScope(
  target: ProposalTarget,
  scope: GraphScope | undefined,
): void {
  if (scope === undefined) return;

  if (scope.mode === "read") {
    throw new ExtendProposalScopeError(
      "mode",
      "extend",
      ["read"],
      "A read-mode graph scope cannot propose new nodes or edges (extend not granted).",
    );
  }

  if (scope.labels !== undefined && !scope.labels.includes(target.label)) {
    throw new ExtendProposalScopeError(
      "label",
      target.label,
      scope.labels,
      `Proposed node label "${target.label}" is outside the agent's graph scope. ` +
        `Allowed labels: ${scope.labels.length > 0 ? scope.labels.join(", ") : "(none)"}.`,
    );
  }

  const rel = target.relationshipType ?? undefined;
  if (
    rel !== undefined &&
    scope.relationshipTypes !== undefined &&
    !scope.relationshipTypes.includes(rel)
  ) {
    throw new ExtendProposalScopeError(
      "relationshipType",
      rel,
      scope.relationshipTypes,
      `Proposed relationship type "${rel}" is outside the agent's graph scope. ` +
        `Allowed types: ${scope.relationshipTypes.length > 0 ? scope.relationshipTypes.join(", ") : "(none)"}.`,
    );
  }
}

/**
 * (b) Re-verify against the workspace's active-vocabulary allow-list. Enforced
 * as a hard reject ONLY under `strict` schema enforcement; unpinned / lenient /
 * off workspaces are unaffected (registry inert or advisory). An empty label /
 * rel set means the vocabulary places no constraint on that dimension.
 */
export function assertProposalInVocabulary(
  target: ProposalTarget,
  pinnedSchema: PinnedSchema | null,
): void {
  if (!pinnedSchema || pinnedSchema.enforcementMode !== "strict") return;

  const labelNames = pinnedSchema.labels.map((l) => l.name);
  if (labelNames.length > 0 && !labelNames.includes(target.label)) {
    throw new ExtendProposalScopeError(
      "label",
      target.label,
      labelNames,
      `Proposed node label "${target.label}" is not in the workspace's active schema vocabulary.`,
    );
  }

  const rel = target.relationshipType ?? undefined;
  if (rel !== undefined) {
    const relNames = pinnedSchema.relationshipTypes.map((r) => r.name);
    if (relNames.length > 0 && !relNames.includes(rel)) {
      throw new ExtendProposalScopeError(
        "relationshipType",
        rel,
        relNames,
        `Proposed relationship type "${rel}" is not in the workspace's active schema vocabulary.`,
      );
    }
  }
}

export interface ProposalProperties {
  /** Target node label the properties are validated against. */
  label: string;
  /** Proposed target-node property bag. */
  properties: Record<string, unknown>;
  /** Proposed relationship type (validates its property bag when present). */
  relationshipType?: string | null;
  /** Proposed relationship property bag. */
  relationshipProperties?: Record<string, unknown>;
  /** Endpoint labels for relationship start/end-constraint validation. */
  startLabel?: string;
  endLabel?: string;
}

/**
 * (c) Property completeness: under `strict` enforcement a proposed node/edge
 * must populate every REQUIRED property its label / relationship-type declares
 * in the ontology schema. Reuses the ingestion validator's `missingRequired`
 * computation so proposal completeness and ingestion conformance can never
 * diverge. Throws a typed error listing the missing keys; no-op when unpinned /
 * lenient (behaviour-preserving).
 */
export function assertProposalComplete(
  proposal: ProposalProperties,
  pinnedSchema: PinnedSchema | null,
): void {
  if (!pinnedSchema || pinnedSchema.enforcementMode !== "strict") return;

  const nodeResult = validateNodeAgainstSchema(
    { label: proposal.label, properties: proposal.properties },
    pinnedSchema,
  );
  if (nodeResult.missingRequired.length > 0) {
    throw new PropertyCompletenessError(
      "node",
      proposal.label,
      nodeResult.missingRequired,
    );
  }

  const rel = proposal.relationshipType ?? undefined;
  if (rel !== undefined) {
    const relResult = validateRelationshipAgainstSchema(
      {
        type: rel,
        startLabel: proposal.startLabel,
        endLabel: proposal.endLabel,
        properties: proposal.relationshipProperties ?? {},
      },
      pinnedSchema,
    );
    if (relResult.missingRequired.length > 0) {
      throw new PropertyCompletenessError(
        "relationship",
        rel,
        relResult.missingRequired,
      );
    }
  }
}
