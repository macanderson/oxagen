import { describe, expect, it } from "vitest";
import {
  clampForce,
  defaultForceFor,
  forceAllowed,
  forcesFor,
  recordForceSchema,
} from "./record-force";
import { RECORD_KINDS } from "./record-kind";

describe("forcesFor", () => {
  it("offers every force to the rule kinds, a constraint, a procedure, and a skill", () => {
    for (const kind of [
      "business-rule",
      "code-rule",
      "constraint",
      "procedure",
      "skill",
      "rule",
    ] as const) {
      expect(forcesFor(kind)).toEqual(["must", "should", "may", "info"]);
    }
  });

  it("never lets a preference be must or should (negative)", () => {
    expect(forcesFor("preference")).toEqual(["may", "info"]);
    expect(forceAllowed("preference", "must")).toBe(false);
    expect(forceAllowed("preference", "should")).toBe(false);
  });

  it("holds a fact and a memory to info (negative)", () => {
    expect(forcesFor("fact")).toEqual(["info"]);
    expect(forcesFor("memory")).toEqual(["info"]);
    expect(forceAllowed("fact", "should")).toBe(false);
  });

  it("names only forces the schema accepts, for every kind", () => {
    for (const kind of RECORD_KINDS) {
      for (const force of forcesFor(kind)) {
        expect(recordForceSchema.safeParse(force).success).toBe(true);
      }
    }
  });
});

describe("defaultForceFor", () => {
  it("defaults the rule kinds to should, a preference to may, and a fact or memory to info", () => {
    expect(defaultForceFor("business-rule")).toBe("should");
    expect(defaultForceFor("code-rule")).toBe("should");
    expect(defaultForceFor("constraint")).toBe("should");
    expect(defaultForceFor("procedure")).toBe("should");
    expect(defaultForceFor("skill")).toBe("should");
    expect(defaultForceFor("preference")).toBe("may");
    expect(defaultForceFor("fact")).toBe("info");
    expect(defaultForceFor("memory")).toBe("info");
  });

  it("gives every kind a default the kind allows", () => {
    for (const kind of RECORD_KINDS) {
      expect(forceAllowed(kind, defaultForceFor(kind))).toBe(true);
    }
  });
});

describe("clampForce", () => {
  it("keeps a force the kind allows", () => {
    expect(clampForce("code-rule", "must")).toBe("must");
    expect(clampForce("preference", "info")).toBe("info");
  });

  it("moves a force the kind forbids to the kind's default (negative)", () => {
    expect(clampForce("preference", "must")).toBe("may");
    expect(clampForce("fact", "should")).toBe("info");
    expect(clampForce("memory", "must")).toBe("info");
  });

  it("uses the default when no force is given", () => {
    expect(clampForce("business-rule", null)).toBe("should");
    expect(clampForce("preference", undefined)).toBe("may");
  });
});
