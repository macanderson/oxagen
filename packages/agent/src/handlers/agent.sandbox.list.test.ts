import { describe, expect, it, beforeEach, vi } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const fake = createFakeTx();
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

// Controllable sandbox driver for the live-reconcile path. isSandboxAvailable
// defaults to false so the reconcile is skipped and the pure-DB-read tests below
// are unaffected; reconcile tests flip it to true.
const sb = vi.hoisted(() => {
  const driver = {
    name: "modal",
    supportsSessions: true,
    run: vi.fn(),
    stream: vi.fn(),
    createSession: vi.fn(),
    execInSession: vi.fn(),
    snapshotSession: vi.fn(),
    restoreSession: vi.fn(),
    stopSession: vi.fn(),
    sessionStatus: vi.fn(),
  };
  return {
    driver,
    getSandbox: vi.fn((_provider?: string) => driver),
    isSandboxAvailable: vi.fn(() => false),
    isDurableSandboxDriver: vi.fn(() => true),
  };
});
vi.mock("@oxagen/sandbox", () => ({
  getSandbox: sb.getSandbox,
  isSandboxAvailable: sb.isSandboxAvailable,
  isDurableSandboxDriver: sb.isDurableSandboxDriver,
}));

import { agentSandboxListHandler } from "./agent.sandbox.list";

const ROW = {
  id: "uuid-1",
  sandboxId: "sb-aaa",
  publicId: "sbx_1",
  sessionKey: "conv_42",
  metadata: {} as unknown,
  image: "agent",
  status: "running",
  driver: "modal",
  lastUsedAt: new Date("2026-07-08T10:00:00.000Z"),
  expiresAt: new Date("2026-07-09T10:00:00.000Z"),
  createdAt: new Date("2026-07-08T09:00:00.000Z"),
  recoveryStatus: "none",
  recoveryBranch: null as string | null,
  recoveryCommit: null as string | null,
  graceDeadlineAt: null as Date | null,
  dirty: null as boolean | null,
  flushedAt: null as Date | null,
  recoveredAt: null as Date | null,
};

beforeEach(() => {
  fake.reset();
  sb.getSandbox.mockClear();
  sb.driver.sessionStatus.mockReset();
  sb.isSandboxAvailable.mockReturnValue(false);
  sb.isDurableSandboxDriver.mockReturnValue(true);
});

describe("agent.sandbox.list handler", () => {
  it("maps registry rows to the output shape with ISO timestamps", async () => {
    fake.enqueue([{ ...ROW }]);

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes).toEqual([
      {
        sessionId: "sbx_1",
        sessionKey: "conv_42",
        label: null,
        image: "agent",
        status: "running",
        driver: "modal",
        lastUsedAt: "2026-07-08T10:00:00.000Z",
        expiresAt: "2026-07-09T10:00:00.000Z",
        createdAt: "2026-07-08T09:00:00.000Z",
        recoveryStatus: "none",
        recoveryBranch: null,
        recoveryCommit: null,
        graceDeadlineAt: null,
        dirty: null,
        flushedAt: null,
        recoveredAt: null,
      },
    ]);
  });

  it("surfaces the human label from session metadata (and null when absent)", async () => {
    fake.enqueue([
      { ...ROW, metadata: { label: "acme-api refactor", memoryMb: 2048 } },
      { ...ROW, publicId: "sbx_2", metadata: { memoryMb: 2048 } },
      { ...ROW, publicId: "sbx_3", metadata: { label: "   " } },
    ]);

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    // Present, non-blank label surfaces verbatim; a missing or whitespace-only
    // label degrades to null (never leaks the raw metadata bag).
    expect(out.sandboxes.map((s) => s.label)).toEqual([
      "acme-api refactor",
      null,
      null,
    ]);
  });

  it("maps lifecycle & work-recovery fields, serializing timestamps to ISO", async () => {
    fake.enqueue([
      {
        ...ROW,
        status: "idle",
        dirty: true,
        recoveryStatus: "recovered",
        recoveryBranch: "recovery/conv_42/20260708T100000Z",
        recoveryCommit: "abc123",
        graceDeadlineAt: new Date("2026-07-08T10:03:00.000Z"),
        flushedAt: new Date("2026-07-08T10:05:00.000Z"),
        recoveredAt: new Date("2026-07-08T10:04:00.000Z"),
      },
    ]);

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes[0]).toMatchObject({
      recoveryStatus: "recovered",
      recoveryBranch: "recovery/conv_42/20260708T100000Z",
      recoveryCommit: "abc123",
      graceDeadlineAt: "2026-07-08T10:03:00.000Z",
      dirty: true,
      flushedAt: "2026-07-08T10:05:00.000Z",
      recoveredAt: "2026-07-08T10:04:00.000Z",
    });
  });

  it("serializes null lastUsedAt / expiresAt / sessionKey as null", async () => {
    fake.enqueue([
      {
        ...ROW,
        sessionKey: null,
        lastUsedAt: null,
        expiresAt: null,
      },
    ]);

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes[0]).toMatchObject({
      sessionKey: null,
      lastUsedAt: null,
      expiresAt: null,
      createdAt: "2026-07-08T09:00:00.000Z",
    });
  });

  it("returns an empty array when the workspace has no sessions", async () => {
    fake.enqueue([]);

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes).toEqual([]);
  });

  it("passes an optional status filter through without error", async () => {
    fake.enqueue([{ ...ROW, status: "idle" }]);

    const out = await agentSandboxListHandler(
      { status: "idle", limit: 10, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes).toHaveLength(1);
    expect(out.sandboxes[0]!.status).toBe("idle");
  });

  it("passes repos through from session metadata (omitted when absent)", async () => {
    fake.enqueue([
      {
        ...ROW,
        metadata: {
          repos: [
            { owner: "acme", repo: "api", branch: "main" },
            { owner: "acme", repo: "web" },
          ],
        },
      },
      { ...ROW, publicId: "sbx_2", metadata: {} },
    ]);

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes[0]!.repos).toEqual([
      { owner: "acme", repo: "api", branch: "main" },
      { owner: "acme", repo: "web" },
    ]);
    // No repos key at all when the session was started without any.
    expect(out.sandboxes[1]!.repos).toBeUndefined();
  });
});

describe("agent.sandbox.list live reconcile", () => {
  it("corrects a provider-dead running row to stopped and persists it", async () => {
    fake.enqueue([{ ...ROW, status: "running" }]);
    sb.isSandboxAvailable.mockReturnValue(true);
    sb.driver.sessionStatus.mockResolvedValue("gone");

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(sb.driver.sessionStatus).toHaveBeenCalledWith("sb-aaa");
    expect(out.sandboxes[0]!.status).toBe("stopped");
    // The correction is persisted (markSessionStatus issues one update).
    expect(fake.mutations.update).toBe(1);
  });

  it("resolves each session's own driver (vendor-neutral) during reconcile", async () => {
    fake.enqueue([{ ...ROW, status: "running", driver: "vercel" }]);
    sb.isSandboxAvailable.mockReturnValue(true);
    sb.driver.sessionStatus.mockResolvedValue("running");

    await agentSandboxListHandler({ limit: 50, activeOnly: false }, CTX);

    expect(sb.getSandbox).toHaveBeenCalledWith("vercel");
  });

  it("activeOnly drops a row the provider reports gone, keeps the live one", async () => {
    fake.enqueue([
      { ...ROW, publicId: "sbx_live", sandboxId: "sb-live", status: "running" },
      { ...ROW, publicId: "sbx_dead", sandboxId: "sb-dead", status: "idle" },
    ]);
    sb.isSandboxAvailable.mockReturnValue(true);
    sb.driver.sessionStatus.mockImplementation(async (id: string) =>
      id === "sb-dead" ? "gone" : "running",
    );

    const out = await agentSandboxListHandler(
      { activeOnly: true, limit: 50 },
      CTX,
    );

    expect(out.sandboxes.map((s) => s.sessionId)).toEqual(["sbx_live"]);
  });

  it("tolerates a driver error and leaves the row's status untouched", async () => {
    fake.enqueue([{ ...ROW, status: "running" }]);
    sb.isSandboxAvailable.mockReturnValue(true);
    sb.driver.sessionStatus.mockRejectedValue(new Error("provider down"));

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes[0]!.status).toBe("running");
    expect(fake.mutations.update).toBe(0); // no correction persisted
  });

  it("skips reconcile entirely when no durable driver is available", async () => {
    fake.enqueue([{ ...ROW, status: "running" }]);
    sb.isSandboxAvailable.mockReturnValue(false);

    const out = await agentSandboxListHandler(
      { limit: 50, activeOnly: false },
      CTX,
    );

    expect(out.sandboxes[0]!.status).toBe("running");
    expect(sb.driver.sessionStatus).not.toHaveBeenCalled();
  });
});
