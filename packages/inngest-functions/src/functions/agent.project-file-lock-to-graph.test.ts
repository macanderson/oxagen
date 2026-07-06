import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the wrapped handler at module-load time by mocking inngest.createFunction.
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  projectFileLockToGraph: vi.fn().mockResolvedValue({ projected: true }),
  runInTenantScope: vi.fn(),
  loggerInfo: vi.fn(),
}));

type InngestContext = {
  event: { data: unknown };
  step: { run: (name: string, fn: () => unknown) => unknown };
};

let capturedHandler: ((ctx: InngestContext) => unknown) | null = null;

mocks.createFunction.mockImplementation((_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
  capturedHandler = handler;
  return {};
});

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.createFunction },
}));

vi.mock("@oxagen/ontology", () => ({
  projectFileLockToGraph: mocks.projectFileLockToGraph,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, error: vi.fn(), warn: vi.fn() },
}));

await import("./agent.project-file-lock-to-graph");

const ACQUIRE_PAYLOAD = {
  orgId: "org-abc",
  workspaceId: "ws-xyz",
  resourceKey: "github:oxageninc/oxagen-platform:src/a.ts",
  holder: "task-1",
  executionId: "exec-1",
  action: "write",
  event: "acquired" as const,
  fencingToken: 3,
  expiresAt: 2000,
};

function step() {
  return { run: vi.fn((_name: string, fn: () => unknown) => fn()) };
}

describe("agent.project-file-lock-to-graph Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
  });

  it("projects the lease onto the graph with the full payload", async () => {
    await capturedHandler!({ event: { data: ACQUIRE_PAYLOAD }, step: step() } as InngestContext);
    expect(mocks.projectFileLockToGraph).toHaveBeenCalledWith({
      resourceKey: ACQUIRE_PAYLOAD.resourceKey,
      holder: ACQUIRE_PAYLOAD.holder,
      executionId: ACQUIRE_PAYLOAD.executionId,
      action: ACQUIRE_PAYLOAD.action,
      event: "acquired",
      fencingToken: 3,
      expiresAt: 2000,
    });
  });

  it("runs the write inside runInTenantScope with the event's org/workspace", async () => {
    await capturedHandler!({ event: { data: ACQUIRE_PAYLOAD }, step: step() } as InngestContext);
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: "org-abc", workspaceId: "ws-xyz" },
      expect.any(Function),
    );
  });

  it("handles a release event (fencing/expiry omitted)", async () => {
    const releasePayload = {
      orgId: "org-abc",
      workspaceId: "ws-xyz",
      resourceKey: "k",
      holder: "task-1",
      executionId: "exec-1",
      action: "write",
      event: "released" as const,
    };
    await capturedHandler!({ event: { data: releasePayload }, step: step() } as InngestContext);
    const call = mocks.projectFileLockToGraph.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe("released");
  });

  it("propagates a projection error so Inngest can retry", async () => {
    mocks.projectFileLockToGraph.mockRejectedValueOnce(new Error("Neo4j refused"));
    await expect(
      capturedHandler!({ event: { data: ACQUIRE_PAYLOAD }, step: step() } as InngestContext),
    ).rejects.toThrow("Neo4j refused");
  });
});
