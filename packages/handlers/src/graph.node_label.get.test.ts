/**
 * Read-only graph node-label handler tests.
 *
 * Label mutation is intentionally not a public capability: connector/schema
 * ingestion owns typed labels. This suite protects the surviving scoped read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

import { graphNodeLabelsGetHandler } from "./graph.node_label.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function rec(fields: Record<string, unknown>) {
  return { records: [{ get: (key: string) => fields[key] ?? null }] };
}

beforeEach(() => vi.clearAllMocks());

describe("graphNodeLabelsGetHandler", () => {
  it("returns customer labels without the internal anchor label", async () => {
    mocks.run.mockResolvedValueOnce(
      rec({ labels: ["GraphNode", "Billing", "Payment"] }),
    );

    const out = await graphNodeLabelsGetHandler({ nodeId: "n1" }, CTX);

    expect(out).toEqual({ nodeId: "n1", labels: ["Billing", "Payment"] });
  });

  it("returns an empty array when the node has only the anchor label", async () => {
    mocks.run.mockResolvedValueOnce(rec({ labels: ["GraphNode"] }));

    await expect(
      graphNodeLabelsGetHandler({ nodeId: "n1" }, CTX),
    ).resolves.toEqual({ nodeId: "n1", labels: [] });
  });

  it("throws when the scoped node is not found", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });

    await expect(
      graphNodeLabelsGetHandler({ nodeId: "missing" }, CTX),
    ).rejects.toThrow("not found");
  });

  it("binds both tenant identifiers explicitly", async () => {
    mocks.run.mockResolvedValueOnce(rec({ labels: ["GraphNode", "Billing"] }));

    await graphNodeLabelsGetHandler({ nodeId: "n1" }, CTX);

    expect(mocks.run.mock.calls[0]?.[1]).toMatchObject({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
  });
});
