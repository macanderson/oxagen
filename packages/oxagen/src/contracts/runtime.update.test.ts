import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { runtimeUpdate } from "./runtime.update";

const RUNTIME_ID = "rtm_0123456789abcdefghjkmn";

describe("update_runtime contract", () => {
  it("is a settings write on api and mcp: mutates, unmetered, org Owner/Admin", () => {
    expect(getCapability("update_runtime")).toBe(runtimeUpdate);
    expect(runtimeUpdate.mutates).toBe(true);
    expect(runtimeUpdate.noBillingGate).toBe(true);
    expect(runtimeUpdate.scoped).toBe(true);
    expect(runtimeUpdate.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(runtimeUpdate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes the runtime and any field to change", () => {
    expect(runtimeUpdate.input.parse({ runtimeId: RUNTIME_ID })).toEqual({
      runtimeId: RUNTIME_ID,
    });
    expect(
      runtimeUpdate.input.parse({
        runtimeId: RUNTIME_ID,
        name: "  Build box ",
        containmentRequired: true,
      }),
    ).toEqual({
      runtimeId: RUNTIME_ID,
      name: "Build box",
      containmentRequired: true,
    });
  });

  it("refuses an empty name, a slug, an unknown field and a bad id", () => {
    for (const input of [
      { runtimeId: RUNTIME_ID, name: "   " },
      { runtimeId: RUNTIME_ID, slug: "build-box" },
      { runtimeId: RUNTIME_ID, containmentRequired: "yes" },
      { runtimeId: "x", containmentRequired: true },
    ]) {
      expect(
        runtimeUpdate.input.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
    }
  });

  it("answers with the runtime and its containment", () => {
    const answer = {
      runtime: { id: RUNTIME_ID, name: "Build box", slug: "build-box" },
      containmentRequired: true,
    };
    expect(runtimeUpdate.output.parse(answer)).toEqual(answer);
    expect(
      runtimeUpdate.output.safeParse({ runtime: answer.runtime }).success,
    ).toBe(false);
  });
});
