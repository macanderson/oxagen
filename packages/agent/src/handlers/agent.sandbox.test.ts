import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// A fully-stubbed durable driver; isDurableSandboxDriver() is mocked to accept
// it so requireDurableDriver() narrows without the real capability check.
const h = vi.hoisted(() => {
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
    isSandboxAvailable: vi.fn(() => true),
    isDurableSandboxDriver: vi.fn(() => true),
    insertEvents: vi.fn(async (..._args: unknown[]) => undefined),
  };
});

vi.mock("@oxagen/sandbox", () => ({
  getSandbox: h.getSandbox,
  isSandboxAvailable: h.isSandboxAvailable,
  isDurableSandboxDriver: h.isDurableSandboxDriver,
}));

vi.mock("@oxagen/telemetry", () => ({ insertEvents: h.insertEvents }));

const fake = createFakeTx();
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { agentSandboxStartHandler } from "./agent.sandbox.start";
import { agentSandboxExecHandler } from "./agent.sandbox.exec";
import { agentSandboxSnapshotHandler } from "./agent.sandbox.snapshot";
import { agentSandboxStopHandler } from "./agent.sandbox.stop";

const ROW = {
  id: "uuid-1",
  publicId: "sbx_1",
  sandboxId: "sb-aaa",
  snapshotId: null as string | null,
  image: "agent",
  status: "running",
  metadata: {
    memoryMb: 2048,
    ttlSeconds: 86_400,
    idleTimeoutSeconds: 1_200,
    network: "allow",
  },
};

beforeEach(() => {
  fake.reset();
  h.getSandbox.mockClear();
  h.isSandboxAvailable.mockReturnValue(true);
  h.isDurableSandboxDriver.mockReturnValue(true);
  for (const fn of [
    h.driver.createSession,
    h.driver.execInSession,
    h.driver.snapshotSession,
    h.driver.restoreSession,
    h.driver.stopSession,
    h.driver.sessionStatus,
  ]) {
    fn.mockReset();
  }
  h.insertEvents.mockReset();
  h.insertEvents.mockResolvedValue(undefined);
});

describe("agent.sandbox.start handler", () => {
  it("provisions a fresh session when no sessionKey is given", async () => {
    h.driver.createSession.mockResolvedValue({
      sandboxId: "sb-new",
      status: "running",
      createdAt: "2026-06-28T00:00:00.000Z",
    });
    fake.enqueue([{ publicId: "sbx_new" }]); // insertSession().returning()

    const out = await agentSandboxStartHandler(
      {
        image: "agent",
        memoryMb: 2048,
        ttlSeconds: 86_400,
        idleTimeoutSeconds: 1_200,
        network: "allow",
      },
      CTX,
    );

    expect(out).toEqual({
      sessionId: "sbx_new",
      status: "running",
      image: "agent",
      createdAt: "2026-06-28T00:00:00.000Z",
      reused: false,
    });
    expect(h.driver.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "agent",
        orgId: "org_1",
        workspaceId: "ws_1",
      }),
    );
  });

  it("reuses a warm session for a known sessionKey", async () => {
    fake.enqueue([{ ...ROW }]); // findReusableSession
    h.driver.sessionStatus.mockResolvedValue("running");

    const out = await agentSandboxStartHandler(
      {
        image: "agent",
        sessionKey: "conv_1",
        memoryMb: 2048,
        ttlSeconds: 86_400,
        idleTimeoutSeconds: 1_200,
        network: "allow",
      },
      CTX,
    );

    expect(out.sessionId).toBe("sbx_1");
    expect(out.reused).toBe(true);
    expect(h.driver.createSession).not.toHaveBeenCalled();
    expect(h.driver.sessionStatus).toHaveBeenCalledWith("sb-aaa");
  });

  it("restores from snapshot when the reused session was reaped", async () => {
    fake.enqueue([{ ...ROW, snapshotId: "img-9" }]); // findReusableSession
    h.driver.sessionStatus.mockResolvedValue("gone");
    h.driver.restoreSession.mockResolvedValue({
      sandboxId: "sb-restored",
      status: "running",
      createdAt: "2026-06-28T01:00:00.000Z",
    });

    const out = await agentSandboxStartHandler(
      {
        image: "agent",
        sessionKey: "conv_1",
        memoryMb: 2048,
        ttlSeconds: 86_400,
        idleTimeoutSeconds: 1_200,
        network: "allow",
      },
      CTX,
    );

    expect(out.reused).toBe(true);
    expect(h.driver.restoreSession).toHaveBeenCalledWith(
      "img-9",
      expect.objectContaining({ image: "agent" }),
    );
    expect(h.driver.createSession).not.toHaveBeenCalled();
  });

  it("provisions fresh when the reaped session has no snapshot", async () => {
    h.driver.sessionStatus.mockResolvedValue("gone");
    h.driver.createSession.mockResolvedValue({
      sandboxId: "sb-fresh",
      status: "running",
      createdAt: "2026-06-28T02:00:00.000Z",
    });
    // Queue order matches query order: findReusableSession → markSessionStatus
    // (update consumes a slot) → insertSession.returning().
    fake.enqueue(
      [{ ...ROW, snapshotId: null }],
      [],
      [{ publicId: "sbx_fresh" }],
    );

    const out = await agentSandboxStartHandler(
      {
        image: "agent",
        sessionKey: "conv_1",
        memoryMb: 2048,
        ttlSeconds: 86_400,
        idleTimeoutSeconds: 1_200,
        network: "allow",
      },
      CTX,
    );

    expect(h.driver.createSession).toHaveBeenCalled();
    expect(out.reused).toBe(false);
    expect(out.sessionId).toBe("sbx_fresh");
  });

  it("throws when no durable driver is available", async () => {
    h.isDurableSandboxDriver.mockReturnValue(false);
    await expect(
      agentSandboxStartHandler(
        {
          image: "agent",
          memoryMb: 2048,
          ttlSeconds: 86_400,
          idleTimeoutSeconds: 1_200,
          network: "allow",
        },
        CTX,
      ),
    ).rejects.toThrow(/Durable sandbox sessions are not available/);
  });
});

describe("agent.sandbox.exec handler", () => {
  it("runs a command and meters the run", async () => {
    fake.enqueue([{ ...ROW }]); // getSessionByPublicId
    h.driver.execInSession.mockResolvedValue({
      exitCode: 0,
      stdout: "done\n",
      stderr: "",
      durationMs: 99,
      timedOut: false,
      gone: false,
    });

    const out = await agentSandboxExecHandler(
      { sessionId: "sbx_1", command: "pnpm build", timeoutMs: 120_000 },
      CTX,
    );

    expect(out).toEqual({
      exitCode: 0,
      stdout: "done\n",
      stderr: "",
      executionMs: 99,
      timedOut: false,
      restored: false,
      cwd: null,
    });
    expect(h.driver.execInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sb-aaa", command: "pnpm build" }),
    );
    expect(h.insertEvents).toHaveBeenCalledTimes(1);
    const rows = h.insertEvents.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]!.event_type).toBe("agent.sandbox.exec.ran");
  });

  it("restores from snapshot and retries when the sandbox was reaped", async () => {
    fake.enqueue([{ ...ROW, snapshotId: "img-7" }]); // getSessionByPublicId
    h.driver.execInSession
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
        gone: true,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 50,
        timedOut: false,
        gone: false,
      });
    h.driver.restoreSession.mockResolvedValue({
      sandboxId: "sb-restored",
      status: "running",
      createdAt: "2026-06-28T03:00:00.000Z",
    });

    const out = await agentSandboxExecHandler(
      { sessionId: "sbx_1", command: "ls", timeoutMs: 120_000 },
      CTX,
    );

    expect(out.restored).toBe(true);
    expect(out.stdout).toBe("ok");
    expect(h.driver.restoreSession).toHaveBeenCalledWith(
      "img-7",
      expect.any(Object),
    );
    expect(h.driver.execInSession).toHaveBeenCalledTimes(2);
  });

  it("throws SandboxSessionGoneError when reaped with no snapshot", async () => {
    fake.enqueue([{ ...ROW, snapshotId: null }]); // getSessionByPublicId
    h.driver.execInSession.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      gone: true,
    });

    await expect(
      agentSandboxExecHandler(
        { sessionId: "sbx_1", command: "ls", timeoutMs: 120_000 },
        CTX,
      ),
    ).rejects.toThrow(/was reaped and has no snapshot/);
  });

  it("throws SandboxSessionNotFoundError for an unknown session", async () => {
    fake.enqueue([]); // getSessionByPublicId → empty

    await expect(
      agentSandboxExecHandler(
        { sessionId: "sbx_missing", command: "ls", timeoutMs: 120_000 },
        CTX,
      ),
    ).rejects.toThrow(/was not found in this workspace/);
  });

  it("never fails a run when telemetry throws", async () => {
    fake.enqueue([{ ...ROW }]);
    h.driver.execInSession.mockResolvedValue({
      exitCode: 0,
      stdout: "x",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      gone: false,
    });
    h.insertEvents.mockRejectedValueOnce(new Error("clickhouse down"));

    const out = await agentSandboxExecHandler(
      { sessionId: "sbx_1", command: "x", timeoutMs: 1_000 },
      CTX,
    );
    expect(out.exitCode).toBe(0);
  });
});

describe("agent.sandbox.snapshot handler", () => {
  it("snapshots and records the snapshot id", async () => {
    fake.enqueue([{ ...ROW }]); // getSessionByPublicId
    h.driver.snapshotSession.mockResolvedValue({ snapshotId: "img-42" });

    const out = await agentSandboxSnapshotHandler({ sessionId: "sbx_1" }, CTX);

    expect(out.snapshotId).toBe("img-42");
    expect(h.driver.snapshotSession).toHaveBeenCalledWith("sb-aaa");
  });

  it("throws for an unknown session", async () => {
    fake.enqueue([]);
    await expect(
      agentSandboxSnapshotHandler({ sessionId: "sbx_x" }, CTX),
    ).rejects.toThrow(/was not found/);
  });
});

describe("agent.sandbox.stop handler", () => {
  it("terminates and marks the session stopped", async () => {
    fake.enqueue([{ ...ROW }]); // getSessionByPublicId
    h.driver.stopSession.mockResolvedValue(undefined);

    const out = await agentSandboxStopHandler({ sessionId: "sbx_1" }, CTX);

    expect(out.stopped).toBe(true);
    expect(h.driver.stopSession).toHaveBeenCalledWith("sb-aaa");
  });

  it("is idempotent for an already-stopped session", async () => {
    fake.enqueue([{ ...ROW, status: "stopped" }]);

    const out = await agentSandboxStopHandler({ sessionId: "sbx_1" }, CTX);
    expect(out.stopped).toBe(true);
    expect(h.driver.stopSession).not.toHaveBeenCalled();
  });

  it("still retires the row when terminate throws", async () => {
    fake.enqueue([{ ...ROW }]);
    h.driver.stopSession.mockRejectedValue(new Error("already gone"));

    const out = await agentSandboxStopHandler({ sessionId: "sbx_1" }, CTX);
    expect(out.stopped).toBe(true);
  });

  it("retires the row without a provider call when no durable driver is available", async () => {
    fake.enqueue([{ ...ROW }]);
    // No sandbox driver configured → resolveSessionDriver returns null.
    h.isSandboxAvailable.mockReturnValue(false);

    const out = await agentSandboxStopHandler({ sessionId: "sbx_1" }, CTX);

    expect(out.stopped).toBe(true);
    expect(h.driver.stopSession).not.toHaveBeenCalled();
    // The registry row is still retired — markSessionStatus issues one update.
    expect(fake.mutations.update).toBe(1);
  });

  it("resolves the driver from the session's own driver column", async () => {
    fake.enqueue([{ ...ROW, driver: "vercel" }]);
    h.driver.stopSession.mockResolvedValue(undefined);

    await agentSandboxStopHandler({ sessionId: "sbx_1" }, CTX);

    // Vendor neutrality: the session's provider is torn down, not the default.
    expect(h.getSandbox).toHaveBeenCalledWith("vercel");
    expect(h.driver.stopSession).toHaveBeenCalledWith("sb-aaa");
  });
});
