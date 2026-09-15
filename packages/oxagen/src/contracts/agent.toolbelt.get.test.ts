import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  FULL_BELT_LIMIT,
  agentToolbeltGet,
  beltToolSchema,
} from "./agent.toolbelt.get";

const tool = {
  name: "list_runs",
  kind: "capability",
  server: null,
  category: "introspection",
  riskLevel: "low",
  decision: "allow",
  rule: "agent:7:role_grant",
  readOnly: true,
};

describe("get_agent_toolbelt contract", () => {
  it("is a console read: non-mutating, unmetered, Owner/Admin/Member; the full-belt limit is the spec's 40", () => {
    expect(getCapability("get_agent_toolbelt")).toBe(agentToolbeltGet);
    expect(agentToolbeltGet.mutates).toBe(false);
    expect(agentToolbeltGet.noBillingGate).toBe(true);
    expect(agentToolbeltGet.surfaces).toEqual(["api", "mcp"]);
    expect(agentToolbeltGet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Member: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    expect(FULL_BELT_LIMIT).toBe(40);
  });

  it("takes an id or slug and an optional presentation", () => {
    expect(agentToolbeltGet.input.parse({ agentId: "agt_x" })).toEqual({
      agentId: "agt_x",
    });
    expect(
      agentToolbeltGet.input.parse({ agentId: "agt_x", mode: "searchable" })
        .mode,
    ).toBe("searchable");
    expect(
      agentToolbeltGet.input.safeParse({ agentId: "agt_x", mode: "compact" })
        .success,
    ).toBe(false);
  });

  it("a belt tool carries a decision the model can act on: allow or require_approval, never deny", () => {
    expect(beltToolSchema.parse(tool).decision).toBe("allow");
    expect(
      beltToolSchema.safeParse({ ...tool, decision: "deny" }).success,
    ).toBe(false);
    expect(
      beltToolSchema.safeParse({ ...tool, kind: "mcp", server: null }).success,
    ).toBe(true);
  });

  it("answers with the basis, the presentation, the belt and the exclusions", () => {
    const out = agentToolbeltGet.output.parse({
      agentId: "agt_0123456789abcdefghjkmn",
      agentKey: "acme.core.release-bot",
      computedAt: "2026-09-14T10:00:00.000Z",
      basis: {
        humanCeiling: "caller",
        roleGrants: 4,
        denyGeneration: { org: 0, workspace: 2 },
        killSwitches: 1,
      },
      presentation: { mode: "full", limit: 40, sentToModel: "definitions" },
      tools: [tool],
      cannotSee: [
        {
          name: "delete_workspace",
          kind: "capability",
          server: null,
          rule: "kill_switch",
        },
      ],
    });
    expect(out.cannotSee).toHaveLength(1);
    expect(
      agentToolbeltGet.output.safeParse({
        ...out,
        presentation: { mode: "searchable", limit: 40, sentToModel: "all" },
      }).success,
    ).toBe(false);
  });
});
