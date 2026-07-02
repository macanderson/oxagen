/**
 * buildSystemPrompt has two behavioural profiles that must stay distinct:
 *
 * - "interactive" (the default) narrates for a live watcher.
 * - "headless" strips the narration tax and mandates an explicit
 *   reproduce → localize → fix → re-test verification protocol.
 *
 * Both must keep the profile-independent tool rules. These assertions pin the
 * shape so the two profiles can't silently converge or drop their marker text.
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
