import { describe, expect, it } from "vitest";
import { agentSkillList } from "./agent.skill.list";
import { getCapability } from "../registry";

describe("agent.skill.list capability", () => {
  it("parses an empty input", () => {
    const parsed = agentSkillList.input.parse({});
    expect(parsed.filter).toBeUndefined();
  });

  it("parses a filtered input", () => {
    const parsed = agentSkillList.input.parse({ filter: "coding" });
    expect(parsed.filter).toBe("coding");
  });

  it("parses a valid output", () => {
    const parsed = agentSkillList.output.parse({
      skills: [
        {
          slug: "coding",
          name: "Coding",
          description: "Write code the Oxagen way",
          source: "builtin",
          version: "1.0.0",
        },
      ],
    });
    expect(parsed.skills[0]?.source).toBe("builtin");
  });

  it("rejects an unknown source", () => {
    expect(() =>
      agentSkillList.output.parse({
        skills: [
          {
            slug: "x",
            name: "X",
            description: "y",
            source: "marketplace",
            version: "1.0.0",
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_agent_skills")).toBe(agentSkillList);
  });
});
