import { describe, it, expect, vi, beforeEach } from "vitest";

// embedEntity has no execution step to report, so it must pass
// `executionStepId: null` rather than a synthesized string like
// `embed:<nodeId>` — token_usage.execution_step_id and
// credit_ledger.reference_id are both UUID columns, and a non-UUID string
// breaks the insert. This test asserts the telemetry forwarded to embedText
// carries `executionStepId: null`.

const mocks = vi.hoisted(() => ({
  embedText: vi.fn(),
  upsertEmbedding: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({ embedText: mocks.embedText }));
vi.mock("../mutations/upsert-entity", () => ({
  upsertEmbedding: mocks.upsertEmbedding,
}));

import { embedEntity } from "./index";

describe("embedEntity telemetry (no synthesized execution_step_id)", () => {
  beforeEach(() => {
    mocks.embedText.mockReset().mockResolvedValue(new Array(1536).fill(0));
    mocks.upsertEmbedding.mockReset().mockResolvedValue(undefined);
  });

  it("forwards executionStepId: null (not `embed:<nodeId>`) to embedText", async () => {
    await embedEntity({
      nodeId: "node-abc",
      entityType: "github:pull_request",
      text: "some entity text",
      orgId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      connectionId: "33333333-3333-3333-3333-333333333333",
    });

    expect(mocks.embedText).toHaveBeenCalledTimes(1);
    const opts = mocks.embedText.mock.calls[0]![1] as {
      telemetry: { executionStepId: string | null; surface: string };
    };
    expect(opts.telemetry.executionStepId).toBeNull();
    // Specifically: it must NOT be the old synthesized correlation string.
    expect(opts.telemetry.executionStepId).not.toBe("embed:node-abc");
    expect(opts.telemetry.surface).toBe("ingestion");
  });
});
