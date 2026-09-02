/**
 * `oxagen lineage show <dispatchId>` — CLI parity surface for `query_lineage`,
 * the fleet-lineage explorer's data spine. Fetches the
 * dispatch tree rooted at one `agent.subagent_fanouts` row over the org-scoped
 * API (GET /lineage/query/:dispatchId) and renders it as an indented tree:
 * every subagent run reachable from the root, each carrying its principal,
 * spend, model/provider, and derived outcome — with any delegation-ceiling
 * denial visibly flagged.
 *
 * Output discipline (ADR-023 §4): `--json` (or a piped stdout) emits the exact
 * contract payload as one line; pretty mode renders the tree. The CLI talks to
 * the API over HTTP and does not depend on @oxagen/oxagen, so the response
 * shape is mirrored locally here (kept in sync with
 * packages/oxagen/src/contracts/lineage.query.ts).
 */
import { apiGetOrThrow, ApiError } from "../lib/api.js";
import { formatUsd } from "../agent/rate-card.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Local mirror of the lineage.query contract output ───────────────────────

export interface LineagePrincipalRef {
  id: string | null;
  kind: "human" | "agent" | "service" | null;
  displayName: string;
}

export interface LineageDelegationCeiling {
  principalId: string;
  displayName: string;
}

export interface LineageSpend {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
}

export interface LineageDelegationViolation {
  ruleId: string;
  message: string;
}

export type LineageOutcome =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface LineageNode {
  runId: string;
  fanoutId: string;
  parentRunId: string | null;
  childFanoutId: string | null;
  depth: number;
  capabilityName: string;
  outcome: LineageOutcome;
  attempts: number;
  principal: LineagePrincipalRef;
  delegationCeiling: LineageDelegationCeiling | null;
  model: string | null;
  provider: string | null;
  spend: LineageSpend;
  delegationViolation: LineageDelegationViolation | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface LineageQueryOutput {
  dispatchId: string;
  rootStatus: "pending" | "running" | "completed" | "partial" | "timed_out";
  totalChildren: number;
  completedChildren: number;
  createdAt: string;
  updatedAt: string;
  nodes: LineageNode[];
  nodeCount: number;
  truncated: boolean;
  maxDepthReached: boolean;
}

export interface LineageShowOptions {
  maxDepth?: string;
  maxNodes?: string;
  json?: boolean;
  /** Override stdout TTY detection (tests). */
  stdoutIsTTY?: boolean;
}

function statusMark(status: LineageOutcome): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
    case "cancelled":
      return "✗";
    case "running":
      return "◷";
    default:
      return "•";
  }
}

function principalCell(node: LineageNode): string {
  const { principal, delegationCeiling } = node;
  const kind = principal.kind ? ` (${principal.kind})` : "";
  const ceiling = delegationCeiling
    ? ` [ceiling: ${delegationCeiling.displayName}]`
    : "";
  return `${principal.displayName}${kind}${ceiling}`;
}

function modelCell(node: LineageNode): string {
  if (!node.model) return "—";
  return node.provider ? `${node.provider}/${node.model}` : node.model;
}

/** Group the flat adjacency list by `parentRunId` (root depth-0 nodes key on `null`). */
function groupByParent(
  nodes: LineageNode[],
): Map<string | null, LineageNode[]> {
  const map = new Map<string | null, LineageNode[]>();
  for (const node of nodes) {
    const list = map.get(node.parentRunId) ?? [];
    list.push(node);
    map.set(node.parentRunId, list);
  }
  return map;
}

/**
 * Render one node and its subtree. `seen` carries the runIds already rendered
 * on the current path: the adjacency list is server-supplied, so a malformed
 * tree (a self-parent, or a parent/child cycle) must terminate with a marker
 * rather than recurse until the stack overflows.
 */
function renderNode(
  node: LineageNode,
  indent: string,
  byParent: Map<string | null, LineageNode[]>,
  out: string[],
  seen: ReadonlySet<string> = new Set(),
): void {
  if (seen.has(node.runId)) {
    out.push(
      `${indent}↺ ${node.capabilityName} (${node.runId}) — cycle, not expanded`,
    );
    return;
  }
  const violation = node.delegationViolation
    ? ` ⚠ DELEGATION VIOLATION (${node.delegationViolation.ruleId})`
    : "";
  out.push(
    `${indent}${statusMark(node.outcome)} ${node.capabilityName} ` +
      `[depth ${node.depth}] ${node.outcome} ${formatUsd(node.spend.costUsd)} ` +
      `${modelCell(node)} — ${principalCell(node)}${violation}`,
  );
  const path = new Set(seen).add(node.runId);
  for (const child of byParent.get(node.runId) ?? []) {
    renderNode(child, `${indent}  `, byParent, out, path);
  }
}

function renderLineageTree(
  result: LineageQueryOutput,
  writer: CommandWriter,
): void {
  writer.write(
    `Dispatch ${result.dispatchId} — root fan-out ${result.rootStatus} ` +
      `(${result.completedChildren}/${result.totalChildren} direct children completed)`,
  );
  const truncatedNote = result.truncated ? " (truncated)" : "";
  writer.write(`Nodes: ${result.nodeCount}${truncatedNote}`);
  writer.write("");

  if (result.nodes.length === 0) {
    writer.write("(no runs in this dispatch tree)");
    return;
  }

  const byParent = groupByParent(result.nodes);
  const out: string[] = [];
  for (const root of byParent.get(null) ?? []) {
    renderNode(root, "", byParent, out);
  }
  writer.write(out.join("\n"));

  if (result.maxDepthReached) {
    writer.write("");
    writer.write(
      "⚠ Reached --max-depth with deeper subtrees still present — re-query " +
        "with a higher --max-depth, or use a deepest node's childFanoutId as " +
        "the next --dispatch-id.",
    );
  }

  const violations = result.nodes.filter((n) => n.delegationViolation !== null);
  if (violations.length > 0) {
    writer.write("");
    writer.write("⚠ Delegation violations:");
    for (const node of violations) {
      writer.write(
        `  ${node.capabilityName} (${node.runId}) — ${node.delegationViolation?.message}`,
      );
    }
  }
}

export async function lineageShow(
  dispatchId: string,
  opts: LineageShowOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput(
    {
      json: opts.json,
      autoJson: true,
      // One TTY truth: the injected override must steer autoJson AND the
      // pretty-mode render below, or a test/caller can land in a mode split.
      ...(opts.stdoutIsTTY !== undefined
        ? { stdoutIsTTY: opts.stdoutIsTTY }
        : {}),
    },
    writer,
  );

  let result: LineageQueryOutput;
  try {
    result = await apiGetOrThrow<LineageQueryOutput>(
      `lineage/query/${encodeURIComponent(dispatchId)}`,
      {
        maxDepth:
          opts.maxDepth !== undefined ? Number(opts.maxDepth) : undefined,
        maxNodes:
          opts.maxNodes !== undefined ? Number(opts.maxNodes) : undefined,
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      out.error(`Dispatch not found: ${dispatchId}`, "not_found");
    } else {
      out.error(err, "api");
    }
    return;
  }

  if (out.isJson) {
    out.data(result);
    return;
  }

  renderLineageTree(result, writer);
}
