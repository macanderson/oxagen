/**
 * buildSystemPrompt has two behavioural profiles that must stay distinct:
 *
 * - "interactive" (the default) narrates for a live watcher.
 * - "headless" strips the narration tax and mandates an explicit
 *   reproduce → localize → fix → re-test verification protocol.
 *
 * Both must keep the profile-independent tool rules — chief among them the
 * locate-before-you-touch mandate, which must never name a tool the engine
 * does not hand the model.
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

describe("buildSystemPrompt — locate-before-you-touch tool guidance", () => {
  it("instructs batching of independent tool calls into one message (wall-clock parallelism)", () => {
    // The engine runs one step per assistant message and the AI SDK executes
    // ALL of that message's tool calls concurrently — the model just has to be
    // told to batch. Reads batch; edits stay sequential (per-turn file lock).
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain("BATCH INDEPENDENT TOOL CALLS");
    expect(prompt).toContain("ONE message");
    expect(prompt).toContain("File EDITS stay sequential");
  });

  it("names only tools the engine registers — never a code graph", () => {
    // The engine has no code-graph provider on any surface, so the prompt must
    // never steer the model at a `code_graph` tool it will not be handed.
    for (const profile of ["interactive", "headless"] as const) {
      const prompt = buildSystemPrompt({ ...base, profile });
      expect(prompt).not.toContain("code_graph");
      expect(prompt).not.toContain("CODE GRAPH");
    }
  });

  it("tells the model to locate code with the unified search tool", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain("LOCATE BEFORE YOU TOUCH");
    expect(prompt).toContain("Use `search` to find the code");
    // The one query covers both axes — say so, or the model reaches for a
    // path-only tool it no longer has when it only remembers a symbol.
    expect(prompt).toContain("matches both file names and file contents");
  });

  it("headless verification protocol names search as the locate tool", () => {
    const prompt = buildSystemPrompt({ ...base, profile: "headless" });
    expect(prompt).toContain(
      "Localize before editing: use `search` to find the real source",
    );
  });

  it("names `search`, never the split `grep`/`glob` pair it replaced", () => {
    // Stella's catalog carries ONE search over file names and contents, and
    // reserves the names `grep` and `glob` so a merged surface cannot offer
    // them. The prompt is written to that surface on every profile, with or
    // without a persona, so no rule can quietly reintroduce the old pair.
    for (const profile of ["interactive", "headless"] as const) {
      for (const agent of [
        undefined,
        { name: "reviewer", systemPrompt: "You are a reviewer." },
      ]) {
        const prompt = buildSystemPrompt({ ...base, profile, agent });
        expect(prompt).toContain("`search`");
        expect(prompt).not.toContain("`grep`");
        expect(prompt).not.toContain("`glob`");
        expect(prompt).not.toMatch(/\bglob\/grep\b|\bgrep\/glob\b/);
      }
    }
  });

  it("keeps locate guidance alongside a named agent persona", () => {
    const prompt = buildSystemPrompt({
      ...base,
      agent: { name: "reviewer", systemPrompt: "You are a reviewer." },
    });
    expect(prompt).toContain("You are a reviewer.");
    expect(prompt).toContain("LOCATE BEFORE YOU TOUCH");
  });
});

describe("buildSystemPrompt — ask_user clarification rule", () => {
  it("adds the ambiguity rule only when the ask_user tool is wired", () => {
    const prompt = buildSystemPrompt({ ...base, hasAskUser: true });
    expect(prompt).toContain("ASK WHEN TRULY AMBIGUOUS");
    expect(prompt).toContain("`ask_user`");
    expect(prompt).toContain("2-5 concrete, mutually-exclusive options");
    expect(prompt).toContain("never call it more than twice per task");
  });

  it("omits the rule by default — an unwired tool is never mentioned", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).not.toContain("ASK WHEN TRULY AMBIGUOUS");
    expect(prompt).not.toContain("ask_user");
  });

  it("keeps the default (unwired) prompt byte-for-byte stable for prompt caching", () => {
    // hasAskUser defaults false, so passing it explicitly false must render the
    // exact same string as omitting it — no cache-busting drift.
    expect(buildSystemPrompt({ ...base, hasAskUser: false })).toBe(
      buildSystemPrompt(base),
    );
  });
});
