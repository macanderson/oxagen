import { describe, expect, it } from "vitest";
import { steeringRead } from "./steering.read";

const RECORD = {
  lineage: "a-intel.domain.refund",
  label: "Refunds over $100",
  kind: "constraint",
  source: "workspace",
  version: 21,
  path: "steering/domain/a-intel.domain.refund.md",
  text: "### Refunds over $100\n\nAsk a person before you refund more than $100.",
};

describe("read_steering contract", () => {
  it("is a scoped, unmetered read on the mcp surface", () => {
    expect(steeringRead.name).toBe("read_steering");
    expect(steeringRead.surfaces).toEqual(["mcp"]);
    expect(steeringRead.scoped).toBe(true);
    expect(steeringRead.mutates).toBe(false);
    expect(steeringRead.noBillingGate).toBe(true);
  });

  it("lets org admins and every workspace role call it, and no one else by default", () => {
    expect(steeringRead.defaultEffect).toBe("deny");
    expect(steeringRead.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
    });
  });

  it("takes a lineage, and a file in a skill's folder when one is wanted", () => {
    expect(steeringRead.input.parse({ lineage: RECORD.lineage })).toEqual({
      lineage: RECORD.lineage,
    });
    const input = { lineage: "a-intel.brand.voice", file: "words.md" };
    expect(steeringRead.input.parse(input)).toEqual(input);
  });

  it("refuses a missing lineage, an empty file name, and a field it does not take", () => {
    expect(steeringRead.input.safeParse({}).success).toBe(false);
    expect(steeringRead.input.safeParse({ lineage: RECORD.lineage, file: "" }).success).toBe(false);
    expect(
      steeringRead.input.safeParse({ lineage: RECORD.lineage, version: 3 }).success,
    ).toBe(false);
  });

  it("answers the record with the version it came from", () => {
    expect(steeringRead.output.parse(RECORD)).toEqual(RECORD);
  });

  it("refuses an answer without its version", () => {
    const { version: _version, ...withoutVersion } = RECORD;
    expect(steeringRead.output.safeParse(withoutVersion).success).toBe(false);
  });
});
