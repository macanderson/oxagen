/**
 * buildSystemPrompt has two behavioural profiles that must stay distinct:
 *
 * - "interactive" (the default) narrates for a live watcher.
 * - "headless" strips the narration tax and mandates an explicit
 *   reproduce → localize → fix → re-test verification protocol.
 *
 * Both must keep the profile-independent tool rules — chief among them the
 * graph-first context-gathering mandate, which must never reference a tool
 * that is not wired for the run (hasCodeGraph / hasCodeMap).
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

const base = { cwd: "/repo" } as const;

describe("buildSystemPrompt — profiles", () => {
  it("headless adds the verification protocol and drops the live narration", () => {
    const p = buildSystemPrompt({ ...base, profile: "headless" });
    expect(p).toContain("Verification protocol");
    expect(p).toContain("Reproduce");
    expect(p).toContain("SMALLEST");
    expect(p.toLowerCase()).toContain("regress");
    // The interactive narration tax must be gone. (Note: the source wraps
    // "…watches this stream\nlive…" across a line, so assert on the contiguous
    // "watches this stream" plus the "NARRATE AS YOU GO" header.)
    expect(p).not.toContain("watches this stream");
    expect(p).not.toContain("NARRATE AS YOU GO");
  });

  it("headless bounds verification with an explicit stopping budget", () => {
    const p = buildSystemPrompt({ ...base, profile: "headless" });
    expect(p).toContain("VERIFICATION BUDGET");
    expect(p).toContain("exactly three green signals");
    expect(p).toContain("broader relevant test module ONCE");
    expect(p).toContain("do not write demonstration or summary");
    // The budget is a headless concern only — no live watcher to reassure.
    expect(buildSystemPrompt(base)).not.toContain("VERIFICATION BUDGET");
  });

  it("interactive (default) keeps the live narration and omits the protocol", () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain("watches this stream");
    expect(p).toContain("NARRATE AS YOU GO");
    expect(p).not.toContain("Verification protocol");
    // An explicit "interactive" is identical to the default.
    expect(buildSystemPrompt({ ...base, profile: "interactive" })).toBe(p);
  });

  it("both profiles share the profile-independent tool rules", () => {
    const shared = "Prefer `edit_file` for surgical changes";
    expect(buildSystemPrompt({ ...base, profile: "headless" })).toContain(shared);
    expect(buildSystemPrompt({ ...base, profile: "interactive" })).toContain(shared);
    // The shared "read before you edit" rule reaches both, too.
    const readFirst = "`read_file` it first";
    expect(buildSystemPrompt({ ...base, profile: "headless" })).toContain(readFirst);
    expect(buildSystemPrompt({ ...base, profile: "interactive" })).toContain(readFirst);
  });
});

describe("buildSystemPrompt — graph-first tool guidance", () => {
  it("mandates code_graph FIRST as a hard rule, lists every operation, and never references the unwired code_map", () => {
    const prompt = buildSystemPrompt(base);
    // A forceful, prominent mandate — not a soft preference the model shrugs off.
    expect(prompt).toContain("CODE GRAPH FIRST");
    expect(prompt).toContain("non-negotiable");
    expect(prompt).toContain("you MUST query");
    expect(prompt).toContain("STOP and call it first");
    // Every operation, with the exact trigger, so the model knows what to call when.
    expect(prompt).toContain("`search <symbol>`");
    expect(prompt).toContain("`file_symbols <file>`");
    expect(prompt).toContain("`dependents <file>`");
    expect(prompt).toContain("`imports <file>`");
    expect(prompt).toContain("Only fall back to `grep`");
    // code_map is optional and rarely wired — a rule pointing at a missing
    // tool silently breaks the graph-first habit, so it must be opt-in.
    expect(prompt).not.toContain("code_map");
  });

  it("mentions code_map only when the tool is wired", () => {
    const prompt = buildSystemPrompt({ ...base, hasCodeMap: true });
    expect(prompt).toContain("call `code_map` BEFORE `grep` or `bash`");
  });

  it("drops graph guidance and keeps plain grep guidance when code_graph is not wired", () => {
    const prompt = buildSystemPrompt({ ...base, hasCodeGraph: false });
    expect(prompt).not.toContain("code_graph");
    expect(prompt).toContain(
      "Use `grep` and `glob` to locate code instead of guessing paths.",
    );
  });

  it("headless localization step lists only the wired locate tools, graph first", () => {
    const withGraph = buildSystemPrompt({ ...base, profile: "headless" });
    expect(withGraph).toContain("use `code_graph`/`grep` (in that order)");
    expect(withGraph).not.toContain("code_map");
    const bare = buildSystemPrompt({ ...base, profile: "headless", hasCodeGraph: false });
    expect(bare).toContain("use `grep` to find the real source");
    expect(bare).not.toContain("code_graph");
  });

  it("keeps graph-first guidance alongside a named agent persona", () => {
    const prompt = buildSystemPrompt({
      ...base,
      agent: { name: "reviewer", systemPrompt: "You are a reviewer." },
    });
    expect(prompt).toContain("You are a reviewer.");
    expect(prompt).toContain("GRAPH FIRST");
  });
});
