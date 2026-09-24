import { describe, expect, it } from "vitest";
import { runSeal } from "./run.seal";

const RUN_ID = "tse_0192d4a87c1e7a0080000000";
const SEALED_AT = "2026-09-24T16:00:00.000Z";

describe("seal_run contract", () => {
  it("is a sync write for org Owner or Admin or the workspace Owner, never metered, and waits for approval when an agent calls it", () => {
    expect(runSeal.mode).toBe("sync");
    expect(runSeal.mutates).toBe(true);
    expect(runSeal.noBillingGate).toBe(true);
    expect(runSeal.sensitivity).toBe("high");
    expect(runSeal.defaultEffect).toBe("deny");
    expect(runSeal.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    // A workspace Member can cancel a run but not seal it (ADR-169).
    expect(runSeal.defaultRoles?.workspace).toEqual({ Owner: "allow" });
    expect(runSeal.agent?.requiresApproval).toBe(true);
    expect(runSeal.surfaces).toEqual(["api", "mcp"]);
  });

  it("takes a run id with an optional reason, and refuses an empty reason or an unknown field", () => {
    expect(runSeal.input.safeParse({ runId: RUN_ID }).success).toBe(true);
    expect(
      runSeal.input.safeParse({ runId: RUN_ID, reason: "finished an hour ago" })
        .success,
    ).toBe(true);
    // The schema reads both stores' ids; the handler refuses a ledger run.
    expect(
      runSeal.input.safeParse({ runId: "arun_5f0c2e9a1b7d4c3e8f6a02" }).success,
    ).toBe(true);
    expect(runSeal.input.safeParse({ runId: "tcm_0a1b2c" }).success).toBe(
      false,
    );
    expect(runSeal.input.safeParse({ runId: RUN_ID, reason: "" }).success).toBe(
      false,
    );
    expect(
      runSeal.input.safeParse({ runId: RUN_ID, reason: "x".repeat(513) })
        .success,
    ).toBe(false);
    expect(
      runSeal.input.safeParse({ runId: RUN_ID, force: true }).success,
    ).toBe(false);
  });

  it("answers the seal with a queued kill, or a kill not sent and the block that stopped it", () => {
    expect(
      runSeal.output.safeParse({
        runId: RUN_ID,
        sealedAt: SEALED_AT,
        sessionsSealed: 2,
        kill: { status: "queued", commandId: "tcm_0a1b2c3d" },
      }).success,
    ).toBe(true);
    expect(
      runSeal.output.safeParse({
        runId: RUN_ID,
        sealedAt: SEALED_AT,
        sessionsSealed: 1,
        kill: { status: "not_sent", reason: "host_offline" },
      }).success,
    ).toBe(true);
  });

  it("refuses an answer that sealed nothing, a kill reason outside the command blocks, or a queued kill with no command id", () => {
    const sealed = { runId: RUN_ID, sealedAt: SEALED_AT, sessionsSealed: 1 };
    expect(
      runSeal.output.safeParse({
        ...sealed,
        sessionsSealed: 0,
        kill: { status: "queued", commandId: "tcm_0a1b2c3d" },
      }).success,
    ).toBe(false);
    expect(
      runSeal.output.safeParse({
        ...sealed,
        kill: { status: "not_sent", reason: "host_asleep" },
      }).success,
    ).toBe(false);
    expect(
      runSeal.output.safeParse({ ...sealed, kill: { status: "queued" } })
        .success,
    ).toBe(false);
  });
});
