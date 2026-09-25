// Loading the finished reply of a turn whose stream dropped, through the real
// kernel seam: the viewer resolution and the kernel's invoke() are the only
// fakes, so each case shows what the flyout gets back and what
// get_assistant_reply was asked.
//
// The read is workspace-scoped, because a turn and its reply belong to the
// workspace the question was asked in, so the viewer this action resolves is
// a WsCtx.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readAssistantReply } = await import("./assistant-actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const RUN = "arun_01k9";
const CONVERSATION = "6f1f5a8e-0000-4000-8000-00000000c0de";

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("readAssistantReply", () => {
  it("resolves the viewer of the workspace the question was asked in, and asks for the run", async () => {
    invoke.mockResolvedValue({ runId: RUN, runStatus: "running", reply: null });
    await readAssistantReply("acme", "core-platform", RUN);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "get_assistant_reply",
      { runId: RUN },
      expect.objectContaining({ workspaceId: ctx.workspaceId }),
    );
  });

  it("answers the saved reply and the conversation it continues", async () => {
    invoke.mockResolvedValue({
      runId: RUN,
      runStatus: "completed",
      reply: { conversationId: CONVERSATION, text: "Three runs are live." },
    });
    await expect(
      readAssistantReply("acme", "core-platform", RUN),
    ).resolves.toEqual({
      ok: true,
      value: {
        state: "answered",
        conversationId: CONVERSATION,
        reply: "Three runs are live.",
      },
    });
  });

  it.each(["pending", "running", "completed"])(
    "reads a run that is %s with no reply saved as still running",
    async (runStatus) => {
      invoke.mockResolvedValue({ runId: RUN, runStatus, reply: null });
      await expect(
        readAssistantReply("acme", "core-platform", RUN),
      ).resolves.toEqual({ ok: true, value: { state: "running" } });
    },
  );

  it.each(["failed", "cancelled"])(
    "reads a run that %s with no reply as ended (negative)",
    async (runStatus) => {
      invoke.mockResolvedValue({ runId: RUN, runStatus, reply: null });
      await expect(
        readAssistantReply("acme", "core-platform", RUN),
      ).resolves.toEqual({ ok: true, value: { state: "ended" } });
    },
  );

  it("answers not_found with its reason for a run the handler does not hold (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "not_found", reason: "run_not_found" }),
    );
    await expect(
      readAssistantReply("acme", "core-platform", RUN),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
      code: "run_not_found",
    });
  });

  it("answers denied when the handler refuses the person's role (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    await expect(
      readAssistantReply("acme", "core-platform", RUN),
    ).resolves.toMatchObject({ ok: false, reason: "denied" });
  });
});
