import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  projectExecutionToolUsage: vi.fn(async (_args: unknown) => undefined),
  warn: vi.fn(),
}));

vi.mock("@oxagen/agent", () => ({
  projectExecutionToolUsage: mocks.projectExecutionToolUsage,
}));

vi.mock("./logger", () => ({
  logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}));

import { projectToolUsageBestEffort } from "./project-tool-usage";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const EXECUTION_ID = "33333333-3333-3333-3333-333333333333";

const ctx = { orgId: ORG_ID, workspaceId: WORKSPACE_ID };

beforeEach(() => {
  mocks.projectExecutionToolUsage.mockReset();
  mocks.projectExecutionToolUsage.mockResolvedValue(undefined);
  mocks.warn.mockReset();
});

describe("projectToolUsageBestEffort", () => {
  it("forwards the execution id and tenant scope to the projection", async () => {
    await projectToolUsageBestEffort(EXECUTION_ID, ctx);
    expect(mocks.projectExecutionToolUsage).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("swallows a projection failure and logs it — this is the catch the projection deliberately does not do itself", async () => {
    mocks.projectExecutionToolUsage.mockRejectedValue(
      new Error("neo4j unavailable"),
    );
    await expect(
      projectToolUsageBestEffort(EXECUTION_ID, ctx),
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [fields] = mocks.warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields.executionId).toBe(EXECUTION_ID);
    expect((fields.err as Error).message).toBe("neo4j unavailable");
  });

  it("logs nothing on the happy path", async () => {
    await projectToolUsageBestEffort(EXECUTION_ID, ctx);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
