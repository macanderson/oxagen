// The approval decision through the real kernel seam: the viewer resolution and
// the kernel's invoke() are the only fakes, so each case shows what the operator
// gets back, whether the capability ran, and with which input (INV-19).
//
// Two rules belong to this file rather than to the markup.
//
// A denial carries a reason. The contract's `note` is optional, because an API
// caller approving a routine call has nothing to add, and a `required`
// attribute on a textarea is a courtesy to the person typing rather than a
// rule. The note is the whole record of why a call an agent was authorised to
// make was refused, so the refusal happens before the kernel and names the
// field.
//
// The gate is the handler's, not this action's. `resolve_approval` runs
// `assertOrgRole`, then, on a row a mandate parked, `assertConsequenceRole`
// and `assertApprover`, and refuses an agent principal, all before it touches
// a row (INV-29). What the app owes is that each refusal comes back as a
// refusal with the handler's reason in `code`, and that a decision the kernel
// refused sends exactly one call, so no ledger row could have moved.
//
// The Fleet row command through the real kernel seam: the viewer resolution
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether the capability ran (INV-19).
//
// Three rules the tests hold it to, because breaking any of them would let a
// row claim more than the control plane did: the command carries this run as
// its target and nothing wider, a command outside the three a row sends is
// refused before the kernel, and no payload is ever attached, which
// `dispatch_command` refuses on pause, resume and cancel.
import {
  COMMAND_REASON_MAX,
  STEER_TEXT_MAX,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
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
const {
  dispatchRunCommand,
  exportFleetRun,
  readApprovalEligibility,
  resolveApprovalAction,
  steerFleet,
} = await import("./actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const APPROVAL = "apr_q8t1";
const RUN = "tse_7k2m9q";
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

/** The settlement `resolve_approval` answers on a row the mandate gate parked. */
const settled = {
  approvalId: APPROVAL,
  resolution: "approved",
  mandate: {
    mandateId: "mnd_4f2a9c",
    reserved: [
      { measure: "amount", value: "180000000", unitOrCurrency: "USD" },
    ],
    outcome: "held",
  },
} as const;

/** A HandlerError as the kernel raises it: the refusal is in `reason`. */
class TestHandlerError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}
const handlerError = (code: string, reason: string) =>
  new TestHandlerError(code, reason);

/** The one `resolve_approval` call's input. */
function written(): unknown {
  const call = invoke.mock.calls.find(([name]) => name === "resolve_approval");
  if (!call) throw new Error("resolve_approval was not called");
  return call[1];
}

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("resolveApprovalAction", () => {
  it("approves, carrying the note when there is one and the settlement back", async () => {
    invoke.mockResolvedValue(settled);
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "approved",
      note: "  release window is open  ",
    });
    // A mandate row stores no call, so there is no execution to report.
    expect(result).toEqual({
      ok: true,
      value: { ...settled, execution: null },
    });
    expect(written()).toEqual({
      approvalId: APPROVAL,
      decision: "approved",
      note: "release window is open",
    });
  });

  it("approves with no note at all rather than an empty one", async () => {
    invoke.mockResolvedValue({ ...settled, mandate: null });
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "approved",
      note: "   ",
    });
    expect(result.ok).toBe(true);
    expect(written()).toEqual({ approvalId: APPROVAL, decision: "approved" });
  });

  // ADR-118: the handler runs a call the in-app assistant parked once it is
  // approved, and answers what the row then records. The flyout's parked card
  // decides through this action, so the execution has to come back through it.
  it("carries back what became of an approved call the assistant parked", async () => {
    const execution = {
      status: "succeeded",
      runId: "arun_resumed",
      reason: null,
    };
    invoke.mockResolvedValue({ ...settled, mandate: null, execution });
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "approved",
      note: "",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        approvalId: APPROVAL,
        resolution: "approved",
        mandate: null,
        execution,
      },
    });
  });

  it("refuses a denial with no reason before the kernel, naming the field (negative)", async () => {
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "denied",
      note: "   ",
    });
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      code: "note_required",
      field: "note",
    });
    // Nothing reached the kernel, so nothing was billed and no row moved.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("denies with the reason, and the mandate releases what the call reserved", async () => {
    invoke.mockResolvedValue({
      approvalId: APPROVAL,
      resolution: "denied",
      mandate: { ...settled.mandate, outcome: "released" },
    });
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "denied",
      note: "vendor is not on the approved list",
    });
    expect(result.ok && result.value.mandate?.outcome).toBe("released");
    expect(written()).toEqual({
      approvalId: APPROVAL,
      decision: "denied",
      note: "vendor is not on the approved list",
    });
  });

  it("carries the handler's own reason when the roles do not cover the decision (negative)", async () => {
    invoke.mockRejectedValue(handlerError("forbidden", "org_role_required"));
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "approved",
      note: "",
    });
    expect(result).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("carries approval_expired for an id that matches no pending row (negative)", async () => {
    invoke.mockRejectedValue(handlerError("conflict", "approval_expired"));
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "approved",
      note: "",
    });
    expect(result).toEqual({
      ok: false,
      reason: "conflict",
      code: "approval_expired",
    });
  });

  // ADR-115: the decision is the one billed action of this surface, so the
  // billing admission gate can refuse it where it refuses no read here.
  it("carries the exhausted code the billing gate raised (negative)", async () => {
    invoke.mockRejectedValue(handlerError("gau_exhausted", "gau exhausted"));
    const result = await resolveApprovalAction("acme", "core-platform", {
      approvalId: APPROVAL,
      decision: "approved",
      note: "",
    });
    expect(result).toEqual({
      ok: false,
      reason: "exhausted",
      code: "gau_exhausted",
    });
  });
});

describe("readApprovalEligibility", () => {
  it("reads the recorded evaluation and who resolved the call", async () => {
    // The contract names the rule `ruleId`; the view model names it `ruleRef`,
    // because Oxagen neither mints nor validates a rule id (INV-11).
    const recorded = {
      ruleId: "small-vendor-payments",
      ok: false,
      reasons: ["measure_above_ceiling:amount"],
      floor: false,
    };
    const eligibility = {
      ruleRef: "small-vendor-payments",
      ok: false,
      reasons: ["measure_above_ceiling:amount"],
      floor: false,
    };
    invoke.mockResolvedValue({
      approvalId: APPROVAL,
      resolvedBy: "policy:small-vendor-payments",
      eligibility: recorded,
    });
    const result = await readApprovalEligibility(
      "acme",
      "core-platform",
      APPROVAL,
      "fleet",
    );
    expect(result).toEqual({
      ok: true,
      value: { resolvedBy: "policy:small-vendor-payments", eligibility },
    });
    expect(invoke.mock.calls[0]?.[0]).toBe("get_auto_eligibility");
    expect(invoke.mock.calls[0]?.[1]).toEqual({ approvalId: APPROVAL });
  });

  it("answers null on a call no rule covered", async () => {
    invoke.mockResolvedValue({
      approvalId: APPROVAL,
      resolvedBy: null,
      eligibility: null,
    });
    const result = await readApprovalEligibility(
      "acme",
      "core-platform",
      APPROVAL,
      "fleet",
    );
    expect(result).toEqual({
      ok: true,
      value: { resolvedBy: null, eligibility: null },
    });
  });

  it("carries a refused read across as a denial, naming the asking page's permission (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        "get_auto_eligibility",
        "authz_denied",
        "denied",
      ),
    );
    const result = await readApprovalEligibility(
      "acme",
      "core-platform",
      APPROVAL,
      "run",
    );
    // A card on the Run page reports the Run page's permission, not Fleet's.
    expect(result).toEqual({ ok: false, reason: "denied", code: "run.read" });
  });
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

// Steer the fleet: one `steer` per selected agent, addressed to the agent so
// the control plane fans it out to that agent's runs in flight, always at the
// turn boundary (the design's Interrupt is not offered).
describe("steerFleet", () => {
  const KEYS = ["acme.core.release-bot", "acme.core.docs"];

  it("queues one steer per agent at the turn boundary and answers every run it reached", async () => {
    invoke
      .mockResolvedValueOnce({ commandIds: ["tcm_1", "tcm_2"] })
      .mockResolvedValueOnce({ commandIds: [] });
    expect(
      await steerFleet("acme", "core-platform", {
        agentKeys: KEYS,
        text: "  Skip the mobile repo this cycle.  ",
      }),
    ).toEqual({
      ok: true,
      value: { commandIds: ["tcm_1", "tcm_2"], refused: [] },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledTimes(2);
    for (const agentKey of KEYS)
      expect(invoke).toHaveBeenCalledWith(
        "dispatch_command",
        {
          target: { kind: "agent", id: agentKey },
          command: "steer",
          payload: {
            text: "Skip the mobile repo this cycle.",
            requestedMode: "turn_boundary",
          },
        },
        expect.objectContaining(TENANT),
      );
  });

  it("sends one steer for an agent named twice", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_1"] });
    await steerFleet("acme", "core-platform", {
      agentKeys: ["acme.core.docs", "acme.core.docs"],
      text: "Hold the release.",
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("keeps the steers that were queued and names the agents that refused one", async () => {
    invoke
      .mockResolvedValueOnce({ commandIds: ["tcm_1"] })
      .mockRejectedValueOnce(
        new kernel.CapabilityError(
          "dispatch_command",
          "authz_denied",
          "denied",
        ),
      );
    const result = await steerFleet("acme", "core-platform", {
      agentKeys: KEYS,
      text: "Hold the release.",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        commandIds: ["tcm_1"],
        refused: [{ agentKey: "acme.core.docs" }],
      },
    });
  });

  it("answers the refusal itself when every agent was refused (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError("dispatch_command", "authz_denied", "denied"),
    );
    expect(
      await steerFleet("acme", "core-platform", {
        agentKeys: KEYS,
        text: "Hold the release.",
      }),
    ).toMatchObject({ ok: false, reason: "denied" });
  });

  it.each([
    ["an empty text", { agentKeys: KEYS, text: "   " }, "steer_text", "text"],
    [
      "a text past the contract's ceiling",
      { agentKeys: KEYS, text: "x".repeat(STEER_TEXT_MAX + 1) },
      "steer_text",
      "text",
    ],
    ["no agent", { agentKeys: [], text: "Hold." }, "steer_agents", "agents"],
  ])(
    "refuses %s before the kernel runs (negative)",
    async (_case, input, code, field) => {
      expect(await steerFleet("acme", "core-platform", input)).toEqual({
        ok: false,
        reason: "invalid",
        code,
        field,
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});

describe("exportFleetRun", () => {
  it("queues the run's evidence bundle and answers the export id", async () => {
    invoke.mockResolvedValue({ exportId: "rexp_1", status: "queued" });
    expect(
      await exportFleetRun("acme", "core-platform", "arun_7k2m9q"),
    ).toEqual({ ok: true, value: { exportId: "rexp_1" } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "export_run",
      { runId: "arun_7k2m9q" },
      expect.objectContaining(TENANT),
    );
  });

  it("carries the handler's role refusal back as denied (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError("export_run", "authz_denied", "denied"),
    );
    expect(
      await exportFleetRun("acme", "core-platform", "arun_7k2m9q"),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});
