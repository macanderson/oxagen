import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentToolbeltAssign } from "./agent.toolbelt.assign";

describe("assign_agent_toolbelt contract", () => {
  it("is an identity write on api and mcp for org Owner/Admin", () => {
    expect(getCapability("assign_agent_toolbelt")).toBe(agentToolbeltAssign);
    expect(agentToolbeltAssign.mutates).toBe(true);
    expect(agentToolbeltAssign.surfaces).toEqual(["api", "mcp"]);
    expect(agentToolbeltAssign.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes a toolbelt by public id only", () => {
    expect(
      agentToolbeltAssign.input.safeParse({
        agentId: "agt_0123456789abcdefghjkmn",
        toolbeltId: "tbt_0123456789abcdefghjkmn",
      }).success,
    ).toBe(true);
    expect(
      agentToolbeltAssign.input.safeParse({
        agentId: "agt_0123456789abcdefghjkmn",
        toolbeltId: "read-only",
      }).success,
    ).toBe(false);
  });

  it("answers with the belt and the version it wrote", () => {
    const out = {
      agentId: "agt_0123456789abcdefghjkmn",
      toolbelt: {
        id: "tbt_0123456789abcdefghjkmn",
        name: "Read only",
        slug: "read-only",
        kind: "custom",
      },
      version: 3,
    };
    expect(agentToolbeltAssign.output.parse(out)).toEqual(out);
  });
});
