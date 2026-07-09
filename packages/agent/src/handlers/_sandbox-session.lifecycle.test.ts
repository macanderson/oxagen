import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Minimal mocks: only what _sandbox-session imports at runtime. Types are erased.
const mocks = vi.hoisted(() => ({
  captured: [] as { vals: Record<string, unknown> }[],
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: (fn: (tx: unknown) => unknown) =>
    fn({
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            mocks.captured.push({ vals });
            return Promise.resolve();
          },
        }),
      }),
    }),
  schema: {
    sandboxSessions: {
      id: "id",
      publicId: "public_id",
      workspaceId: "workspace_id",
      status: "status",
      deletedAt: "deleted_at",
    },
  },
}));

vi.mock("@oxagen/sandbox", () => ({
  getSandbox: vi.fn(),
  isSandboxAvailable: vi.fn().mockReturnValue(true),
  isDurableSandboxDriver: vi.fn().mockReturnValue(true),
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
  inArray: (c: unknown, v: unknown) => ({ inArray: [c, v] }),
  isNull: (c: unknown) => ({ isNull: c }),
}));

import {
  releaseSession,
  sandboxGraceSeconds,
  sandboxStaleRunningSeconds,
} from "./_sandbox-session";

const ctx = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("sandbox lifecycle config", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("defaults: grace 120s, stale-running 1800s", () => {
    delete process.env.SANDBOX_SESSION_GRACE_SECONDS;
    delete process.env.SANDBOX_SESSION_STALE_RUNNING_SECONDS;
    expect(sandboxGraceSeconds()).toBe(120);
    expect(sandboxStaleRunningSeconds()).toBe(1800);
  });

  it("reads env overrides, ignoring invalid values", () => {
    process.env.SANDBOX_SESSION_GRACE_SECONDS = "45";
    expect(sandboxGraceSeconds()).toBe(45);
    process.env.SANDBOX_SESSION_GRACE_SECONDS = "-5";
    expect(sandboxGraceSeconds()).toBe(120);
    process.env.SANDBOX_SESSION_GRACE_SECONDS = "notanumber";
    expect(sandboxGraceSeconds()).toBe(120);
  });
});

describe("releaseSession", () => {
  beforeEach(() => {
    mocks.captured = [];
    delete process.env.SANDBOX_SESSION_GRACE_SECONDS;
  });

  it("marks the session idle and sets the reap grace deadline ~grace in the future", async () => {
    const before = Date.now();
    await releaseSession(ctx, "sbx_1");
    const after = Date.now();

    expect(mocks.captured).toHaveLength(1);
    const vals = mocks.captured[0]!.vals;
    expect(vals.status).toBe("idle");
    expect(vals.updatedByUserId).toBe("user_1");
    expect(vals.lastUsedAt).toBeInstanceOf(Date);

    const deadline = vals.graceDeadlineAt as Date;
    expect(deadline).toBeInstanceOf(Date);
    // 120s default grace, allowing for the elapsed test window.
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(deadline.getTime()).toBeLessThanOrEqual(after + 120_000 + 50);
  });

  it("honors a shorter configured grace window", async () => {
    process.env.SANDBOX_SESSION_GRACE_SECONDS = "30";
    const before = Date.now();
    await releaseSession(ctx, "sbx_1");
    const deadline = mocks.captured[0]!.vals.graceDeadlineAt as Date;
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(deadline.getTime()).toBeLessThan(before + 60_000);
  });
});
