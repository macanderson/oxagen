import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  insertEvents: vi.fn().mockResolvedValue(undefined),
  runInTenantScope: vi.fn(),
  recoverSandboxSession: vi.fn(),
  agentSandboxStopHandler: vi.fn().mockResolvedValue({ stopped: true }),
  sandboxStaleRunningSeconds: vi.fn().mockReturnValue(1800),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // Per-test canned data + captured writes.
  candidates: [] as unknown[],
  recheck: [] as unknown[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: { sandboxSessions: { id: "id_col" } },
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  });
  return { ...actual, sql, eq: (col: unknown, val: unknown) => ({ col, val }) };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: mocks.insertEvents }));
vi.mock("@oxagen/agent", () => ({
  recoverSandboxSession: mocks.recoverSandboxSession,
  agentSandboxStopHandler: mocks.agentSandboxStopHandler,
  sandboxStaleRunningSeconds: mocks.sandboxStaleRunningSeconds,
}));
vi.mock("../logger", () => ({ logger: mocks.logger }));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};
type HandlerFn = (ctx: { step: StepCtx }) => Promise<unknown>;

let reapHandler: HandlerFn | null = null;
mocks.createFunction.mockImplementation(
  (opts: { id: string }, _trigger: unknown, handler: HandlerFn) => {
    if (opts.id === "agent.sandbox-reaper") reapHandler = handler;
    return [{}];
  },
);

await import("./agent.sandbox-reaper");

// ── Fakes ─────────────────────────────────────────────────────────────────────
function makeTx() {
  return {
    execute: vi.fn().mockImplementation((q: { text: string }) => {
      if (q.text.includes("FOR UPDATE SKIP LOCKED"))
        return Promise.resolve(mocks.candidates);
      if (q.text.includes("grace_past")) return Promise.resolve(mocks.recheck);
      return Promise.resolve([]);
    }),
    update: vi.fn().mockImplementation(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          mocks.updates.push(vals);
          return Promise.resolve();
        },
      }),
    })),
  };
}

const step: StepCtx = { run: (_name, fn) => fn() };

function candidate(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "uuid-1",
    public_id: "sbx_1",
    org_id: "org_1",
    workspace_id: "ws_1",
    status: "idle",
    ...over,
  };
}

async function runReaper() {
  await reapHandler!({ step });
}

describe("agent.sandbox-reaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidates = [];
    mocks.recheck = [{ status: "idle", grace_past: true, stale: false }];
    mocks.updates = [];
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTx()),
    );
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
    mocks.agentSandboxStopHandler.mockResolvedValue({ stopped: true });
  });

  it("no candidates → no recovery, no flush", async () => {
    mocks.candidates = [];
    await runReaper();
    expect(mocks.recoverSandboxSession).not.toHaveBeenCalled();
    expect(mocks.agentSandboxStopHandler).not.toHaveBeenCalled();
  });

  it("recovered dirty session → terminated AND marked flushed+recovered", async () => {
    mocks.candidates = [candidate()];
    mocks.recoverSandboxSession.mockResolvedValue({
      kind: "recovered",
      dirty: true,
      branch: "recovery/sbx-1/ts",
      commit: "abc123",
    });
    await runReaper();

    expect(mocks.agentSandboxStopHandler).toHaveBeenCalledTimes(1);
    const flushWrite = mocks.updates.find((u) => "flushedAt" in u);
    expect(flushWrite).toBeDefined();
    expect(flushWrite!.recoveryStatus).toBe("recovered");
    expect(flushWrite!.recoveryBranch).toBe("recovery/sbx-1/ts");
    expect(flushWrite!.recoveryCommit).toBe("abc123");
  });

  it("INVARIANT: dirty work that could not be pushed → RETAINED, never flushed", async () => {
    mocks.candidates = [candidate()];
    mocks.recoverSandboxSession.mockResolvedValue({
      kind: "failed",
      dirty: true,
      error: "no git remote to push recovery branch to",
    });
    await runReaper();

    // The sandbox must NOT be terminated and the row must NOT be flushed.
    expect(mocks.agentSandboxStopHandler).not.toHaveBeenCalled();
    expect(mocks.updates.some((u) => "flushedAt" in u)).toBe(false);
    const failWrite = mocks.updates.find((u) => u.recoveryStatus === "failed");
    expect(failWrite).toBeDefined();
    expect(failWrite!.recoveryError).toMatch(/remote/i);
    expect(failWrite!.dirty).toBe(true);
  });

  it("clean session → terminated AND marked flushed with recovery_status 'none'", async () => {
    mocks.candidates = [candidate()];
    mocks.recoverSandboxSession.mockResolvedValue({
      kind: "clean",
      dirty: false,
    });
    await runReaper();

    expect(mocks.agentSandboxStopHandler).toHaveBeenCalledTimes(1);
    const flushWrite = mocks.updates.find((u) => "flushedAt" in u);
    expect(flushWrite!.recoveryStatus).toBe("none");
    expect(flushWrite!.recoveryBranch).toBeNull();
  });

  it("gone session → flushed (dead sandbox) with recovery_status 'failed'", async () => {
    mocks.candidates = [candidate()];
    mocks.recoverSandboxSession.mockResolvedValue({
      kind: "gone",
      dirty: null,
      error: "sandbox gone before recovery",
    });
    await runReaper();

    expect(mocks.agentSandboxStopHandler).toHaveBeenCalledTimes(1);
    const flushWrite = mocks.updates.find((u) => "flushedAt" in u);
    expect(flushWrite).toBeDefined();
    expect(flushWrite!.recoveryStatus).toBe("failed");
  });

  it("flush writes terminal state itself: status stopped + soft-deleted", async () => {
    mocks.candidates = [candidate()];
    mocks.recoverSandboxSession.mockResolvedValue({
      kind: "clean",
      dirty: false,
    });
    await runReaper();

    const flushWrite = mocks.updates.find((u) => "flushedAt" in u);
    expect(flushWrite).toBeDefined();
    expect(flushWrite!.status).toBe("stopped");
    expect(flushWrite!.deletedAt).toBeInstanceOf(Date);
  });

  it("flush RETIRES the row even when terminate throws (no lingering idle/running)", async () => {
    mocks.candidates = [candidate()];
    mocks.recoverSandboxSession.mockResolvedValue({
      kind: "clean",
      dirty: false,
    });
    // The best-effort stop throws (e.g. no durable driver configured) — the
    // reaper must still write terminal state so the sandbox never lingers.
    mocks.agentSandboxStopHandler.mockRejectedValue(
      new Error("no durable driver"),
    );
    await runReaper();

    const flushWrite = mocks.updates.find((u) => "flushedAt" in u);
    expect(flushWrite).toBeDefined();
    expect(flushWrite!.status).toBe("stopped");
    expect(flushWrite!.deletedAt).toBeInstanceOf(Date);
    expect(flushWrite!.recoveryStatus).toBe("none");
  });

  it("race guard: a resumed session (no longer a candidate) is skipped", async () => {
    mocks.candidates = [candidate()];
    mocks.recheck = [{ status: "running", grace_past: false, stale: false }];
    await runReaper();

    expect(mocks.recoverSandboxSession).not.toHaveBeenCalled();
    expect(mocks.agentSandboxStopHandler).not.toHaveBeenCalled();
  });

  it("recovery throwing is treated as failed → RETAIN", async () => {
    mocks.candidates = [candidate()];
    mocks.recoverSandboxSession.mockRejectedValue(new Error("boom"));
    await runReaper();

    expect(mocks.agentSandboxStopHandler).not.toHaveBeenCalled();
    expect(mocks.updates.some((u) => "flushedAt" in u)).toBe(false);
    expect(mocks.updates.some((u) => u.recoveryStatus === "failed")).toBe(true);
  });
});
