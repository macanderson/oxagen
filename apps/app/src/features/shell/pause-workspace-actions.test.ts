// ⌘K's pause: one `pause_workspace_runs` write on the viewer the URL
// resolves, with the trimmed reason and nothing that names a workspace; an
// empty or overlong reason refused before the kernel runs; and a refusal
// returned as the action's own.
import { COMMAND_REASON_MAX } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { pauseWorkspaceRuns } from "@oxagen/oxagen/contracts/tacho.workspace_runs.pause";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelWrite, requireViewer } = vi.hoisted(() => ({
  kernelWrite: vi.fn(),
  requireViewer: vi.fn(),
}));
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelWrite,
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));

const { pauseWorkspaceRunsAction } = await import("./pause-workspace-actions");

const ctx = { orgSlug: "acme", wsSlug: "core-platform" };

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
  kernelWrite.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("pauseWorkspaceRunsAction", () => {
  it("writes pause_workspace_runs on the viewer the URL resolves with the trimmed reason, and returns the receipt", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: RECEIPT });
    expect(
      await pauseWorkspaceRunsAction("acme", "core-platform", "  Incident 42 "),
    ).toEqual({ ok: true, value: RECEIPT });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(ctx, pauseWorkspaceRuns, {
      reason: "Incident 42",
    });
  });

  it("refuses an empty reason before the kernel runs (negative)", async () => {
    expect(
      await pauseWorkspaceRunsAction("acme", "core-platform", "   "),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "pause_reason_required",
      field: "reason",
    });
    expect(kernelWrite).not.toHaveBeenCalled();
  });

  it("refuses a reason past the command limit before the kernel runs (negative)", async () => {
    const long = "x".repeat(COMMAND_REASON_MAX + 1);
    expect(
      await pauseWorkspaceRunsAction("acme", "core-platform", long),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    });
    expect(kernelWrite).not.toHaveBeenCalled();
  });

  it("returns the handler's refusal as the action's own (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      code: "org_role_required",
    };
    kernelWrite.mockResolvedValue(denied);
    expect(
      await pauseWorkspaceRunsAction("acme", "core-platform", "Incident 42"),
    ).toEqual(denied);
  });
});
