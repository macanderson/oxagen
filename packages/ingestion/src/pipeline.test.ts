import { describe, it, expect, vi, beforeEach } from "vitest";

// Register all built-in connectors before importing pipeline
import "./connectors/github/index";
import "./connectors/custom-sql/index";

// Mock the external-dep modules before importing the pipeline
vi.mock("./dedup/resolve", () => ({
  resolveEntity: vi.fn().mockResolvedValue({
    principalNodeId: "node-principal-1",
    action: "created_principal",
    confidence: 1.0,
  }),
}));

vi.mock("./embed/index", () => ({
  renderEntityText: vi.fn().mockReturnValue("task  Fix bug  state:open"),
  embedEntity: vi.fn().mockResolvedValue(undefined),
}));

import { runPipeline } from "./pipeline";
import { resolveEntity } from "./dedup/resolve";
import { embedEntity } from "./embed/index";
import type { RawIngestEvent, PipelineResult } from "./types";
import type { PipelineContext } from "./pipeline";

function makeEvent(overrides: Partial<RawIngestEvent> = {}): RawIngestEvent {
  return {
    connectionId: "conn-abc",
    workspaceId: "ws-1",
    orgId: "org-1",
    connectorType: "github",
    sourceRecordType: "pull_request",
    idempotencyKey: "github:conn-abc:pull_request:42",
    payload: {
      number: 42,
      title: "Add login",
      body: "implements SSO",
      state: "open",
      user: { login: "alice" },
      labels: [],
    },
    receivedAt: "2024-01-15T09:00:00Z",
    ...overrides,
  };
}

function makeCtx(
  mapping: Awaited<ReturnType<PipelineContext["getMapping"]>> = {
    oxagenEntityType: "task",
    propertyMappings: {},
  },
): PipelineContext {
  return {
    orgId: "org-1",
    getMapping: vi.fn().mockResolvedValue(mapping),
    scheduleInference: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no entity type mapping is configured", async () => {
    const event = makeEvent();
    const ctx = makeCtx(null);
    const result = await runPipeline(event, ctx);
    expect(result).toBeNull();
    expect(ctx.getMapping).toHaveBeenCalledWith("conn-abc", "pull_request");
  });

  it("runs all stages and returns a PipelineResult", async () => {
    const event = makeEvent();
    const ctx = makeCtx({ oxagenEntityType: "task", propertyMappings: {} });

    const result = await runPipeline(event, ctx);

    expect(result).not.toBeNull();
    // Narrow: no deliveryConfig set, so result is a PipelineResult (not FilteredResult)
    const pr = result as PipelineResult;
    expect(pr.naturalKey).toBe("github:conn-abc:42");
    expect(pr.operation).toBe("insert");
    expect(pr.dedup.principalNodeId).toBe("node-principal-1");
    expect(pr.dedup.action).toBe("created_principal");
    expect(pr.embedded).toBe(true);
    expect(pr.inferenceQueued).toBe(true);
  });

  it("calls resolveEntity with the correct entityMutation", async () => {
    const event = makeEvent();
    const ctx = makeCtx({ oxagenEntityType: "code_change", propertyMappings: {} });

    await runPipeline(event, ctx);

    expect(resolveEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        orgId: "org-1",
        connectionId: "conn-abc",
        entityType: "code_change",
        sourceRecordType: "pull_request",
        naturalKey: "github:conn-abc:42",
      }),
      "org-1",
      // §8: the pipeline threads the schema-validation opts (pinnedSchema +
      // source metadata) as the third arg. No pin configured here → null.
      expect.objectContaining({
        pinnedSchema: null,
        connectionId: "conn-abc",
        sourceRecordType: "pull_request",
      }),
    );
  });

  it("calls embedEntity with the resolved principal node ID", async () => {
    const event = makeEvent();
    const ctx = makeCtx({ oxagenEntityType: "task", propertyMappings: {} });

    await runPipeline(event, ctx);

    expect(embedEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-principal-1",
        entityType: "task",
        workspaceId: "ws-1",
        orgId: "org-1",
        connectionId: "conn-abc",
      }),
    );
  });

  it("calls scheduleInference with the principal node ID", async () => {
    const event = makeEvent();
    const ctx = makeCtx({ oxagenEntityType: "task", propertyMappings: {} });

    await runPipeline(event, ctx);

    expect(ctx.scheduleInference).toHaveBeenCalledWith(
      "node-principal-1",
      "task",
      expect.any(Object),
    );
  });

  it("applies propertyMappings to rename source fields", async () => {
    const event = makeEvent();
    const ctx = makeCtx({
      oxagenEntityType: "task",
      propertyMappings: { title: "summary" },
    });

    await runPipeline(event, ctx);

    // The mutation passed to resolveEntity should have 'summary' not 'title'
    const callArg = (resolveEntity as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      properties: Record<string, unknown>;
    };
    expect(callArg.properties["summary"]).toBeDefined();
    expect(callArg.properties["title"]).toBeUndefined();
  });

  it("preserves sourceRecordType on the mutation", async () => {
    const event = makeEvent({ sourceRecordType: "issue" });
    const ctx = makeCtx({ oxagenEntityType: "task", propertyMappings: {} });

    await runPipeline(event, ctx);

    const callArg = (resolveEntity as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      sourceRecordType: string;
    };
    expect(callArg.sourceRecordType).toBe("issue");
  });

  it("throws when the connector is not registered", async () => {
    const event = makeEvent({ connectorType: "not-a-real-connector" });
    const ctx = makeCtx({ oxagenEntityType: "task", propertyMappings: {} });

    await expect(runPipeline(event, ctx)).rejects.toThrow(
      'No connector registered for "not-a-real-connector"',
    );
  });
});
