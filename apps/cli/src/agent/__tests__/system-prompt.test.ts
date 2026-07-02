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

  it("interactive (default) narrates; headless swaps in the verification protocol", () => {
    const interactive = buildSystemPrompt({ cwd: "/repo" });
    // Source wraps "watches this stream\nlive", so assert the contiguous slice.
    expect(interactive).toContain("watches this stream");
    expect(interactive).toContain("NARRATE AS YOU GO");
    expect(interactive).not.toContain("Verification protocol");
    // The default equals an explicit "interactive".
    expect(buildSystemPrompt({ cwd: "/repo", profile: "interactive" })).toBe(interactive);

    const headless = buildSystemPrompt({ cwd: "/repo", profile: "headless" });
    expect(headless).toContain("Verification protocol");
    expect(headless).toContain("Reproduce");
    expect(headless).toContain("SMALLEST");
    expect(headless.toLowerCase()).toContain("regress");
    expect(headless).not.toContain("watches this stream");
    expect(headless).not.toContain("NARRATE AS YOU GO");

    // Both profiles keep the shared tool rules.
    const shared = "Prefer `edit_file` for surgical changes";
    expect(interactive).toContain(shared);
    expect(headless).toContain(shared);
  });
});
