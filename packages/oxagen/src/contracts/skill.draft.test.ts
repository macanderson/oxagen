import { describe, expect, it } from "vitest";
import { skillDraft } from "./skill.draft";
import { getCapability } from "../registry";

const VALID_DRAFT = {
  displayName: "PR Review",
  slug: "pr-review",
  description: "How to review pull requests for correctness and coverage.",
  weight: "high" as const,
  category: "engineering",
  body: "# PR Review\n\nLoad when reviewing a pull request.",
};

const VALID_ARTIFACT = {
  schema_version: 1 as const,
  kind: "skill" as const,
  name: "pr-review",
  description: "How to review PRs",
  instructions: "# PR Review",
  references: [],
  metadata: { weight: "high" },
};
const VALID_CONTENT =
  'schema_version = 1\nkind = "skill"\nname = "pr-review"\n';

describe("skill.draft capability", () => {
  // ── input: valid paths ────────────────────────────────────────────────────

  it("accepts a minimal valid prompt", () => {
    const parsed = skillDraft.input.parse({
      prompt: "Teach the agent how to review PRs",
    });
    expect(parsed.prompt).toBe("Teach the agent how to review PRs");
    expect(parsed.nameHint).toBeUndefined();
    expect(parsed.category).toBeUndefined();
  });

  it("accepts a prompt with all optional fields", () => {
    const parsed = skillDraft.input.parse({
      prompt: "Teach the agent how to review pull requests effectively",
      nameHint: "pr-review",
      category: "engineering",
    });
    expect(parsed.nameHint).toBe("pr-review");
    expect(parsed.category).toBe("engineering");
  });

  // ── input: validation failures ────────────────────────────────────────────

  it("rejects a prompt shorter than 10 characters", () => {
    expect(() => skillDraft.input.parse({ prompt: "too short" })).toThrow();
  });

  it("rejects a prompt longer than 4000 characters", () => {
    expect(() =>
      skillDraft.input.parse({ prompt: "a".repeat(4001) }),
    ).toThrow();
  });

  it("rejects a nameHint with uppercase letters", () => {
    expect(() =>
      skillDraft.input.parse({
        prompt: "Teach the agent how to refactor TypeScript code",
        nameHint: "TypeScript-Refactor",
      }),
    ).toThrow();
  });

  it("rejects a nameHint with spaces or underscores", () => {
    expect(() =>
      skillDraft.input.parse({
        prompt: "Teach the agent how to review code",
        nameHint: "code review",
      }),
    ).toThrow();
    expect(() =>
      skillDraft.input.parse({
        prompt: "Teach the agent how to debug errors",
        nameHint: "debug_errors",
      }),
    ).toThrow();
  });

  it("accepts a nameHint with digits and hyphens", () => {
    const parsed = skillDraft.input.parse({
      prompt: "Teach the agent to use the v2 API correctly",
      nameHint: "api-v2-usage",
    });
    expect(parsed.nameHint).toBe("api-v2-usage");
  });

  // ── output: valid shapes ──────────────────────────────────────────────────

  it("parses a valid draft output", () => {
    const parsed = skillDraft.output.parse({
      draft: VALID_DRAFT,
      content: VALID_CONTENT,
      artifact: VALID_ARTIFACT,
    });
    expect(parsed.draft.displayName).toBe("PR Review");
    expect(parsed.draft.slug).toBe("pr-review");
    expect(parsed.draft.weight).toBe("high");
    expect(parsed.content).toContain("schema_version");
    expect(parsed.artifact.name).toBe("pr-review");
  });

  it("parses a draft without a category", () => {
    const { category: _omitted, ...noCategory } = VALID_DRAFT;
    const parsed = skillDraft.output.parse({
      draft: noCategory,
      content: VALID_CONTENT,
      artifact: VALID_ARTIFACT,
    });
    expect(parsed.draft.category).toBeUndefined();
  });

  it("rejects a draft with an invalid weight", () => {
    expect(() =>
      skillDraft.output.parse({
        draft: { ...VALID_DRAFT, weight: "medium" },
        content: VALID_CONTENT,
        artifact: VALID_ARTIFACT,
      }),
    ).toThrow();
  });

  it("rejects output missing content", () => {
    expect(() => skillDraft.output.parse({ draft: VALID_DRAFT })).toThrow();
  });

  it("rejects output missing draft fields", () => {
    const { body: _omitted, ...noBody } = VALID_DRAFT;
    expect(() =>
      skillDraft.output.parse({
        draft: noBody,
        content: VALID_CONTENT,
        artifact: VALID_ARTIFACT,
      }),
    ).toThrow();
  });

  // ── capability registry ───────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("draft_skill")).toBe(skillDraft);
  });

  it("has mode sync and is scoped", () => {
    expect(skillDraft.mode).toBe("sync");
    expect(skillDraft.scoped).toBe(true);
  });

  it("surfaces include api, mcp, and agent", () => {
    expect(skillDraft.surfaces).toContain("api");
    expect(skillDraft.surfaces).toContain("mcp");
    expect(skillDraft.surfaces).toContain("agent");
  });

  it("layers include unit and docs", () => {
    expect(skillDraft.layers).toContain("unit");
    expect(skillDraft.layers).toContain("docs");
  });

  it("defaultEffect is deny", () => {
    expect(skillDraft.defaultEffect).toBe("deny");
  });

  it("org Owner and Admin are allowed", () => {
    expect(skillDraft.defaultRoles.org?.Owner).toBe("allow");
    expect(skillDraft.defaultRoles.org?.Admin).toBe("allow");
  });

  it("workspace Owner, Admin, and Member are allowed", () => {
    expect(skillDraft.defaultRoles.workspace?.Owner).toBe("allow");
    expect(skillDraft.defaultRoles.workspace?.Admin).toBe("allow");
    expect(skillDraft.defaultRoles.workspace?.Member).toBe("allow");
  });
});
