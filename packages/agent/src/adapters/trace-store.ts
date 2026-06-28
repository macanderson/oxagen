/**
 * ClickHouse TraceStore — records one "agent.coding.turn" event row per
 * completed coding run. Fire-and-forget; never throws.
 */
import { insertEvents, type EventRow } from "@oxagen/telemetry";
import type { TraceStore } from "@oxagen/agent-engine";

export interface TraceStoreArgs {
  orgId: string;
  workspaceId: string;
  surface: string;
}

type KnownTrace = {
  instruction?: string;
  changedFiles?: string[];
  steps?: number;
  text?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export function createClickHouseTraceStore(args: TraceStoreArgs): TraceStore {
  return {
    record(trace: unknown): void {
      const t: KnownTrace = trace != null && typeof trace === "object" ? (trace as KnownTrace) : {};
      const row: EventRow = {
        event_id: globalThis.crypto.randomUUID(),
        org_id: args.orgId,
        workspace_id: args.workspaceId,
        event_type: "agent.coding.turn",
        source_system: args.surface,
        stream_offset: null,
        payload: JSON.stringify({
          changedFilesCount: (t.changedFiles ?? []).length,
          stepsCount: t.steps ?? 0,
          instructionPreview:
            typeof t.instruction === "string" ? t.instruction.slice(0, 200) : "",
          inputTokens: t.usage?.inputTokens ?? null,
          outputTokens: t.usage?.outputTokens ?? null,
        }),
        emitted_at: new Date().toISOString(),
      };
      void insertEvents([row]).catch(() => {});
    },
  };
}
