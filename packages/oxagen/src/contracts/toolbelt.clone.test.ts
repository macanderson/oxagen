import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolbeltClone } from "./toolbelt.clone";

const BELT_ID = "tbt_0123456789abcdefghjkmn";

describe("clone_toolbelt contract", () => {
  it("is a settings write on api and mcp for org Owner/Admin and the workspace Owner", () => {
    expect(getCapability("clone_toolbelt")).toBe(toolbeltClone);
    expect(toolbeltClone.mutates).toBe(true);
    expect(toolbeltClone.noBillingGate).toBe(true);
    expect(toolbeltClone.surfaces).toEqual(["api", "mcp"]);
    expect(toolbeltClone.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
  });

  it("takes a source and a name, and leaves the slug to the server", () => {
    expect(
      toolbeltClone.input.parse({ toolbeltId: BELT_ID, name: " Read only " }),
    ).toEqual({ toolbeltId: BELT_ID, name: "Read only" });
    expect(toolbeltClone.input.safeParse({ toolbeltId: BELT_ID }).success).toBe(
      false,
    );
    expect(
      toolbeltClone.input.safeParse({
        toolbeltId: BELT_ID,
        name: "x",
        slug: "Read_Only",
      }).success,
    ).toBe(false);
  });

  it("answers with the new belt, a custom one", () => {
    const toolbelt = {
      id: "tbt_1abcdefghjkmnpqrstvwxy",
      name: "Read only",
      slug: "read-only",
      kind: "custom",
    };
    expect(toolbeltClone.output.parse({ toolbelt })).toEqual({ toolbelt });
  });
});
