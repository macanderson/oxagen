/**
 * lib/lineage/node-ref.ts — pure mapper from `LineageNodeDto` (query_lineage's
 * flat adjacency-list row) to `KnowledgeNodeRef`, the one shape `NodeRef`
 * (@/components/knowledge/graph/node-ref) knows how to cite.
 *
 * A lineage run is never a knowledge-graph node, but the same "never a raw
 * UUID as the primary on-screen identifier" rule applies — see CLAUDE.md's
 * "Citing nodes & edges in the UI" and the issue's acceptance criteria.
 * `displayName` is keyed on a human label (capability name + principal
 * display name); the raw `runId` lives only inside the inspectable property
 * bag (and a copyable id NodeRef renders from `node.id`).
 */
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";

/** `lineageNodeRef(node).label` — used to colour-code the NodeRef chip dot by
 *  capability (matches the "domain label" role `label` plays for graph nodes). */
export function lineageNodeRef(node: LineageNodeDto): KnowledgeNodeRef {
  const properties: Record<string, unknown> = {
    outcome: node.outcome,
    depth: node.depth,
    attempts: node.attempts,
    fanoutId: node.fanoutId,
    spendUsd: node.spend.costUsd,
    inputTokens: node.spend.inputTokens,
    outputTokens: node.spend.outputTokens,
    llmCalls: node.spend.llmCalls,
  };
  if (node.parentRunId) properties.parentRunId = node.parentRunId;
  if (node.childFanoutId) properties.childFanoutId = node.childFanoutId;
  if (node.model) properties.model = node.model;
  if (node.provider) properties.provider = node.provider;
  if (node.principal.kind) properties.principalKind = node.principal.kind;
  if (node.delegationCeiling) {
    properties.delegationCeilingPrincipal = node.delegationCeiling.displayName;
  }
  if (node.delegationViolation) {
    properties.delegationViolationRule = node.delegationViolation.ruleId;
    properties.delegationViolationMessage = node.delegationViolation.message;
  }
  if (node.startedAt) properties.startedAt = node.startedAt;
  if (node.completedAt) properties.completedAt = node.completedAt;
  if (node.durationMs !== null) properties.durationMs = node.durationMs;

  return {
    id: node.runId,
    label: node.capabilityName,
    displayName: `${node.capabilityName} · ${node.principal.displayName}`,
    properties,
  };
}
