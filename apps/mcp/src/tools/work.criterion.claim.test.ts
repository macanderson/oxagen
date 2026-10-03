// The MCP tool for claim_work_criterion (ADR-244, ADR-251): the agent working
// a send claims a criterion of its brief. The kernel `invoke` and the context
// seam `buildContext` are doubles, so the case checks what the tool sends and
// that the answer passed the contract's output schema on the way back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import claimWorkCriterion, { metadata, schema } from "./work.criterion.claim";

const fakeCtx = { orgId: "org_test", workspaceId: "ws_test", userId: null, apiKeyId: "aky_host", surface: "mcp" as const };
const SHA = "a1".repeat(20);
const ARGS = {
  item_id: "wi_01",
  work_order_id: "wo_01",
  criterion_id: "c1",
  head_sha: SHA,
  text: "The invite test covers the expired link.",
};
const ANSWER = {
  item: { id: "wi_01", state: "review", revision: 1, version: 5 },
  repeat: false,
  order: { id: "wo_01", send: 1, key: "wi_01:r1:s1", delivery: "run_ended" },
  claim: { criterion_id: "c1", head_sha: SHA, run_id: "tse_01" },
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.buildContext.mockReset();
  mocks.headers.mockReset();
  mocks.headers.mockReturnValue({});
  mocks.buildContext.mockResolvedValue(fakeCtx);
});

describe("claim_work_criterion MCP tool", () => {
  it("is named after its contract, writes, and destroys nothing", () => {
    expect(metadata.name).toBe("claim_work_criterion");
    expect(metadata.annotations?.readOnlyHint).toBe(false);
    expect(metadata.annotations?.destructiveHint).toBe(false);
    expect(metadata.annotations?.idempotentHint).toBe(true);
  });

  it("takes the contract's input fields", () => {
    expect(Object.keys(schema).sort()).toEqual(["criterion_id", "head_sha", "item_id", "text", "work_order_id"]);
  });

  it("invokes claim_work_criterion on the mcp surface and returns its checked output", async () => {
    mocks.invoke.mockResolvedValue(ANSWER);
    await expect(claimWorkCriterion(ARGS)).resolves.toEqual(ANSWER);
    expect(mocks.invoke).toHaveBeenCalledWith("claim_work_criterion", ARGS, fakeCtx, { surface: "mcp" });
  });

  it("refuses an output its contract does not allow", async () => {
    mocks.invoke.mockResolvedValue({ ...ANSWER, claim: { ...ANSWER.claim, head_sha: "short" } });
    await expect(claimWorkCriterion(ARGS)).rejects.toThrow();
  });
});
