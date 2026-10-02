import { afterEach, describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { getSurfaces, type CapabilityContext } from "../types";
import { clearHandlersForTests, invoke, registerHandler } from "../kernel";
import { createPlatformOperatorContext } from "../platform-operator";
import { assistantSwitchSet } from "./assistant.switch.set";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";

const valid = {
  orgId: ORG,
  workspaceId: WS,
  on: true,
  reason: "Incident 2026-10-01: the assistant quotes stale spend",
};

/** What an operator script builds: no tenant, no user, surface "runner". */
const operatorCtx = (): CapabilityContext => ({
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req-operator",
  surface: "runner",
  messageId: null,
});

describe("set_assistant_switch contract", () => {
  afterEach(() => clearHandlersForTests());

  it("is registered under its verb-first name", () => {
    expect(getCapability("set_assistant_switch")).toBe(assistantSwitchSet);
  });

  it("is a platform-operator write on no surface that no role grants", () => {
    expect(assistantSwitchSet.platformOnly).toBe(true);
    expect(assistantSwitchSet.scoped).toBe(false);
    expect(assistantSwitchSet.noBillingGate).toBe(true);
    expect(assistantSwitchSet.mutates).toBe(true);
    expect(assistantSwitchSet.sensitivity).toBe("high");
    expect(getSurfaces(assistantSwitchSet)).toEqual([]);
    expect(assistantSwitchSet.layers).toEqual(["schema", "unit", "docs"]);
    expect(assistantSwitchSet.defaultEffect).toBe("deny");
    expect(assistantSwitchSet.defaultRoles).toEqual({
      org: {},
      workspace: {},
    });
  });

  it("the kernel refuses it without a minted platform-operator binding, and runs it with one", async () => {
    let ran = 0;
    registerHandler("set_assistant_switch", async () => async () => {
      ran += 1;
      return { switchId: "emd_1", changed: true };
    });

    await expect(
      invoke("set_assistant_switch", valid, operatorCtx()),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(ran).toBe(0);

    // A tenant context with a signed-in user is refused the same way: no
    // customer session reaches it.
    await expect(
      invoke("set_assistant_switch", valid, {
        ...operatorCtx(),
        orgId: ORG,
        workspaceId: WS,
        userId: "0192d4a8-7c1e-7a00-8000-0000000005e1",
        surface: "api",
      }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(ran).toBe(0);

    await invoke("set_assistant_switch", valid, {
      ...operatorCtx(),
      platformOperator: createPlatformOperatorContext({
        requestId: "req-operator",
      }),
    });
    expect(ran).toBe(1);
  });

  it("takes both the organisation and the workspace by id, since the call carries no tenant", () => {
    expect(assistantSwitchSet.input.parse(valid)).toEqual(valid);
    expect(
      assistantSwitchSet.input.safeParse({ ...valid, on: false }).success,
    ).toBe(true);
    for (const over of [
      { orgId: "acme" },
      { workspaceId: "default" },
      { orgId: undefined },
      { workspaceId: undefined },
      { on: undefined },
      { on: "on" },
    ]) {
      expect(
        assistantSwitchSet.input.safeParse({ ...valid, ...over }).success,
      ).toBe(false);
    }
  });

  it("requires a reason of 1 to 500 characters after trimming", () => {
    expect(
      assistantSwitchSet.input.parse({ ...valid, reason: "  paused  " }).reason,
    ).toBe("paused");
    expect(
      assistantSwitchSet.input.safeParse({ ...valid, reason: "x".repeat(500) })
        .success,
    ).toBe(true);
    for (const reason of ["", "   ", "x".repeat(501), undefined]) {
      expect(
        assistantSwitchSet.input.safeParse({ ...valid, reason }).success,
      ).toBe(false);
    }
  });

  it("refuses an unknown input key, such as an agent id", () => {
    expect(
      assistantSwitchSet.input.safeParse({ ...valid, agentId: "agt_1" })
        .success,
    ).toBe(false);
  });

  it("returns the switch row's id, or null when off found nothing on", () => {
    for (const row of [
      { switchId: "emd_1", changed: true },
      { switchId: "emd_1", changed: false },
      { switchId: null, changed: false },
    ]) {
      expect(assistantSwitchSet.output.parse(row)).toEqual(row);
    }
    expect(
      assistantSwitchSet.output.safeParse({ switchId: "emd_1" }).success,
    ).toBe(false);
    expect(
      assistantSwitchSet.output.safeParse({
        switchId: "emd_1",
        changed: true,
        on: true,
      }).success,
    ).toBe(false);
  });
});
