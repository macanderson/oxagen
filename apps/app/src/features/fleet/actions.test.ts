// The Fleet row command through the real kernel seam: the viewer resolution
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether the capability ran (INV-19).
//
// Three rules the tests hold it to, because breaking any of them would let a
// row claim more than the control plane did: the command carries this run as
// its target and nothing wider, a command outside the three a row sends is
// refused before the kernel, and no payload is ever attached, which
// `dispatch_command` refuses on pause, resume and cancel.
import { COMMAND_REASON_MAX } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
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
const { dispatchRunCommand } = await import("./actions");

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

const RUN = "tse_7k2m9q";
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("dispatchRunCommand", () => {
  it.each(["pause", "resume", "cancel"] as const)(
    "queues a %s against this run alone and answers the command ids",
    async (command) => {
      invoke.mockResolvedValue({ commandIds: ["tcm_1"] });
      expect(
        await dispatchRunCommand(
          "acme",
          "core-platform",
          RUN,
          command,
          "  releasing 3.2  ",
        ),
      ).toEqual({ ok: true, value: { commandIds: ["tcm_1"] } });
      expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
      expect(invoke).toHaveBeenCalledWith(
        "dispatch_command",
        {
          target: { kind: "run", id: RUN },
          command,
          reason: "releasing 3.2",
        },
        expect.objectContaining(TENANT),
      );
    },
  );

  it("omits an empty reason rather than sending the blank string the contract refuses", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_1"] });
    await dispatchRunCommand("acme", "core-platform", RUN, "pause", "   ");
    expect(invoke).toHaveBeenCalledWith(
      "dispatch_command",
      { target: { kind: "run", id: RUN }, command: "pause" },
      expect.objectContaining(TENANT),
    );
  });

  it("carries an empty command id list through as the control plane wrote it", async () => {
    invoke.mockResolvedValue({ commandIds: [] });
    expect(
      await dispatchRunCommand("acme", "core-platform", RUN, "cancel", ""),
    ).toEqual({ ok: true, value: { commandIds: [] } });
  });

  it("refuses a command a row does not send, before the kernel runs (negative)", async () => {
    expect(
      await dispatchRunCommand("acme", "core-platform", RUN, "steer", "go on"),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "row_command",
      field: "command",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a reason past the contract's ceiling before the kernel runs (negative)", async () => {
    expect(
      await dispatchRunCommand(
        "acme",
        "core-platform",
        RUN,
        "pause",
        "x".repeat(COMMAND_REASON_MAX + 1),
      ),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("carries a denial back as denied with the permission the kernel named (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError("dispatch_command", "authz_denied", "denied"),
    );
    expect(
      await dispatchRunCommand("acme", "core-platform", RUN, "pause", ""),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});
