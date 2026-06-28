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
import { recallMemories, writeMemory } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import type { MemoryProvider } from "@oxagen/agent-engine";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "agent.memory-adapter" } });

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
      const emb = await embedText(args.recallQuery, {
        telemetry: {
          orgId: args.telemetry.orgId,
          workspaceId: args.telemetry.workspaceId,
          surface: args.telemetry.surface,
          executionStepId: args.telemetry.messageId,
        },
      });
      const rows = await recallMemories({
        embedding: emb,
        minWeight: "low",
        limit: 8,
        recallThreshold: 0.7,
      });
      if (rows.length === 0) return "";
      return rows.map((r) => `- [${r.kind}] ${r.lesson}`).join("\n");
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
          weight: "low",
          kind,
          lesson,
          source: "coding-agent",
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
