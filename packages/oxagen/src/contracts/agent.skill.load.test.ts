import { describe, expect, it } from "vitest";
import { agentSkillLoad } from "./agent.skill.load";
import { getCapability } from "../registry";

describe("agent.skill.load capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("parses minimal input with only skillSlug", () => {
    const parsed = agentSkillLoad.input.parse({ skillSlug: "summarize" });
    expect(parsed.skillSlug).toBe("summarize");
  });

  it("rejects input missing skillSlug", () => {
    expect(() => agentSkillLoad.input.parse({})).toThrow();
  });

  it("rejects wrong type for skillSlug", () => {
    expect(() => agentSkillLoad.input.parse({ skillSlug: 42 })).toThrow();
  });

  // ── input: optional version ───────────────────────────────────────────────

  it("accepts an exact integer version string", () => {
    const parsed = agentSkillLoad.input.parse({
      skillSlug: "summarize",
      version: "3",
    });
    expect(parsed.version).toBe("3");
  });

  it("accepts a caret version constraint", () => {
    const parsed = agentSkillLoad.input.parse({
      skillSlug: "summarize",
      version: "^2",
    });
    expect(parsed.version).toBe("^2");
  });

  it("accepts a tilde version constraint", () => {
    const parsed = agentSkillLoad.input.parse({
      skillSlug: "summarize",
      version: "~2",
    });
    expect(parsed.version).toBe("~2");
  });

  it("accepts version omitted (latest)", () => {
    const parsed = agentSkillLoad.input.parse({ skillSlug: "summarize" });
    expect(parsed.version).toBeUndefined();
  });

  // ── input: optional dependencies ──────────────────────────────────────────

  it("accepts an empty dependencies array", () => {
    const parsed = agentSkillLoad.input.parse({
      skillSlug: "summarize",
      dependencies: [],
    });
    expect(parsed.dependencies).toEqual([]);
  });

  it("accepts a populated dependencies array", () => {
    const parsed = agentSkillLoad.input.parse({
      skillSlug: "summarize",
      dependencies: ["search", "classify"],
    });
    expect(parsed.dependencies).toEqual(["search", "classify"]);
  });

  it("rejects dependencies containing non-strings", () => {
    expect(() =>
      agentSkillLoad.input.parse({
        skillSlug: "summarize",
        dependencies: [123],
      }),
    ).toThrow();
  });

  // ── input: wrong types ────────────────────────────────────────────────────

  it("rejects dependencies as a string instead of array", () => {
    expect(() =>
      agentSkillLoad.input.parse({
        skillSlug: "summarize",
        dependencies: "search",
      }),
    ).toThrow();
  });

  // ── output: valid full shape ───────────────────────────────────────────────

  it("parses a valid output with no dependency errors", () => {
    const parsed = agentSkillLoad.output.parse({
      skillSlug: "summarize",
      loaded: true,
      versionLoaded: 3,
      body: "You are a summarization assistant...",
      capabilities: ["summarize.text", "summarize.url"],
      dependencyErrors: [],
    });
    expect(parsed.skillSlug).toBe("summarize");
    expect(parsed.loaded).toBe(true);
    expect(parsed.versionLoaded).toBe(3);
    expect(parsed.capabilities).toHaveLength(2);
    expect(parsed.dependencyErrors).toHaveLength(0);
  });

  it("parses output with dependency errors", () => {
    const parsed = agentSkillLoad.output.parse({
      skillSlug: "summarize",
      loaded: false,
      versionLoaded: 0,
      body: "",
      capabilities: [],
      dependencyErrors: [
        { slug: "search", reason: "version not found" },
        { slug: "classify", reason: "not installed" },
      ],
    });
    expect(parsed.loaded).toBe(false);
    expect(parsed.dependencyErrors).toHaveLength(2);
    expect(parsed.dependencyErrors[0]?.reason).toBe("version not found");
  });

  it("rejects output missing body", () => {
    expect(() =>
      agentSkillLoad.output.parse({
        skillSlug: "summarize",
        loaded: true,
        versionLoaded: 1,
        capabilities: [],
        dependencyErrors: [],
      }),
    ).toThrow();
  });

  it("rejects output with non-boolean loaded", () => {
    expect(() =>
      agentSkillLoad.output.parse({
        skillSlug: "summarize",
        loaded: "true",
        versionLoaded: 1,
        body: "content",
        capabilities: [],
        dependencyErrors: [],
      }),
    ).toThrow();
  });

  it("rejects output missing dependencyErrors", () => {
    expect(() =>
      agentSkillLoad.output.parse({
        skillSlug: "summarize",
        loaded: true,
        versionLoaded: 1,
        body: "content",
        capabilities: [],
      }),
    ).toThrow();
  });

  it("rejects a dependency error entry missing reason", () => {
    expect(() =>
      agentSkillLoad.output.parse({
        skillSlug: "summarize",
        loaded: false,
        versionLoaded: 0,
        body: "",
        capabilities: [],
        dependencyErrors: [{ slug: "search" }],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("load_skill")).toBe(agentSkillLoad);
  });
});
