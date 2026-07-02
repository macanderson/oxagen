import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt — graph-first tool guidance", () => {
  it("mandates code_graph as the FIRST choice by default and never references the unwired code_map", () => {
    const prompt = buildSystemPrompt({ cwd: "/repo" });
    expect(prompt).toContain("GRAPH FIRST");
    expect(prompt).toContain("`code_graph` is your FIRST choice");
    expect(prompt).toContain("`file_symbols`");
    expect(prompt).toContain("`dependents`");
    expect(prompt).toContain("Only fall back to `grep`");
    // code_map is optional and rarely wired — a rule pointing at a missing
    // tool silently breaks the graph-first habit, so it must be opt-in.
    expect(prompt).not.toContain("code_map");
  });

  it("mentions code_map only when the tool is wired", () => {
    const prompt = buildSystemPrompt({ cwd: "/repo", hasCodeMap: true });
    expect(prompt).toContain("call `code_map` BEFORE `grep` or `bash`");
  });

  it("drops graph guidance and keeps plain grep guidance when code_graph is not wired", () => {
    const prompt = buildSystemPrompt({ cwd: "/repo", hasCodeGraph: false });
    expect(prompt).not.toContain("code_graph");
    expect(prompt).toContain(
      "Use `grep` and `glob` to locate code instead of guessing paths.",
    );
  });

  it("keeps graph-first guidance alongside a named agent persona", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      agent: { name: "reviewer", systemPrompt: "You are a reviewer." },
    });
    expect(prompt).toContain("You are a reviewer.");
    expect(prompt).toContain("GRAPH FIRST");
  });
});
