import { describe, expect, it } from "vitest";
import { skillWorkspaceInstall } from "./skill.workspace.install";
import { getCapability } from "../registry";

describe("skill.workspace.install capability", () => {
  // ── input: slug-only path ──────────────────────────────────────────────────

  it("accepts a slug-only input", () => {
    const parsed = skillWorkspaceInstall.input.parse({ slug: "summarization" });
    expect(parsed.slug).toBe("summarization");
    expect(parsed.custom).toBeUndefined();
  });

  it("accepts a custom-only input", () => {
    const parsed = skillWorkspaceInstall.input.parse({
      custom: { content: 'schema_version = 1\nkind = "skill"' },
    });
    expect(parsed.custom?.content).toContain("schema_version");
    expect(parsed.slug).toBeUndefined();
  });

  it("accepts both slug and custom (caller intent — handler enforces xor)", () => {
    const parsed = skillWorkspaceInstall.input.parse({
      slug: "summarization",
      custom: { content: 'schema_version = 1\nkind = "skill"' },
    });
    expect(parsed.slug).toBe("summarization");
    expect(parsed.custom?.content).toContain("schema_version");
  });

  it("accepts an optional workspace_id", () => {
    const parsed = skillWorkspaceInstall.input.parse({
      slug: "coding",
      workspace_id: "ws_abc",
    });
    expect(parsed.workspace_id).toBe("ws_abc");
  });

  it("accepts empty input without slug or custom (handler validates at runtime)", () => {
    const parsed = skillWorkspaceInstall.input.parse({});
    expect(parsed.slug).toBeUndefined();
    expect(parsed.custom).toBeUndefined();
  });

  // ── input: validation ──────────────────────────────────────────────────────

  it("rejects an empty slug string", () => {
    expect(() => skillWorkspaceInstall.input.parse({ slug: "" })).toThrow();
  });

  it("rejects custom without content", () => {
    expect(() =>
      skillWorkspaceInstall.input.parse({ custom: { content: "" } }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid install output (new install)", () => {
    const parsed = skillWorkspaceInstall.output.parse({
      publicId: "skl_ABC123",
      slug: "summarization",
      activeVersion: 1,
      installed: true,
    });
    expect(parsed.publicId).toBe("skl_ABC123");
    expect(parsed.slug).toBe("summarization");
    expect(parsed.activeVersion).toBe(1);
    expect(parsed.installed).toBe(true);
  });

  it("parses a valid install output (idempotent — already existed)", () => {
    const parsed = skillWorkspaceInstall.output.parse({
      publicId: "skl_XYZ",
      slug: "coding",
      activeVersion: 3,
      installed: false,
    });
    expect(parsed.installed).toBe(false);
    expect(parsed.activeVersion).toBe(3);
  });

  it("rejects output with non-positive activeVersion", () => {
    expect(() =>
      skillWorkspaceInstall.output.parse({
        publicId: "skl_ABC",
        slug: "s",
        activeVersion: 0,
        installed: true,
      }),
    ).toThrow();
  });

  it("rejects output missing publicId", () => {
    expect(() =>
      skillWorkspaceInstall.output.parse({
        slug: "summarization",
        activeVersion: 1,
        installed: true,
      }),
    ).toThrow();
  });

  it("rejects output with non-boolean installed", () => {
    expect(() =>
      skillWorkspaceInstall.output.parse({
        publicId: "skl_ABC",
        slug: "s",
        activeVersion: 1,
        installed: "yes",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("install_skill")).toBe(skillWorkspaceInstall);
  });

  it("has mode sync", () => {
    expect(skillWorkspaceInstall.mode).toBe("sync");
  });

  it("is scoped", () => {
    expect(skillWorkspaceInstall.scoped).toBe(true);
  });

  it("surfaces include api and mcp", () => {
    expect(skillWorkspaceInstall.surfaces).toContain("api");
    expect(skillWorkspaceInstall.surfaces).toContain("mcp");
  });
});
