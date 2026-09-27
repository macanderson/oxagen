// The `pause_workspace_runs` MCP tool (#3862): it names the contract, marks
// itself destructive and not idempotent, builds the context once, invokes the
// capability on the mcp surface with the reason alone, and parses the receipt.
// A missing reason, or an argument that names a workspace, is refused before
// the kernel runs.
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import pauseWorkspaceRunsTool, {
  metadata,
  schema,
} from "./tacho.workspace_runs.pause";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const RECEIPT = {
  queued: 1,
  commandIds: ["tcm_1"],
  skipped: [
    {
      runId: "tse_0123456789abcdefghjkmn",
      agentKey: "acme.core.cc-laptop",
      reason: "host_offline",
      commandId: "tcm_2",
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("pause_workspace_runs MCP tool", () => {
  it("names the contract and marks the call destructive and not idempotent", () => {
    expect(metadata.name).toBe("pause_workspace_runs");
    expect(metadata.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(Object.keys(schema)).toEqual(["reason"]);
  });

  it("invokes pause_workspace_runs on the mcp surface with the reason and returns the receipt", async () => {
    mocks.invoke.mockResolvedValue(RECEIPT);
    const out = await pauseWorkspaceRunsTool({ reason: "Incident 42" });
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "pause_workspace_runs",
      { reason: "Incident 42" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(out).toEqual(RECEIPT);
  });

  it("refuses a call with no reason before the kernel runs (negative)", async () => {
    await expect(
      pauseWorkspaceRunsTool({} as { reason: string }),
    ).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses an argument that names a workspace, since the scope is the caller's (negative)", async () => {
    await expect(
      pauseWorkspaceRunsTool({
        reason: "Incident 42",
        workspaceId: "other",
      } as { reason: string }),
    ).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("propagates a refusal from the kernel (negative)", async () => {
    mocks.invoke.mockRejectedValue(new Error("org_role_required"));
    await expect(
      pauseWorkspaceRunsTool({ reason: "Incident 42" }),
    ).rejects.toThrow("org_role_required");
  });
});
