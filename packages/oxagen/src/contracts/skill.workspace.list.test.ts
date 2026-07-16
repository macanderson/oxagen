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

  // A fully-populated skill row — the shape the app's list page consumes
  // (slug/source/activeVersion/updatedAt are required; their prior absence
  // blanked the workbench Skills table).
  const validSkill = (overrides: Record<string, unknown> = {}) => ({
    id: "skill-001",
    slug: "web-search",
    name: "web-search",
    description: "Search the web for information.",
    source: "tenant",
    installedFromSlug: null,
    enabled: true,
    activeVersion: "v1",
    updatedAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  });

  it("parses a valid output with one fully-populated skill", () => {
    const parsed = skillWorkspaceList.output.parse({ skills: [validSkill()] });
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0]?.id).toBe("skill-001");
    expect(parsed.skills[0]?.slug).toBe("web-search");
    expect(parsed.skills[0]?.name).toBe("web-search");
    expect(parsed.skills[0]?.source).toBe("tenant");
    expect(parsed.skills[0]?.enabled).toBe(true);
    expect(parsed.skills[0]?.activeVersion).toBe("v1");
    expect(parsed.skills[0]?.updatedAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("parses a valid output with no skills (empty array)", () => {
    const parsed = skillWorkspaceList.output.parse({ skills: [] });
    expect(parsed.skills).toHaveLength(0);
  });

  it("parses a skill with enabled=false", () => {
    const parsed = skillWorkspaceList.output.parse({
      skills: [
        validSkill({
          id: "skill-002",
          slug: "code-execute",
          name: "code-execute",
          enabled: false,
        }),
      ],
    });
    expect(parsed.skills[0]?.enabled).toBe(false);
  });

  it("accepts null activeVersion and null updatedAt", () => {
    const parsed = skillWorkspaceList.output.parse({
      skills: [validSkill({ activeVersion: null, updatedAt: null })],
    });
    expect(parsed.skills[0]?.activeVersion).toBeNull();
    expect(parsed.skills[0]?.updatedAt).toBeNull();
  });

  it("rejects a skill missing the required slug field", () => {
    const { slug: _omit, ...noSlug } = validSkill();
    expect(() =>
      skillWorkspaceList.output.parse({ skills: [noSlug] }),
    ).toThrow();
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
