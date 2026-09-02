import { describe, expect, it } from "vitest";
import { orgMemberRemove } from "./org.member.remove";
import { getCapability } from "../registry";

describe("org.member.remove capability", () => {
  it("parses a valid input", () => {
    const parsed = orgMemberRemove.input.parse({ targetUserId: "usr_abc" });
    expect(parsed.targetUserId).toBe("usr_abc");
  });

  it("rejects an empty targetUserId", () => {
    expect(() => orgMemberRemove.input.parse({ targetUserId: "" })).toThrow();
  });

  it("rejects a missing targetUserId", () => {
    expect(() => orgMemberRemove.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = orgMemberRemove.output.parse({
      removed: true,
      targetUserId: "usr_abc",
      orgId: "org_1",
    });
    expect(parsed.removed).toBe(true);
  });

  it("rejects an output with a non-boolean removed flag", () => {
    expect(() =>
      orgMemberRemove.output.parse({
        removed: "yes",
        targetUserId: "usr_abc",
        orgId: "org_1",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("remove_org_member")).toBe(orgMemberRemove);
  });

  it("is high-sensitivity and default-deny (last-owner guard lives in the handler)", () => {
    expect(orgMemberRemove.sensitivity).toBe("high");
    expect(orgMemberRemove.defaultEffect).toBe("deny");
  });
});
