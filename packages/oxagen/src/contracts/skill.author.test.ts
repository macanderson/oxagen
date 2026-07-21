import { describe, expect, it } from "vitest";
import { skillAuthor } from "./skill.author";
import { getCapability } from "../registry";

describe("skill.author capability", () => {
  // ── input: valid paths ────────────────────────────────────────────────────

  it("accepts a minimal valid prompt", () => {
    const parsed = skillAuthor.input.parse({
      prompt: "Teach the agent how to review PRs",
    });
    expect(parsed.prompt).toBe("Teach the agent how to review PRs");
    expect(parsed.activate).toBe(true); // default
    expect(parsed.nameHint).toBeUndefined();
    expect(parsed.category).toBeUndefined();
  });

  it("accepts a prompt with all optional fields", () => {
    const parsed = skillAuthor.input.parse({
      prompt: "Teach the agent how to review pull requests effectively",
      nameHint: "pr-review",
      category: "engineering",
      activate: false,
      workspace_id: "ws_abc",
    });
    expect(parsed.nameHint).toBe("pr-review");
    expect(parsed.category).toBe("engineering");
    expect(parsed.activate).toBe(false);
    expect(parsed.workspace_id).toBe("ws_abc");
  });

  it("accepts a prompt with only nameHint provided", () => {
    const parsed = skillAuthor.input.parse({
      prompt: "Teach the agent how to write commit messages",
      nameHint: "commit-style",
    });
    expect(parsed.nameHint).toBe("commit-style");
  });

  it("defaults activate to true when not provided", () => {
    const parsed = skillAuthor.input.parse({
      prompt: "Teach the agent about code style conventions",
    });
    expect(parsed.activate).toBe(true);
  });

  // ── input: validation failures ────────────────────────────────────────────

  it("rejects a prompt shorter than 10 characters", () => {
    expect(() => skillAuthor.input.parse({ prompt: "too short" })).toThrow();
  });

  it("rejects a prompt longer than 4000 characters", () => {
    expect(() =>
      skillAuthor.input.parse({ prompt: "a".repeat(4001) }),
    ).toThrow();
  });

  it("rejects a nameHint with uppercase letters", () => {
    expect(() =>
      skillAuthor.input.parse({
        prompt: "Teach the agent how to refactor TypeScript code",
        nameHint: "TypeScript-Refactor",
      }),
    ).toThrow();
  });

  it("rejects a nameHint with spaces", () => {
    expect(() =>
      skillAuthor.input.parse({
        prompt: "Teach the agent how to review code",
        nameHint: "code review",
      }),
    ).toThrow();
  });

  it("rejects a nameHint with underscores", () => {
    expect(() =>
      skillAuthor.input.parse({
        prompt: "Teach the agent how to debug errors",
        nameHint: "debug_errors",
      }),
    ).toThrow();
  });

  it("accepts a nameHint with digits and hyphens", () => {
    const parsed = skillAuthor.input.parse({
      prompt: "Teach the agent to use the v2 API correctly",
      nameHint: "api-v2-usage",
    });
    expect(parsed.nameHint).toBe("api-v2-usage");
  });

  // ── output: valid shapes ──────────────────────────────────────────────────

  it("parses a valid output for a new install", () => {
    const parsed = skillAuthor.output.parse({
      publicId: "skl_ABC123",
      slug: "pr-review",
      content: 'schema_version = 1\nkind = "skill"\nname = "pr-review"\n',
      activeVersion: 1,
      installed: true,
    });
    expect(parsed.publicId).toBe("skl_ABC123");
    expect(parsed.slug).toBe("pr-review");
    expect(parsed.activeVersion).toBe(1);
    expect(parsed.installed).toBe(true);
  });

  it("parses a valid output for an idempotent (already-exists) result", () => {
    const parsed = skillAuthor.output.parse({
      publicId: "skl_XYZ",
      slug: "pr-review",
      content: 'schema_version = 1\nkind = "skill"\nname = "pr-review"\n',
      activeVersion: 2,
      installed: false,
    });
    expect(parsed.installed).toBe(false);
    expect(parsed.activeVersion).toBe(2);
  });

  it("rejects output with non-positive activeVersion", () => {
    expect(() =>
      skillAuthor.output.parse({
        publicId: "skl_ABC",
        slug: "pr-review",
        content: 'schema_version = 1\nkind = "skill"\n',
        activeVersion: 0,
        installed: true,
      }),
    ).toThrow();
  });

  it("rejects output missing publicId", () => {
    expect(() =>
      skillAuthor.output.parse({
        slug: "pr-review",
        content: 'schema_version = 1\nkind = "skill"\n',
        activeVersion: 1,
        installed: true,
      }),
    ).toThrow();
  });

  it("rejects output with non-boolean installed", () => {
    expect(() =>
      skillAuthor.output.parse({
        publicId: "skl_ABC",
        slug: "pr-review",
        content: 'schema_version = 1\nkind = "skill"\n',
        activeVersion: 1,
        installed: "yes",
      }),
    ).toThrow();
  });

  // ── capability registry ───────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("author_skill")).toBe(skillAuthor);
  });

  it("has mode sync", () => {
    expect(skillAuthor.mode).toBe("sync");
  });

  it("is scoped", () => {
    expect(skillAuthor.scoped).toBe(true);
  });

  it("surfaces include api, mcp, and agent", () => {
    expect(skillAuthor.surfaces).toContain("api");
    expect(skillAuthor.surfaces).toContain("mcp");
    expect(skillAuthor.surfaces).toContain("agent");
  });

  it("layers include unit and docs", () => {
    expect(skillAuthor.layers).toContain("unit");
    expect(skillAuthor.layers).toContain("docs");
  });

  it("defaultEffect is deny", () => {
    expect(skillAuthor.defaultEffect).toBe("deny");
  });

  it("org Owner and Admin are allowed", () => {
    expect(skillAuthor.defaultRoles.org?.Owner).toBe("allow");
    expect(skillAuthor.defaultRoles.org?.Admin).toBe("allow");
  });

  it("workspace Owner, Admin, and Member are allowed", () => {
    expect(skillAuthor.defaultRoles.workspace?.Owner).toBe("allow");
    expect(skillAuthor.defaultRoles.workspace?.Admin).toBe("allow");
    expect(skillAuthor.defaultRoles.workspace?.Member).toBe("allow");
  });
});
