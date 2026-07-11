import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy server deps so the action's validation + IAM-gate logic runs in
// isolation. vi.mock is hoisted, so referenced fns come from vi.hoisted().
const { resolveWorkbenchScope, invoke, isSandboxUnavailable } = vi.hoisted(
  () => ({
    resolveWorkbenchScope: vi.fn(),
    invoke: vi.fn(),
    isSandboxUnavailable: vi.fn(() => false),
  }),
);

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke }));
vi.mock("@/lib/workbench/scope", () => ({ resolveWorkbenchScope }));
// Only isSandboxUnavailable is imported by the actions under test.
vi.mock("@/lib/workbench/sandboxes", () => ({ isSandboxUnavailable }));

import {
  listSandboxFilesAction,
  readSandboxFileAction,
  renameSandboxAction,
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

describe("listSandboxFilesAction", () => {
  it("rejects invalid input before touching scope", async () => {
    const res = await listSandboxFilesAction({ ...SCOPE, sessionId: "" });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await listSandboxFilesAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes list_sandbox_files with the scoped ctx + agent surface and returns entries", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    const entries = [
      { path: "src", kind: "dir" as const, sizeBytes: 0 },
      { path: "src/index.ts", kind: "file" as const, sizeBytes: 42 },
    ];
    invoke.mockResolvedValue({ entries });
    const res = await listSandboxFilesAction({
      ...SCOPE,
      sessionId: "sbx_1",
      path: "src",
      depth: 3,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entries).toEqual(entries);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [name, input, ctx, opts] = invoke.mock.calls[0] as [
      string,
      { sessionId: string; path?: string; depth?: number },
      unknown,
      { surface?: string },
    ];
    expect(name).toBe("list_sandbox_files");
    expect(input).toEqual({ sessionId: "sbx_1", path: "src", depth: 3 });
    expect(ctx).toBe(CTX);
    expect(opts.surface).toBe("agent");
  });

  it("defaults entries to [] when the capability returns none", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    invoke.mockResolvedValue({});
    const res = await listSandboxFilesAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entries).toEqual([]);
  });

  it("flags the unavailable-driver case", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    invoke.mockRejectedValue(new Error("Durable sandbox not available"));
    isSandboxUnavailable.mockReturnValue(true);
    const res = await listSandboxFilesAction({ ...SCOPE, sessionId: "sbx_1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unavailable).toBe(true);
  });
});

describe("readSandboxFileAction", () => {
  it("requires a path", async () => {
    const res = await readSandboxFileAction({
      ...SCOPE,
      sessionId: "sbx_1",
      path: "",
    });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
  });

  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await readSandboxFileAction({
      ...SCOPE,
      sessionId: "sbx_1",
      path: "src/index.ts",
    });
    expect(res.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes read_sandbox_file and returns the file payload", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    const file = {
      path: "src/index.ts",
      content: "export {}",
      encoding: "utf8" as const,
      sizeBytes: 9,
      truncated: false,
    };
    invoke.mockResolvedValue(file);
    const res = await readSandboxFileAction({
      ...SCOPE,
      sessionId: "sbx_1",
      path: "src/index.ts",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.file).toEqual(file);
    const [name, input] = invoke.mock.calls[0] as [
      string,
      { sessionId: string; path: string },
    ];
    expect(name).toBe("read_sandbox_file");
    expect(input.sessionId).toBe("sbx_1");
    expect(input.path).toBe("src/index.ts");
  });
});

describe("renameSandboxAction", () => {
  it("requires a non-empty label", async () => {
    const res = await renameSandboxAction({
      ...SCOPE,
      sessionId: "sbx_1",
      label: "   ",
    });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
  });

  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await renameSandboxAction({
      ...SCOPE,
      sessionId: "sbx_1",
      label: "New name",
    });
    expect(res.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes rename_sandbox with the trimmed label and returns it", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    invoke.mockResolvedValue({ sessionId: "sbx_1", label: "API refactor" });
    const res = await renameSandboxAction({
      ...SCOPE,
      sessionId: "sbx_1",
      label: "  API refactor  ",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.label).toBe("API refactor");
    const [name, input, , opts] = invoke.mock.calls[0] as [
      string,
      { sessionId: string; label: string },
      unknown,
      { surface?: string },
    ];
    expect(name).toBe("rename_sandbox");
    expect(input).toEqual({ sessionId: "sbx_1", label: "API refactor" });
    expect(opts.surface).toBe("agent");
  });

  it("falls back to the requested label when the capability omits it", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    invoke.mockResolvedValue({});
    const res = await renameSandboxAction({
      ...SCOPE,
      sessionId: "sbx_1",
      label: "Fallback",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.label).toBe("Fallback");
  });
});
