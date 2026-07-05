import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted so the mock fn exists when the vi.mock factory runs.
const { getExecutionLineageMock } = vi.hoisted(() => ({
  getExecutionLineageMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({ getExecutionLineage: getExecutionLineageMock }));

import { agentExecutionLineageHandler } from "./agent.execution.lineage";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

beforeEach(() => {
  getExecutionLineageMock.mockReset();
});

describe("agent.execution.lineage handler", () => {
  it("resolves a found execution and its touched files to KnowledgeNodeRef shapes", async () => {
    getExecutionLineageMock.mockResolvedValueOnce({
      execution: {
        id: "aexuuid_root",
        publicId: "aex_root",
        label: "Execution",
        displayName: "chat execution",
        properties: JSON.stringify({ agentId: "agent_1", latencyMs: 4000 }),
        status: "completed",
        originType: "chat",
        summary: "Fixed the widget bug",
      },
      files: [
        {
          naturalKey: "owner/repo:apps/app/src/foo.ts",
          path: "apps/app/src/foo.ts",
          displayName: "apps/app/src/foo.ts",
          publicId: "sf_1",
          edgeType: "TOUCHED_FILE",
        },
        {
          naturalKey: "owner/repo:apps/app/src/bar.ts",
          path: "apps/app/src/bar.ts",
          displayName: null,
          publicId: null,
          edgeType: "TOUCHED_FILE",
        },
      ],
    });

    const out = await agentExecutionLineageHandler({ executionId: "aex_root" }, CTX);

    expect(getExecutionLineageMock).toHaveBeenCalledWith("aex_root");
    expect(out.found).toBe(true);
    expect(out.execution).toEqual({
      id: "aex_root",
      label: "Execution",
      displayName: "chat execution",
      properties: {
        agentId: "agent_1",
        latencyMs: 4000,
        status: "completed",
        originType: "chat",
        summary: "Fixed the widget bug",
      },
    });
    expect(out.files).toHaveLength(2);
    expect(out.files[0]).toEqual({
      node: {
        id: "sf_1",
        label: "SourceFile",
        displayName: "apps/app/src/foo.ts",
        properties: { path: "apps/app/src/foo.ts", naturalKey: "owner/repo:apps/app/src/foo.ts" },
      },
      edgeType: "TOUCHED_FILE",
    });
    // Second file has no publicId/displayName — falls back to naturalKey.
    expect(out.files[1]).toEqual({
      node: {
        id: "owner/repo:apps/app/src/bar.ts",
        label: "SourceFile",
        displayName: "apps/app/src/bar.ts",
        properties: { path: "apps/app/src/bar.ts", naturalKey: "owner/repo:apps/app/src/bar.ts" },
      },
      edgeType: "TOUCHED_FILE",
    });
  });

  it("returns { found: false, execution: null, files: [] } when the execution does not exist", async () => {
    getExecutionLineageMock.mockResolvedValueOnce({ execution: null, files: [] });

    const out = await agentExecutionLineageHandler({ executionId: "aex_missing" }, CTX);

    expect(out).toEqual({ found: false, execution: null, files: [] });
  });

  it("returns found:true with an empty files array when the execution touched zero files", async () => {
    getExecutionLineageMock.mockResolvedValueOnce({
      execution: {
        id: "aexuuid_root",
        publicId: "aex_root",
        label: null,
        displayName: null,
        properties: null,
        status: "running",
        originType: "fanout",
        summary: null,
      },
      files: [],
    });

    const out = await agentExecutionLineageHandler({ executionId: "aex_root" }, CTX);

    expect(out.found).toBe(true);
    expect(out.execution).toEqual({
      id: "aex_root",
      label: "Execution",
      displayName: "fanout execution",
      properties: { status: "running", originType: "fanout" },
    });
    expect(out.files).toEqual([]);
  });

  it("tolerates malformed JSON in the execution's properties string without throwing", async () => {
    getExecutionLineageMock.mockResolvedValueOnce({
      execution: {
        id: "aexuuid_root",
        publicId: "aex_root",
        label: "Execution",
        displayName: "chat execution",
        properties: "{not-valid-json",
        status: "completed",
        originType: "chat",
        summary: null,
      },
      files: [],
    });

    const out = await agentExecutionLineageHandler({ executionId: "aex_root" }, CTX);

    expect(out.found).toBe(true);
    expect(out.execution!.properties).toEqual({ status: "completed", originType: "chat" });
  });

  it("tolerates an empty properties string without throwing", async () => {
    getExecutionLineageMock.mockResolvedValueOnce({
      execution: {
        id: "aexuuid_root",
        publicId: "aex_root",
        label: "Execution",
        displayName: "chat execution",
        properties: "",
        status: "completed",
        originType: "chat",
        summary: null,
      },
      files: [],
    });

    const out = await agentExecutionLineageHandler({ executionId: "aex_root" }, CTX);

    expect(out.found).toBe(true);
    expect(out.execution!.properties).toEqual({ status: "completed", originType: "chat" });
  });
});
