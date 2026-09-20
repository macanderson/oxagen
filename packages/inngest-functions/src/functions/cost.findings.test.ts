import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFindingsPass: vi.fn(),
  listWorkspacesForFindings: vi.fn(),
  createFunction: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  runFindingsPass: mocks.runFindingsPass,
  listWorkspacesForFindings: mocks.listWorkspacesForFindings,
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  event?: { data: unknown };
  events?: { data: unknown }[];
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;
const registered = new Map<
  string,
  { config: Record<string, unknown>; handler: Handler }
>();
mocks.createFunction.mockImplementation(
  (config: { id: string }, _trigger: unknown, handler: Handler) => {
    registered.set(config.id, { config, handler });
    return [{}];
  },
);

const { scopesOf } = await import("./cost.findings");

const step = { run: (_: string, fn: () => Promise<unknown>) => fn() };
const WS_A = { orgId: "org-1", workspaceId: "ws-a" };
const WS_B = { orgId: "org-1", workspaceId: "ws-b" };

describe("cost.findings", () => {
  beforeEach(() => {
    mocks.runFindingsPass.mockReset().mockResolvedValue({ findings: 2 });
    mocks.listWorkspacesForFindings.mockReset();
  });

  it("batches requests per workspace", () => {
    const { config } = registered.get("cost.findings")!;
    expect(config.batchEvents).toMatchObject({
      key: "event.data.workspaceId",
      maxSize: 5,
      // Inngest refuses a batch timeout over 30s, and the refusal fails the
      // sync for every function in the app, not just this one.
      timeout: "30s",
    });
  });

  it("runs one pass per workspace the batch names, however many seals asked", async () => {
    const out = await registered.get("cost.findings")!.handler({
      events: [{ data: WS_A }, { data: WS_A }, { data: WS_B }],
      step,
    });
    expect(mocks.runFindingsPass.mock.calls.map((c) => c[0])).toEqual([
      WS_A,
      WS_B,
    ]);
    expect(out).toEqual({ workspaces: 2, findings: 4 });
  });

  it("refuses a batch that names no workspace without a retry", async () => {
    await expect(
      registered
        .get("cost.findings")!
        .handler({ events: [{ data: {} }], step }),
    ).rejects.toMatchObject({ name: "NonRetriableError" });
    expect(mocks.runFindingsPass).not.toHaveBeenCalled();
  });

  it("lets a degraded store fail the batch so Inngest retries", async () => {
    mocks.runFindingsPass.mockRejectedValue(new Error("clickhouse down"));
    await expect(
      registered
        .get("cost.findings")!
        .handler({ events: [{ data: WS_A }], step }),
    ).rejects.toThrow("clickhouse down");
  });

  it("keeps a malformed event out of the scopes", () => {
    expect(scopesOf([{ data: { orgId: "org-1" } }, { data: WS_B }])).toEqual([
      WS_B,
    ]);
  });
});

describe("cost.findings-nightly", () => {
  beforeEach(() => {
    mocks.runFindingsPass.mockReset();
    mocks.listWorkspacesForFindings.mockReset().mockResolvedValue([WS_A, WS_B]);
  });

  it("passes over every workspace with runs in the window, past one that fails", async () => {
    mocks.runFindingsPass
      .mockRejectedValueOnce(new Error("clickhouse down"))
      .mockResolvedValueOnce({ findings: 1 });
    const out = await registered
      .get("cost.findings-nightly")!
      .handler({ step });
    expect(mocks.runFindingsPass.mock.calls.map((c) => c[0])).toEqual([
      WS_A,
      WS_B,
    ]);
    expect(out).toEqual({ workspaces: 2, passed: 1 });
  });
});
