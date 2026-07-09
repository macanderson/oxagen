import { describe, expect, it } from "vitest";
import { skillWorkspaceList } from "./skill.workspace.list";
import { getCapability } from "../registry";

describe("skill.workspace.list capability", () => {
  // ── input: defaults ───────────────────────────────────────────────────────

  it("parses empty input successfully (workspace_id is optional)", () => {
    const parsed = skillWorkspaceList.input.parse({});
    expect(parsed.workspace_id).toBeUndefined();
  });

  it("accepts a workspace_id string", () => {
    const parsed = skillWorkspaceList.input.parse({
      workspace_id: "ws-abc-123",
    });
    expect(parsed.workspace_id).toBe("ws-abc-123");
  });

  // ── input: type validation ────────────────────────────────────────────────

  it("rejects non-string workspace_id", () => {
    expect(() =>
      skillWorkspaceList.input.parse({ workspace_id: 999 }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with one skill", () => {
    const parsed = skillWorkspaceList.output.parse({
      skills: [
        {
          id: "skill-001",
          name: "web-search",
          description: "Search the web for information.",
          enabled: true,
        },
      ],
    });
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0]?.id).toBe("skill-001");
    expect(parsed.skills[0]?.name).toBe("web-search");
    expect(parsed.skills[0]?.enabled).toBe(true);
  });

  it("parses a valid output with no skills (empty array)", () => {
    const parsed = skillWorkspaceList.output.parse({ skills: [] });
    expect(parsed.skills).toHaveLength(0);
  });

  it("parses a skill with enabled=false", () => {
    const parsed = skillWorkspaceList.output.parse({
      skills: [
        {
          id: "skill-002",
          name: "code-execute",
          description: "Execute code in a sandbox.",
          enabled: false,
        },
      ],
    });
    expect(parsed.skills[0]?.enabled).toBe(false);
  });

  it("rejects a skill missing the name field", () => {
    expect(() =>
      skillWorkspaceList.output.parse({
        skills: [
          {
            id: "skill-001",
            description: "No name here.",
            enabled: true,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a skill with non-boolean enabled", () => {
    expect(() =>
      skillWorkspaceList.output.parse({
        skills: [
          {
            id: "skill-001",
            name: "web-search",
            description: "Desc.",
            enabled: "yes",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects output missing skills array", () => {
    expect(() => skillWorkspaceList.output.parse({})).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_workspace_skills")).toBe(skillWorkspaceList);
  });
});
