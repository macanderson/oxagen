import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { workspaceBudgetPolicyWriteRoute } from "./workspace.budget_policy.write";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = {
  enabled: true,
  limitUsd: 100,
  mode: "hard",
  graceOveragePct: 0,
  enforcement: "ceiling",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function patch(body: unknown): Promise<Response> {
  return workspaceBudgetPolicyWriteRoute.fetch(
    new Request("http://localhost/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH workspace/budget-policy", () => {
  it("forwards the parsed body to invoke and returns the output", async () => {
    const res = await patch({ enabled: true, limitUsd: 100 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_budget_policy",
      { enabled: true, limitUsd: 100 },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke when the body fails contract validation", async () => {
    const res = await patch({ limitUsd: -5 });

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
