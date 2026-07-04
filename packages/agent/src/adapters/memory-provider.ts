/**
 * Platform MemoryProvider — connects the agent engine's episodic memory port
 * to Neo4j (recallMemories / writeMemory) + @oxagen/ai embedText.
 *
 * All methods are best-effort and non-fatal: failures are caught and logged
 * (or silently swallowed for fire-and-forget paths) so a transient Neo4j
 * hiccup never terminates a coding run.
 *
 * Must be called from within an active tenant scope (set by the kernel's
 * runInTenantScope before the handler fires).
 */
import pino from "pino";
import {
  recallMemories,
  recallPeerResults,
  writeMemory,
  recordExecution,
  recordCitation,
} from "../memory/neo4j";
import { deriveCompliance } from "@oxagen/oxagen/contracts/agent.memory.model";
import { insertEvents } from "@oxagen/telemetry";
import { embedText } from "../memory/embed";
import type { MemoryProvider } from "@oxagen/agent-engine";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "agent.memory-adapter" } });

/**
 * Record a memory-recall failure as an append-only ClickHouse `events` row so
 * platform-wide memory loss (a down Neo4j / embedder) is VISIBLE in analytics,
 * not just swallowed. Fully guarded and fire-and-forget — telemetry must never
 * add a second failure mode to recall.
 */
async function emitRecallFailure(
  telemetry: MemoryAdapterTelemetry,
  err: unknown,
): Promise<void> {
  try {
    await insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: telemetry.orgId,
        workspace_id: telemetry.workspaceId,
        event_type: "agent.memory.recall_failed",
        source_system: "agent.memory-adapter",
        stream_offset: null,
        payload: JSON.stringify({
          surface: telemetry.surface,
          error: err instanceof Error ? err.message : String(err),
        }),
        emitted_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // ClickHouse may itself be degraded — the logger.error above is the floor.
  }
}

export interface MemoryAdapterTelemetry {
  orgId: string;
  workspaceId: string;
  /** Must be a valid UUID or null (flows into token_usage.execution_step_id). */
  messageId: string | null;
  surface: "api" | "mcp" | "app" | "runner" | "agent" | "ingestion" | "";
}

export interface MemoryAdapterArgs {
  /** The text to embed when recalling context. */
  recallQuery: string;
  telemetry: MemoryAdapterTelemetry;
}

export function createPlatformMemoryProvider(args: MemoryAdapterArgs): MemoryProvider {
  return {
    async recallContext(): Promise<string> {
      // Recall must NEVER kill the turn — but a swallowed failure here means the
      // agent silently runs with NO recalled memory, and if the memory store is
      // down that is a PLATFORM-WIDE loss. So make it loud: log at error AND emit
      // an append-only telemetry event, then degrade to empty context. (The
      // engine's own recall catch also routes to its onError sink; this is the
      // authoritative loud path because only here do we have tenant context.)
      try {
        const emb = await embedText(args.recallQuery, {
          telemetry: {
            orgId: args.telemetry.orgId,
            workspaceId: args.telemetry.workspaceId,
            surface: args.telemetry.surface,
            executionStepId: args.telemetry.messageId,
          },
        });
        // No memoryClass/minEnforcement filter — coding-turn recall wants the
        // broadest context (OBSERVATION through FACT), the same "recall
        // everything above threshold" intent the old minWeight:"low" filter had.
        const rows = await recallMemories({
          embedding: emb,
          limit: 8,
          recallThreshold: 0.7,
        });

        // Tier B semantic peer recall (docs/specs/graph-mediated-fanout-phase2
        // §3): also embed-search sibling/prior :Execution result summaries and
        // append them below the memory lines. Strictly additive and best-effort —
        // any failure degrades to zero peer lines and never blocks or fails the
        // memory recall above. Capped at 4 (spec) to stay within the recall
        // budget, same 0.7 threshold as memories. Peer rows are NOT auto-cited:
        // the citation/execution flow below is for memories only.
        const peers = await recallPeerResults({
          embedding: emb,
          limit: 4,
          recallThreshold: 0.7,
        }).catch(() => []);

        if (rows.length === 0 && peers.length === 0) return "";

        // Auto-record the turn as an :Execution and cite every memory it surfaced
        // (CONSIDERED). This builds the citation pressure that promotes recurring
        // observations to rules. Best-effort and fire-and-forget: a Neo4j hiccup
        // must never terminate a coding run. Keyed on the turn's messageId so all
        // of a turn's citations group under one execution.
        const executionRef = args.telemetry.messageId;
        if (executionRef && rows.length > 0) {
          void (async () => {
            try {
              const { executionId } = await recordExecution({
                executionRef,
                agentId: "coding-agent",
                taskSummary: args.recallQuery.slice(0, 500),
              });
              await Promise.all(
                rows.map((r) =>
                  recordCitation({
                    executionId,
                    memoryId: r.id,
                    influence: "CONSIDERED",
                    compliance: deriveCompliance({
                      enforcement: r.enforcementScore,
                      deviated: false,
                    }),
                    enforcementAtCite: r.enforcementScore,
                    confidenceAtCite: r.confidenceScore,
                  }),
                ),
              );
            } catch (err) {
              logger.warn({ err }, "agent.memory-adapter: auto-citation failed — skipping");
            }
          })();
        }

        const memoryLines = rows.map((r) => `- [${r.memoryKind}] ${r.lesson}`);
        const peerLines = peers.map(
          (p) => `- [peer-result] ${p.summary} (run ${p.runId})`,
        );
        return [...memoryLines, ...peerLines].join("\n");
      } catch (err) {
        logger.error(
          { err },
          "agent.memory-adapter: recallContext failed — agent running with NO recalled memory",
        );
        await emitRecallFailure(args.telemetry, err);
        return "";
      }
    },

    async remember(kind: string, content: unknown): Promise<void> {
      try {
        const lesson = JSON.stringify(content).slice(0, 1000);
        const embedding = await embedText(lesson, {
          telemetry: {
            orgId: args.telemetry.orgId,
            workspaceId: args.telemetry.workspaceId,
            surface: args.telemetry.surface,
            executionStepId: args.telemetry.messageId,
          },
        });
        await writeMemory({
          // "coding-agent" is the workspace sentinel nodeRef — no real graph
          // node is linked for coding turns. The OPTIONAL MATCH inside
          // writeMemory will find nothing and skip the :REMEMBERS edge, but
          // the AgentMemory MERGE proceeds normally.
          nodeRef: "coding-agent",
          embedding,
          // A coding-turn note is an unconfirmed OBSERVATION — the lowest-
          // salience rung of the confidence ladder (mirrors the old weight:"low").
          memoryClass: "OBSERVATION",
          memoryKind: kind,
          lesson,
          source: "coding-agent",
          createdByKind: "AGENT",
          createdById: "coding-agent",
        });
      } catch (err) {
        logger.warn({ err }, "agent.memory-adapter: remember() failed — skipping");
      }
    },

    async close(): Promise<void> {
      // no-op: sessions are opened and closed per-call in recallMemories / writeMemory
    },
  };
}
