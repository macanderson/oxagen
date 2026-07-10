import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy server deps so the action's validation + IAM-gate logic runs in
// isolation. vi.mock is hoisted, so referenced fns come from vi.hoisted().
const {
  resolveWorkbenchScope,
  startSandbox,
  runSandboxCommand,
  stopSandbox,
  listSandboxLogs,
  isSandboxUnavailable,
} = vi.hoisted(() => ({
  resolveWorkbenchScope: vi.fn(),
  startSandbox: vi.fn(),
  runSandboxCommand: vi.fn(),
  stopSandbox: vi.fn(),
  listSandboxLogs: vi.fn(),
  isSandboxUnavailable: vi.fn(() => false),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/workbench/scope", () => ({ resolveWorkbenchScope }));
vi.mock("@/lib/workbench/sandboxes", () => ({
  startSandbox,
  runSandboxCommand,
  stopSandbox,
  listSandboxLogs,
  isSandboxUnavailable,
}));

import {
  startSandboxAction,
  runSandboxCommandAction,
  stopSandboxAction,
  listSandboxLogsAction,
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
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    const res = await startSandboxAction({
      ...SCOPE,
      name: "   ",
      templateId: "oxagen-agent",
    });
    expect(res.ok).toBe(false);
    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await startSandboxAction({
      ...SCOPE,
      name: "my box",
      templateId: "oxagen-agent",
    });
    expect(res.ok).toBe(false);
    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("warms a sandbox from the template's image + setupCmd, passing the label + a slug-seeded key", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    startSandbox.mockResolvedValue({
      sessionId: "sbx_new",
      status: "running",
      image: "agent",
      createdAt: "2026-07-08T00:00:00.000Z",
      reused: false,
    });
    const res = await startSandboxAction({
      ...SCOPE,
      name: "Acme API refactor",
      templateId: "oxagen-agent",
    });
    expect(res.ok).toBe(true);
    expect(startSandbox).toHaveBeenCalledTimes(1);
    const [, arg] = startSandbox.mock.calls[0] as [
      unknown,
      { image?: string; label?: string; setupCmd?: string; sessionKey?: string; sandboxTemplateId?: string },
    ];
    expect(arg.image).toBe("agent");
    expect(arg.label).toBe("Acme API refactor");
    expect(typeof arg.setupCmd).toBe("string");
    expect(arg.setupCmd).toContain("git init");
    expect(arg.sandboxTemplateId).toBeUndefined();
    // Key is seeded from the slugified name for readability, with a random suffix.
    expect(arg.sessionKey).toMatch(/^sbx_acme-api-refactor_[0-9a-f]{8}$/);
  });

  it("routes a saved-template id (sbx_…) to sandboxTemplateId, not an image", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    startSandbox.mockResolvedValue({ sessionId: "sbx_y", reused: false });
    await startSandboxAction({ ...SCOPE, name: "eval box", templateId: "sbx_tmpl123" });
    const [, arg] = startSandbox.mock.calls[0] as [
      unknown,
      { image?: string; setupCmd?: string; sandboxTemplateId?: string; label?: string },
    ];
    expect(arg.sandboxTemplateId).toBe("sbx_tmpl123");
    expect(arg.label).toBe("eval box");
    expect(arg.image).toBeUndefined();
    expect(arg.setupCmd).toBeUndefined();
  });

  it("passes an empty-setupCmd template as undefined setupCmd", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    startSandbox.mockResolvedValue({ sessionId: "sbx_x", reused: false });
    await startSandboxAction({ ...SCOPE, name: "blank box", templateId: "blank" });
    const [, arg] = startSandbox.mock.calls[0] as [
      unknown,
      { image?: string; setupCmd?: string; sessionKey?: string },
    ];
    expect(arg.setupCmd).toBeUndefined();
  });

  it("flags the unavailable-driver case", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    startSandbox.mockRejectedValue(new Error("Durable sandbox not available"));
    isSandboxUnavailable.mockReturnValue(true);
    const res = await startSandboxAction({
      ...SCOPE,
      name: "my box",
      templateId: "oxagen-agent",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unavailable).toBe(true);
  });
});

describe("runSandboxCommandAction", () => {
  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await runSandboxCommandAction({
      ...SCOPE,
      sessionId: "sbx_1",
      command: "ls",
    });
    expect(res.ok).toBe(false);
    expect(runSandboxCommand).not.toHaveBeenCalled();
  });

  it("returns the exec result on success", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
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

describe("listSandboxLogsAction", () => {
  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await listSandboxLogsAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(false);
    expect(listSandboxLogs).not.toHaveBeenCalled();
  });

  it("rejects an invalid level", async () => {
    const res = await listSandboxLogsAction({
      ...SCOPE,
      sessionId: "sbx_1",
      level: "loud",
    } as never);
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
  });

  it("returns lines and forwards the requested level", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    const line = {
      ts: "2026-07-10T00:00:00.000Z",
      stream: "stdout" as const,
      level: "normal" as const,
      command: "echo hi",
      seq: 1,
      line: "hi",
      exitCode: null,
      durationMs: null,
    };
    listSandboxLogs.mockResolvedValue([line]);
    const res = await listSandboxLogsAction({
      ...SCOPE,
      sessionId: "sbx_1",
      level: "normal",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.lines).toEqual([line]);
    const [, arg] = listSandboxLogs.mock.calls[0] as [
      unknown,
      { sessionId: string; level?: string },
    ];
    expect(arg.sessionId).toBe("sbx_1");
    expect(arg.level).toBe("normal");
  });

  it("flags the unavailable-driver case", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    listSandboxLogs.mockRejectedValue(new Error("Durable sandbox not available"));
    isSandboxUnavailable.mockReturnValue(true);
    const res = await listSandboxLogsAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unavailable).toBe(true);
  });
});

describe("stopSandboxAction", () => {
  it("stops on success", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    stopSandbox.mockResolvedValue({ stopped: true });
    const res = await stopSandboxAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.stopped).toBe(true);
  });

  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await stopSandboxAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(false);
    expect(stopSandbox).not.toHaveBeenCalled();
  });
});
