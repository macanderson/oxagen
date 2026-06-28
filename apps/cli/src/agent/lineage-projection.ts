/**
 * lineage-projection.ts — Project a CLI TurnTrace into a graph.sync.push envelope.
 *
 * Implements ADR-018 slice 3: each CLI session produces a lineage subgraph in the
 * platform's Neo4j workspace graph.  Nodes are content-addressed so re-pushing the
 * same trace is a safe no-op.
 *
 * ## Lineage node/edge model
 *
 * Nodes (all `is_system = true`):
 *   • `lineage:session:{sessionKey}`   → [:AgentSession]  — one per project/cwd
 *   • `lineage:turn:{turnId}`          → [:AgentTurn]     — one per TurnTrace
 *   • `lineage:tool:{turnId}:{idx}`    → [:AgentToolCall] — one per ToolEvent (verbose turns)
 *   • `lineage:model:{slug}`           → [:AIModel]       — shared model nodes
 *   • `code:{repo}:{path}`             → [:SourceFile]    — link to the code subgraph
 *                                                           (same key scheme as graph.push)
 *
 * Edges:
 *   • (AgentSession) -[:HAS_TURN]->    (AgentTurn)
 *   • (AgentTurn)    -[:USED_MODEL]->  (AIModel)
 *   • (AgentTurn)    -[:TOUCHED_FILE]→ (SourceFile)   — from TurnTrace.filesTouched
 *   • (AgentTurn)    -[:USED_TOOL]->   (AgentToolCall)
 *
 * Storage boundary:
 *   Lineage subgraph → Neo4j (is_system=true) via graph.sync.push.
 *   Raw per-turn token/cost events → ClickHouse (follow-up: no CLI-accessible
 *   contract exists today; documented in PR body).
 *
 * Tenant isolation:
 *   The push envelope is sent via graph.sync.push which MERGE-filters on
 *   orgId + workspaceId server-side.  Nothing here is tenant-specific.
 */
import { basename } from "node:path";
import type { TurnTrace } from "./trace.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LineageNode {
  key: string;
  labels: string[];
  displayName: string;
  properties: Record<string, unknown>;
  isSystem: true;
}

export interface LineageEdge {
  sourceKey: string;
  targetKey: string;
  type: string;
  properties?: Record<string, unknown>;
  inferred?: boolean;
}

export interface LineageEnvelope {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface ProjectLineageOptions {
  /**
   * The stable content-addressed repo identifier used by graph.push
   * (e.g. the git remote origin URL or a path hash).  Used to derive
   * `code:{repo}:{path}` file-node keys that link to the code subgraph.
   * When absent, no SourceFile nodes or TOUCHED_FILE edges are emitted.
   */
  repo?: string;
  /**
   * Human-readable session key for grouping turns.  Defaults to the
   * project directory name derived from trace.cwd.
   */
  sessionKey?: string;
}

// ---------------------------------------------------------------------------
// Key builders — stable content-addressed identifiers
// ---------------------------------------------------------------------------

/** Key for the session (project) node. */
export function sessionNodeKey(sessionKey: string): string {
  return `lineage:session:${sessionKey}`;
}

/** Key for a turn node. */
export function turnNodeKey(turnId: string): string {
  return `lineage:turn:${turnId}`;
}

/** Key for a tool-event node (index is position within the trace's toolEvents). */
export function toolNodeKey(turnId: string, idx: number): string {
  return `lineage:tool:${turnId}:${idx}`;
}

/** Key for a model node (shared across turns). */
export function modelNodeKey(slug: string): string {
  return `lineage:model:${slug}`;
}

/** Key for a source-file node — matches the code-push scheme so edges cross graphs. */
export function fileNodeKey(repo: string, relativePath: string): string {
  return `code:${repo}:${relativePath}`;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project a single TurnTrace into the lineage node/edge sets that make up its
 * contribution to the workspace knowledge graph.
 *
 * Pure: no I/O, no side effects.  Easily testable.
 */
export function projectTrace(
  trace: TurnTrace,
  opts: ProjectLineageOptions = {},
): LineageEnvelope {
  const sessionKey =
    opts.sessionKey ??
    (trace.cwd ? basename(trace.cwd) || "default" : "default");

  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];

  // Track keys we have already emitted to avoid duplicate node entries when
  // multiple traces share a model or touch the same file.
  const emittedKeys = new Set<string>();

  function pushNode(n: LineageNode): void {
    if (!emittedKeys.has(n.key)) {
      emittedKeys.add(n.key);
      nodes.push(n);
    }
  }

  // ── Session node ──────────────────────────────────────────────────────────
  const sKey = sessionNodeKey(sessionKey);
  pushNode({
    key: sKey,
    labels: ["AgentSession"],
    displayName: sessionKey,
    properties: { cwd: trace.cwd ?? "" },
    isSystem: true,
  });

  // ── Turn node ─────────────────────────────────────────────────────────────
  const tKey = turnNodeKey(trace.id);
  pushNode({
    key: tKey,
    labels: ["AgentTurn"],
    displayName: `Turn ${trace.id.slice(0, 8)}`,
    properties: {
      turnId: trace.id,
      createdAt: trace.createdAt,
      originalPrompt: trace.originalPrompt.slice(0, 500),
      selectedModel: trace.selectedModel,
      selectedTier: trace.selectedTier,
      inputTokens: trace.usage.inputTokens ?? 0,
      outputTokens: trace.usage.outputTokens ?? 0,
      totalTokens: trace.usage.inputTokens + trace.usage.outputTokens,
      costUsd: trace.usage.costUsd,
      durationMs: trace.durationMs,
      finalComplete: trace.finalComplete,
      steps: trace.steps,
    },
    isSystem: true,
  });

  // Session → Turn
  edges.push({ sourceKey: sKey, targetKey: tKey, type: "HAS_TURN" });

  // ── Model node ────────────────────────────────────────────────────────────
  if (trace.selectedModel) {
    const mKey = modelNodeKey(trace.selectedModel);
    pushNode({
      key: mKey,
      labels: ["AIModel"],
      displayName: trace.selectedModel,
      properties: { slug: trace.selectedModel, tier: trace.selectedTier },
      isSystem: true,
    });
    edges.push({ sourceKey: tKey, targetKey: mKey, type: "USED_MODEL" });
  }

  // ── File nodes (links to the code subgraph) ───────────────────────────────
  if (opts.repo && trace.filesTouched.length > 0) {
    for (const relativePath of trace.filesTouched) {
      if (!relativePath) continue;
      const fKey = fileNodeKey(opts.repo, relativePath);
      pushNode({
        key: fKey,
        labels: ["SourceFile"],
        displayName: basename(relativePath),
        properties: { path: relativePath },
        isSystem: true,
      });
      edges.push({ sourceKey: tKey, targetKey: fKey, type: "TOUCHED_FILE" });
    }
  }

  // ── Tool-event nodes (verbose turns only) ─────────────────────────────────
  const toolEvents = trace.toolEvents ?? [];
  for (let idx = 0; idx < toolEvents.length; idx++) {
    const te = toolEvents[idx]!;
    const teKey = toolNodeKey(trace.id, idx);
    pushNode({
      key: teKey,
      labels: ["AgentToolCall"],
      displayName: te.name,
      properties: {
        name: te.name,
        durationMs: te.durationMs,
        ok: te.ok,
        // input is already truncated by the loop — safe to store
        input: te.input,
      },
      isSystem: true,
    });
    edges.push({ sourceKey: tKey, targetKey: teKey, type: "USED_TOOL" });
  }

  return { nodes, edges };
}

/**
 * Merge the envelopes from multiple traces into a single combined envelope.
 * Deduplicates nodes by key (first occurrence wins — all occurrences carry the
 * same data since we're projecting the same trace set).
 */
export function mergeEnvelopes(envelopes: LineageEnvelope[]): LineageEnvelope {
  const nodeMap = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];

  for (const env of envelopes) {
    for (const n of env.nodes) {
      if (!nodeMap.has(n.key)) nodeMap.set(n.key, n);
    }
    edges.push(...env.edges);
  }

  return { nodes: Array.from(nodeMap.values()), edges };
}
