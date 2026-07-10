import { describe, expect, it } from "vitest";
import { agentDefinitionList } from "./agent.definition.list";
import { getCapability } from "../registry";

describe("agent.definition.list capability", () => {
  it("parses empty input", () => {
    const parsed = agentDefinitionList.input.parse({});
    expect(parsed.status).toBeUndefined();
  });

  it("accepts a status filter", () => {
    const parsed = agentDefinitionList.input.parse({ status: "active" });
    expect(parsed.status).toBe("active");
  });

  it("rejects an unknown status filter", () => {
    expect(() =>
      agentDefinitionList.input.parse({ status: "weird" }),
    ).toThrow();
  });

  it("parses a valid output with a nullable latestVersion and managed flag", () => {
    const out = agentDefinitionList.output.parse({
      agents: [
        {
          agentId: "agt_1",
          publicId: "agt_1",
          slug: "qa-chat",
          agentKey: "acme.default.qa-chat",
          name: "QA",
          description: null,
          agentType: "interactive_chat",
          status: "active",
          deploymentStatus: "active",
          latestVersion: 1,
          managed: true,
          avatarUrl: 'avatar:v1:{"emoji":"🤖","bg":"#0ea5e9","mode":"full"}',
          summary: "Answers QA questions grounded in the workspace graph.",
          toolRefs: [
            { type: "skill", ref: "web-search" },
            { type: "mcp_server", ref: "github" },
          ],
        },
        {
          agentId: "agt_2",
          publicId: "agt_2",
          slug: "draft-agent",
          agentKey: null,
          name: "Draft",
          description: "wip",
          agentType: "custom",
          status: "draft",
          deploymentStatus: "inactive",
          latestVersion: null,
          managed: false,
          avatarUrl: null,
          summary: null,
          // toolRefs intentionally omitted — defaults to [].
        },
      ],
    });
    expect(out.agents).toHaveLength(2);
    expect(out.agents[0]!.managed).toBe(true);
    expect(out.agents[0]!.toolRefs).toEqual([
      { type: "skill", ref: "web-search" },
      { type: "mcp_server", ref: "github" },
    ]);
    expect(out.agents[1]!.latestVersion).toBeNull();
    expect(out.agents[1]!.managed).toBe(false);
    // Omitted toolRefs defaults to an empty array.
    expect(out.agents[1]!.toolRefs).toEqual([]);
  });

  it("rejects a toolRef with an unknown type", () => {
    expect(() =>
      agentDefinitionList.output.parse({
        agents: [
          {
            agentId: "agt_1",
            publicId: "agt_1",
            slug: "qa-chat",
            agentKey: null,
            name: "QA",
            description: null,
            agentType: "interactive_chat",
            status: "active",
            deploymentStatus: "active",
            latestVersion: 1,
            managed: false,
            avatarUrl: null,
            summary: null,
            toolRefs: [{ type: "database", ref: "pg" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects output missing the managed field", () => {
    expect(() =>
      agentDefinitionList.output.parse({
        agents: [
          {
            agentId: "agt_1",
            publicId: "agt_1",
            slug: "qa-chat",
            agentKey: "acme.default.qa-chat",
            name: "QA",
            description: null,
            agentType: "interactive_chat",
            status: "active",
            deploymentStatus: "active",
            latestVersion: 1,
            // managed intentionally omitted
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_agent_defs")).toBe(agentDefinitionList);
  });
});
