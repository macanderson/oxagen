/**
 * Unit tests for semantic.edge.infer handler.
 *
 * Verifies:
 * - Fetches active source connections from DB
 * - Filters connections by sourceIds when provided
 * - Fires the Inngest ingestion/semantic.edge.infer.requested event
 * - Returns queued status with estimatedNodes = connection count
 * - Returns estimatedNodes = 0 and skips Inngest when no connections found
 * - Respects dryRun flag (forwards to Inngest event)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  inngestSend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./event-client", () => ({
  eventClient: { send: mocks.inngestSend },
}));

import { semanticEdgeInferHandler } from "./semantic.edge.infer";

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

const SHARED_PROMPT = "Identify relationships between entities in this workspace.";

interface ConnRow { id: string; publicId: string }

function makeConnRow(publicId: string, id = `uuid-${publicId}`): ConnRow {
  return { id, publicId };
}

type TxLike = { select: ReturnType<typeof vi.fn> };

function setupDb(rows: ConnRow[]) {
  mocks.withTenantDb.mockImplementation((fn: (tx: TxLike) => Promise<unknown>) => {
    const tx: TxLike = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    };
    return fn(tx);
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("semanticEdgeInferHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("returns queued status with estimatedNodes = connection count", async () => {
    setupDb([makeConnRow("intg_a"), makeConnRow("intg_b")]);

    const result = await semanticEdgeInferHandler(
      {
        semanticEdgePrompt: SHARED_PROMPT,
        maxEdgesPerNode: 10,
        confidenceThreshold: 0.8,
        dryRun: false,
      },
      CTX,
    );

    expect(result.status).toBe("queued");
    expect(result.estimatedNodes).toBe(2);
    expect(typeof result.jobId).toBe("string");
    expect(result.dryRun).toBe(false);
  });

  it("fires Inngest event with correct connection IDs", async () => {
    const rows = [makeConnRow("intg_a", "uuid-1"), makeConnRow("intg_b", "uuid-2")];
    setupDb(rows);

    await semanticEdgeInferHandler(
      {
        semanticEdgePrompt: SHARED_PROMPT,
        maxEdgesPerNode: 10,
        confidenceThreshold: 0.8,
        dryRun: false,
      },
      CTX,
    );

    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [Record<string, unknown>];
    const data = sentEvent["data"] as Record<string, unknown>;
    expect(data["connectionIds"]).toEqual(["uuid-1", "uuid-2"]);
    expect(data["orgId"]).toBe("org-1");
    expect(data["workspaceId"]).toBe("ws-1");
    expect(data["dryRun"]).toBe(false);
  });

  it("filters connections by sourceIds when provided", async () => {
    const rows = [makeConnRow("intg_a", "uuid-1"), makeConnRow("intg_b", "uuid-2")];
    setupDb(rows);

    const result = await semanticEdgeInferHandler(
      {
        semanticEdgePrompt: SHARED_PROMPT,
        maxEdgesPerNode: 10,
        confidenceThreshold: 0.8,
        dryRun: false,
        sourceIds: ["intg_a"],
      },
      CTX,
    );

    expect(result.estimatedNodes).toBe(1);
    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [Record<string, unknown>];
    const data = sentEvent["data"] as Record<string, unknown>;
    expect(data["connectionIds"]).toEqual(["uuid-1"]);
  });

  it("returns estimatedNodes 0 and skips Inngest when no connections found", async () => {
    setupDb([]);

    const result = await semanticEdgeInferHandler(
      {
        semanticEdgePrompt: SHARED_PROMPT,
        maxEdgesPerNode: 10,
        confidenceThreshold: 0.8,
        dryRun: false,
      },
      CTX,
    );

    expect(result.estimatedNodes).toBe(0);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("forwards dryRun flag to the Inngest event", async () => {
    setupDb([makeConnRow("intg_a")]);

    await semanticEdgeInferHandler(
      {
        semanticEdgePrompt: SHARED_PROMPT,
        maxEdgesPerNode: 10,
        confidenceThreshold: 0.8,
        dryRun: true,
      },
      CTX,
    );

    const [sentEvent] = mocks.inngestSend.mock.calls[0] as [Record<string, unknown>];
    const data = sentEvent["data"] as Record<string, unknown>;
    expect(data["dryRun"]).toBe(true);
  });

  it("returns dryRun=true in the handler output", async () => {
    setupDb([makeConnRow("intg_a")]);

    const result = await semanticEdgeInferHandler(
      {
        semanticEdgePrompt: SHARED_PROMPT,
        maxEdgesPerNode: 5,
        confidenceThreshold: 0.9,
        dryRun: true,
      },
      CTX,
    );

    expect(result.dryRun).toBe(true);
  });
});
