import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the exec primitive and the gone-error class (a real subclass so the
// module's `instanceof` check works). We do NOT pull in the full
// _sandbox-session dependency chain — recover-sandbox-session only needs the
// error class from it.
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
}));

vi.mock("./agent.sandbox.exec", () => ({
  agentSandboxExecHandler: mocks.exec,
}));
vi.mock("./_sandbox-session", () => {
  class SandboxSessionGoneError extends Error {
    readonly code = "sandbox_session_gone";
  }
  return { SandboxSessionGoneError };
});

import {
  recoverSandboxSession,
  recoveryLabel,
} from "./recover-sandbox-session";
import { SandboxSessionGoneError } from "./_sandbox-session";

const ctx = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: null,
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

function execReturns(stdout: string, opts: { timedOut?: boolean } = {}) {
  mocks.exec.mockResolvedValueOnce({
    exitCode: 0,
    stdout,
    stderr: "",
    executionMs: 5,
    timedOut: opts.timedOut ?? false,
    restored: false,
  });
}

describe("recoveryLabel", () => {
  it("sanitizes a public id to a filesystem-safe branch label", () => {
    expect(recoveryLabel("sbx_AbC.123!!")).toBe("sbx-abc-123");
  });
  it("caps length and falls back for an empty id", () => {
    expect(recoveryLabel("").length).toBeGreaterThan(0);
    expect(recoveryLabel("x".repeat(80)).length).toBeLessThanOrEqual(24);
  });
});

describe("recoverSandboxSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clean tree → kind 'clean', not dirty, no branch", async () => {
    execReturns("OXA_CLEAN\n");
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out).toEqual({ kind: "clean", dirty: false });
  });

  it("non-git sandbox → kind 'no-repo' (safe to flush)", async () => {
    execReturns("OXA_NO_GIT\n");
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("no-repo");
    expect(out.dirty).toBe(false);
  });

  it("dirty tree pushed → kind 'recovered' with branch + commit", async () => {
    execReturns(
      "OXA_DIRTY\nOXA_BRANCH=recovery/sbx-1/20260717T000000Z\nOXA_COMMIT=deadbeef\nOXA_PUSHED\n",
    );
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("recovered");
    expect(out.dirty).toBe(true);
    expect(out.branch).toBe("recovery/sbx-1/20260717T000000Z");
    expect(out.commit).toBe("deadbeef");
  });

  it("dirty but no remote → kind 'failed' (RETAIN, never lose work)", async () => {
    execReturns("OXA_DIRTY\nOXA_NO_ORIGIN\n");
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("failed");
    expect(out.dirty).toBe(true);
    expect(out.error).toMatch(/remote/i);
  });

  it("dirty but push failed → kind 'failed' (RETAIN)", async () => {
    execReturns("OXA_DIRTY\nOXA_PUSH_FAIL\nremote: permission denied\n");
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("failed");
    expect(out.dirty).toBe(true);
    expect(out.error).toMatch(/push failed/i);
  });

  it("commit failed → kind 'failed' (RETAIN)", async () => {
    execReturns("OXA_DIRTY\nOXA_COMMIT_FAIL\n");
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("failed");
  });

  it("dirty with no conclusive marker → kind 'failed' (conservative RETAIN)", async () => {
    execReturns("OXA_DIRTY\n");
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("failed");
  });

  it("timed out → kind 'failed'", async () => {
    execReturns("", { timedOut: true });
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("failed");
    expect(out.error).toMatch(/timed out/i);
  });

  it("sandbox reaped mid-recovery → kind 'gone' (flushable, work already lost)", async () => {
    mocks.exec.mockRejectedValueOnce(new SandboxSessionGoneError("sbx_1"));
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("gone");
  });

  it("unexpected exec error → kind 'failed' (RETAIN)", async () => {
    mocks.exec.mockRejectedValueOnce(new Error("network blip"));
    const out = await recoverSandboxSession(ctx, { sessionId: "sbx_1" });
    expect(out.kind).toBe("failed");
    expect(out.error).toMatch(/network blip/);
  });

  it("passes the sanitized label as OXA_LABEL env", async () => {
    execReturns("OXA_CLEAN\n");
    await recoverSandboxSession(ctx, { sessionId: "sbx_Foo.Bar" });
    expect(mocks.exec).toHaveBeenCalledWith(
      expect.objectContaining({ env: { OXA_LABEL: "sbx-foo-bar" } }),
      ctx,
    );
  });
});
