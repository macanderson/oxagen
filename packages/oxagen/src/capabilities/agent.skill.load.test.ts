import { describe, expect, it } from "vitest";
import { agentSkillLoad } from "./agent.skill.load.js";
import { getCapability } from "../registry.js";

describe("agent.skill.load capability", () => {
  it("parses a valid input", () => {
    const parsed = agentSkillLoad.input.parse({
      slug: "coding",
      parentMessageId: "msg_1",
    });
    expect(parsed.slug).toBe("coding");
  });

  it("rejects a missing slug", () => {
    expect(() =>
      agentSkillLoad.input.parse({ parentMessageId: "msg_1" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentSkillLoad.output.parse({
      slug: "coding",
      body: "# Coding\n\nWrite code…",
      references: [{ path: "tailwind.md", body: "Tailwind v4 notes" }],
    });
    expect(parsed.references).toHaveLength(1);
  });

  it("accepts an empty references array", () => {
    const parsed = agentSkillLoad.output.parse({
      slug: "coding",
      body: "x",
      references: [],
    });
    expect(parsed.references).toEqual([]);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.skill.load")).toBe(agentSkillLoad);
  });
});
