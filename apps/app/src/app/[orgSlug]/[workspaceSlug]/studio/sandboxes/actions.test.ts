import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy server deps so the action's validation + IAM-gate logic runs in
// isolation. vi.mock is hoisted, so referenced fns come from vi.hoisted().
const {
  resolveStudioScope,
  startSandbox,
  runSandboxCommand,
  stopSandbox,
  isSandboxUnavailable,
} = vi.hoisted(() => ({
  resolveStudioScope: vi.fn(),
  startSandbox: vi.fn(),
  runSandboxCommand: vi.fn(),
  stopSandbox: vi.fn(),
  isSandboxUnavailable: vi.fn(() => false),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/studio/scope", () => ({ resolveStudioScope }));
vi.mock("@/lib/studio/sandboxes", () => ({
  startSandbox,
  runSandboxCommand,
  stopSandbox,
  isSandboxUnavailable,
}));

import {
  startSandboxAction,
  runSandboxCommandAction,
  stopSandboxAction,
} from "./actions";

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const CTX = {
  orgId: "o1",
  workspaceId: "w1",
  userId: "u1",
  apiKeyId: null,
  requestId: "r1",
  surface: "app" as const,
  messageId: null,
};

function scope(canManage: boolean) {
  return { ctx: CTX, canManage, session: {}, org: {}, ws: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  isSandboxUnavailable.mockReturnValue(false);
});

describe("startSandboxAction", () => {
  it("rejects invalid input", async () => {
    const res = await startSandboxAction({
      ...SCOPE,
      templateId: "",
    } as never);
    expect(res.ok).toBe(false);
    expect(resolveStudioScope).not.toHaveBeenCalled();
  });

  it("gates non-managers", async () => {
    resolveStudioScope.mockResolvedValue(scope(false));
    const res = await startSandboxAction({ ...SCOPE, templateId: "oxagen-agent" });
    expect(res.ok).toBe(false);
    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("warms a sandbox from the template's image + setupCmd", async () => {
    resolveStudioScope.mockResolvedValue(scope(true));
    startSandbox.mockResolvedValue({
      sessionId: "sbx_new",
      status: "running",
      image: "agent",
      createdAt: "2026-07-08T00:00:00.000Z",
      reused: false,
    });
    const res = await startSandboxAction({ ...SCOPE, templateId: "oxagen-agent" });
    expect(res.ok).toBe(true);
    expect(startSandbox).toHaveBeenCalledTimes(1);
    const [, arg] = startSandbox.mock.calls[0] as [
      unknown,
      { image?: string; setupCmd?: string; sessionKey?: string },
    ];
    expect(arg.image).toBe("agent");
    expect(typeof arg.setupCmd).toBe("string");
    expect(arg.setupCmd).toContain("git init");
    expect(arg.sessionKey).toBeTruthy();
  });

  it("passes an empty-setupCmd template as undefined setupCmd", async () => {
    resolveStudioScope.mockResolvedValue(scope(true));
    startSandbox.mockResolvedValue({ sessionId: "sbx_x", reused: false });
    await startSandboxAction({ ...SCOPE, templateId: "blank" });
    const [, arg] = startSandbox.mock.calls[0] as [
      unknown,
      { image?: string; setupCmd?: string; sessionKey?: string },
    ];
    expect(arg.setupCmd).toBeUndefined();
  });

  it("flags the unavailable-driver case", async () => {
    resolveStudioScope.mockResolvedValue(scope(true));
    startSandbox.mockRejectedValue(new Error("Durable sandbox not available"));
    isSandboxUnavailable.mockReturnValue(true);
    const res = await startSandboxAction({ ...SCOPE, templateId: "oxagen-agent" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unavailable).toBe(true);
  });
});

describe("runSandboxCommandAction", () => {
  it("gates non-managers", async () => {
    resolveStudioScope.mockResolvedValue(scope(false));
    const res = await runSandboxCommandAction({
      ...SCOPE,
      sessionId: "sbx_1",
      command: "ls",
    });
    expect(res.ok).toBe(false);
    expect(runSandboxCommand).not.toHaveBeenCalled();
  });

  it("returns the exec result on success", async () => {
    resolveStudioScope.mockResolvedValue(scope(true));
    runSandboxCommand.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      executionMs: 5,
      timedOut: false,
      restored: false,
    });
    const res = await runSandboxCommandAction({
      ...SCOPE,
      sessionId: "sbx_1",
      command: "ls",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.stdout).toBe("ok");
  });
});

describe("stopSandboxAction", () => {
  it("stops on success", async () => {
    resolveStudioScope.mockResolvedValue(scope(true));
    stopSandbox.mockResolvedValue({ stopped: true });
    const res = await stopSandboxAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.stopped).toBe(true);
  });

  it("gates non-managers", async () => {
    resolveStudioScope.mockResolvedValue(scope(false));
    const res = await stopSandboxAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(false);
    expect(stopSandbox).not.toHaveBeenCalled();
  });
});
