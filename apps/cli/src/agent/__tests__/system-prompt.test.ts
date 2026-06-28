import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../system-prompt.js";

describe("buildSystemPrompt", () => {
  it("uses the default oxagen identity with no agent", () => {
    const prompt = buildSystemPrompt({ cwd: "/repo" });
    expect(prompt).toContain("You are oxagen");
    expect(prompt).toContain("Operating rules:");
  });

  it("replaces the identity with the agent's system prompt", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      agent: { name: "reviewer", systemPrompt: "You are a meticulous code reviewer." },
    });
    expect(prompt).toContain("You are a meticulous code reviewer.");
    expect(prompt).not.toContain("You are oxagen");
    // Operating rules + environment are still present.
    expect(prompt).toContain("Operating rules:");
    expect(prompt).toContain("cwd: /repo");
  });

  it("still appends the read-only notice for an agent", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      readOnly: true,
      agent: { name: "x", systemPrompt: "Persona." },
    });
    expect(prompt).toContain("READ-ONLY MODE");
  });
});
