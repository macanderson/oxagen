import { describe, expect, it } from "vitest";
import { OrgRole } from "./common";

describe("OrgRole", () => {
  it("accepts the six stored roles and nothing else", () => {
    expect(OrgRole.options).toHaveLength(6);
    expect(OrgRole.safeParse("Owner").success).toBe(false);
    expect(OrgRole.safeParse("superuser").success).toBe(false);
  });
});
