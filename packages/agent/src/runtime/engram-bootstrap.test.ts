/**
 * Tests for engram-bootstrap.ts — bootstrapEngramRuntime() must wire the
 * @oxagen/engram graph-sync client and compile-telemetry sink so their
 * emitters stop silently no-oping, and the registered sink must map a
 * CompileTelemetryEvent onto the append-only ClickHouse `events` stream via
 * the canonical insertEvents() helper (no bespoke table).
 *
 * @oxagen/engram and @oxagen/telemetry are mocked (the packages/agent test
 * convention — see context-compiler.test.ts) so no live store/ClickHouse is
 * needed. That emitGraphSync actually sends once a client is registered is
 * proven directly against the real module in graph/emit-sync.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const engramMocks = vi.hoisted(() => ({
  setGraphSyncClientSpy: vi.fn(),
  setCompileTelemetrySinkSpy: vi.fn(),
}));

const telemetryMocks = vi.hoisted(() => ({
  insertEventsSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/engram", () => ({
  setGraphSyncClient: engramMocks.setGraphSyncClientSpy,
  setCompileTelemetrySink: engramMocks.setCompileTelemetrySinkSpy,
}));

vi.mock("@oxagen/telemetry", () => ({
  insertEvents: telemetryMocks.insertEventsSpy,
}));

import { bootstrapEngramRuntime } from "./engram-bootstrap";
import type {
  GraphSyncEventClient,
  CompileTelemetryEvent,
  TelemetrySink,
} from "@oxagen/engram";

const CLIENT: GraphSyncEventClient = {
  send: vi.fn().mockResolvedValue(undefined),
};

const COMPILE_EVENT: CompileTelemetryEvent = {
  compile_id: "11111111-1111-1111-1111-111111111111",
  org_id: "org-1",
  workspace_id: "ws-1",
  session_id: "sess-1",
  agent_id: "agent-1",
  model_id: "claude-sonnet-5",
  retrieval_ms: 15,
  packing_ms: 5,
  layout_ms: 2,
  total_ms: 22,
  candidates_retrieved: 25,
  candidates_packed: 10,
  candidates_compressed: 3,
  candidates_evicted: 12,
  budget_total: 10000,
  budget_used: 850,
  budget_remaining: 9150,
  cache_stable_bytes: 3000,
  cache_total_bytes: 7000,
  cache_hit_rate: 0.43,
  created_at: "2026-07-09T00:00:00.000Z",
};

describe("bootstrapEngramRuntime", () => {
  beforeEach(() => {
    engramMocks.setGraphSyncClientSpy.mockReset();
    engramMocks.setCompileTelemetrySinkSpy.mockReset();
    telemetryMocks.insertEventsSpy.mockReset().mockResolvedValue(undefined);
  });

  it("registers the provided event client as the engram graph-sync client", () => {
    bootstrapEngramRuntime(CLIENT);
    expect(engramMocks.setGraphSyncClientSpy).toHaveBeenCalledOnce();
    expect(engramMocks.setGraphSyncClientSpy).toHaveBeenCalledWith(CLIENT);
  });

  it("registers a compile-telemetry sink", () => {
    bootstrapEngramRuntime(CLIENT);
    expect(engramMocks.setCompileTelemetrySinkSpy).toHaveBeenCalledOnce();
    const [sink] = engramMocks.setCompileTelemetrySinkSpy.mock.calls[0] as [
      TelemetrySink,
    ];
    expect(typeof sink).toBe("function");
  });

  it("the registered sink writes the compile event to the ClickHouse `events` stream via insertEvents", async () => {
    bootstrapEngramRuntime(CLIENT);
    const [sink] = engramMocks.setCompileTelemetrySinkSpy.mock.calls[0] as [
      TelemetrySink,
    ];

    await sink(COMPILE_EVENT);

    expect(telemetryMocks.insertEventsSpy).toHaveBeenCalledOnce();
    const [rows] = telemetryMocks.insertEventsSpy.mock.calls[0] as [
      Array<{
        event_id: string;
        org_id: string;
        workspace_id: string;
        event_type: string;
        source_system: string;
        stream_offset: null;
        payload: string;
        emitted_at: string;
      }>,
    ];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_id).toBe(COMPILE_EVENT.compile_id);
    expect(row.org_id).toBe("org-1");
    expect(row.workspace_id).toBe("ws-1");
    expect(row.event_type).toBe("engram.compile");
    expect(row.source_system).toBe("engram");
    expect(row.stream_offset).toBeNull();
    expect(row.emitted_at).toBe(COMPILE_EVENT.created_at);
    // Full telemetry rides in the JSON payload — no bespoke ClickHouse table.
    const payload = JSON.parse(row.payload) as CompileTelemetryEvent;
    expect(payload.model_id).toBe("claude-sonnet-5");
    expect(payload.total_ms).toBe(22);
    expect(payload.cache_hit_rate).toBeCloseTo(0.43, 2);
  });

  it("surfaces a ClickHouse insert failure from the sink (emitCompileTelemetry is the layer that swallows it)", async () => {
    telemetryMocks.insertEventsSpy.mockRejectedValueOnce(
      new Error("clickhouse down"),
    );
    bootstrapEngramRuntime(CLIENT);
    const [sink] = engramMocks.setCompileTelemetrySinkSpy.mock.calls[0] as [
      TelemetrySink,
    ];
    await expect(sink(COMPILE_EVENT)).rejects.toThrow("clickhouse down");
  });
});
