import { describe, expect, it } from "vitest";
import { tachoContainedLaunchRegister as contract } from "./tacho.contained_launch.register";
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  session_uuid: "11111111-1111-4111-8111-111111111111",
  genesis_hash: `sha256:${"a".repeat(64)}`,
  measurement: {
    profile: "oxagen-linux-docker-v1",
    containerId: "b".repeat(64),
    imageDigest: `sha256:${"c".repeat(64)}`,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    gatewayOnlyEgress: true,
    workspaceOnlyWrites: true,
    readOnlyHooks: true,
  },
};
describe("contained launch contract", () => {
  it("requires the exact measured profile and immutable chain identity", () => {
    expect(contract.input.safeParse(input).success).toBe(true);
    for (const patch of [
      { genesis_hash: "claimed" },
      { genesis_hash: "a".repeat(64) },
      { session_uuid: "other" },
      { extra: true },
      { measurement: { ...input.measurement, profile: "unrestricted" } },
      { measurement: { ...input.measurement, readOnlyHooks: false } },
    ])
      expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(
        false,
      );
  });
  it("keeps registration off the agent and MCP tool surfaces", () => {
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.sensitivity).toBe("high");
    expect(contract.output.safeParse({ registered: true }).success).toBe(true);
    expect(contract.output.safeParse({ registered: false }).success).toBe(
      false,
    );
  });
});
