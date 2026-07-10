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
import { buildSystemPrompt, buildCodingCorePrompt } from "./system-prompt";

const base = { cwd: "/repo" } as const;

describe("buildCodingCorePrompt — shared coding core (ADR-021 §7)", () => {
  // The engine's DEFAULT_SYSTEM is built from this with no adapters — it MUST
  // render the historical string byte-for-byte so the cache prefix stays stable.
  const HISTORICAL_DEFAULT_SYSTEM =
    "You are an expert software engineer working in a checked-out repository. " +
    "Use the provided tools to read, search, and edit files and run commands. " +
    "Make the smallest correct change that satisfies the request, run the repo's " +
    "tests or build when relevant, and stop when the task is complete.";

  it("renders the historical DEFAULT_SYSTEM byte-for-byte with no adapters", () => {
    expect(buildCodingCorePrompt()).toBe(HISTORICAL_DEFAULT_SYSTEM);
  });

  it("lets a surface override the identity while keeping the shared discipline", () => {
    const p = buildCodingCorePrompt({
      identity: "You are oxagen, running in the terminal.",
    });
    expect(p.startsWith("You are oxagen, running in the terminal.")).toBe(true);
    expect(p).toContain("Use the provided tools to read, search, and edit");
    expect(p).toContain("Make the smallest correct change");
  });

  it("appends surface sections after the core, dropping blank ones", () => {
    const p = buildCodingCorePrompt({
      extraSections: ["## Extra\nrule one", "   ", ""],
    });
    expect(p).toContain(HISTORICAL_DEFAULT_SYSTEM);
    expect(p).toContain("## Extra\nrule one");
    // Exactly one blank-line separator between core and the single kept section.
    expect(p).toBe(`${HISTORICAL_DEFAULT_SYSTEM}\n\n## Extra\nrule one`);
  });
});

describe("buildSystemPrompt — pinned file-tool root rule", () => {
  it("warns in BOTH profiles that file tools ignore bash `cd` and need absolute paths outside cwd", () => {
    for (const profile of ["interactive", "headless"] as const) {
      const p = buildSystemPrompt({ ...base, profile });
      expect(p).toContain("FILE-TOOL ROOT IS PINNED");
      expect(p).toContain("NEVER persists");
      expect(p).toContain("ABSOLUTE paths");
      expect(p).toContain("git worktree");
    }
  });
});

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
    expect(buildSystemPrompt({ ...base, profile: "headless" })).toContain(
      shared,
    );
    expect(buildSystemPrompt({ ...base, profile: "interactive" })).toContain(
      shared,
    );
    // The shared "read before you edit" rule reaches both, too.
    const readFirst = "`read_file` it first";
    expect(buildSystemPrompt({ ...base, profile: "headless" })).toContain(
      readFirst,
    );
    expect(buildSystemPrompt({ ...base, profile: "interactive" })).toContain(
      readFirst,
    );
  });

  it("both profiles mention A2A cross-agent interop: skillId addressing, resubscribe, and trace lineage", () => {
    for (const profile of ["headless", "interactive"] as const) {
      const p = buildSystemPrompt({ ...base, profile });
      expect(p).toContain("A2A");
      expect(p).toContain("message.metadata.skillId");
      expect(p).toContain("tasks/resubscribe");
      expect(p.toLowerCase()).toContain("get_execution_trace");
    }
  });
});

describe("buildSystemPrompt — graph-first tool guidance", () => {
  it("mandates code_graph FIRST as a hard rule and lists every operation", () => {
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
    const bare = buildSystemPrompt({
      ...base,
      profile: "headless",
      hasCodeGraph: false,
    });
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

describe("buildSystemPrompt — F1 localization trust-but-verify rule", () => {
  it("adds the spec's one-line rule when a localization block was injected this turn", () => {
    const prompt = buildSystemPrompt({ ...base, hasLocalization: true });
    expect(prompt).toContain(
      "Candidate locations were computed from the code graph.",
    );
    expect(prompt).toContain("Verify with one read before");
    expect(prompt).toContain("do not re-derive them.");
  });

  it("omits the rule by default — no rule about a block the model never received", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).not.toContain("Candidate locations were computed");
    expect(prompt).not.toContain("re-derive");
  });

  it("keeps the rule on the headless profile alongside the verification protocol", () => {
    const prompt = buildSystemPrompt({
      ...base,
      profile: "headless",
      hasLocalization: true,
    });
    expect(prompt).toContain(
      "Candidate locations were computed from the code graph.",
    );
    expect(prompt).toContain("Verification protocol");
  });
});
