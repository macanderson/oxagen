/**
 * Unit coverage for run-spec-v1-legacy.ts — the RETAINED legacy admission
 * contract (02-run-attempt-foundation-plan.md Task 6, PR 1A compatibility
 * slice).
 *
 * Two properties matter here and they pull in opposite directions:
 *
 *  1. **Nothing about v1 changed.** This module absorbed two duplicate
 *     definitions (the API route's and the turn driver's). Every assertion
 *     below that mirrors the old behavior — the exact error strings, the
 *     non-strict unknown-key stripping, the omitted-vs-undefined enqueue shape
 *     — exists so a "centralization" that quietly altered legacy semantics
 *     fails here rather than in production on a queued row.
 *  2. **v1 can never become v2.** A `version: 2` body must be REFUSED by the
 *     legacy parser, not coerced, because the v1 execution path has no fenced
 *     attempt to append into.
 */
import { describe, it, expect } from "vitest";
import {
  LEGACY_RUN_SPEC_VERSION,
  LEGACY_CODE_MODE_SURFACES,
  isLegacyCodeModeSurface,
  runSpecV1Schema,
  parseRunSpecV1,
  buildLegacyRunSpecV1,
  type RunSpecV1,
} from "./run-spec-v1-legacy";

const VALID: RunSpecV1 = { version: 1, instruction: "do the thing" };

describe("parseRunSpecV1 — accepted shapes", () => {
  it("accepts the minimal spec (version + instruction only)", () => {
    expect(parseRunSpecV1(VALID)).toEqual(VALID);
  });

  it("accepts every optional field together", () => {
    const spec = {
      version: 1,
      instruction: "fix the failing test",
      model: "claude-sonnet",
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
      toolPolicy: { allowlist: ["read_file", "bash"], riskCeiling: "medium" },
    };
    expect(parseRunSpecV1(spec)).toEqual(spec);
  });

  it("keeps unmodelled history-message fields (passthrough, not stripped)", () => {
    const parsed = parseRunSpecV1({
      version: 1,
      instruction: "x",
      history: [{ role: "tool", content: null, toolCallId: "call_1" }],
    });
    expect(parsed.history?.[0]).toMatchObject({ toolCallId: "call_1" });
  });

  it("STRIPS an unknown top-level key instead of rejecting it", () => {
    // Non-strict on the claim side by design: a newer enqueuing build adding
    // an additive field must not make already-queued rows unclaimable.
    const parsed = parseRunSpecV1({
      version: 1,
      instruction: "x",
      somethingNewer: true,
    });
    expect(parsed).toEqual({ version: 1, instruction: "x" });
    expect("somethingNewer" in parsed).toBe(false);
  });
});

describe("parseRunSpecV1 — rejections", () => {
  it.each([
    ["null", null, "expected an object, got null"],
    ["a string", "nope", "expected an object, got string"],
    ["a number", 7, "expected an object, got number"],
    ["undefined", undefined, "expected an object, got undefined"],
  ])("rejects %s", (_label, raw, fragment) => {
    expect(() => parseRunSpecV1(raw)).toThrow(fragment);
  });

  it("rejects a missing version with the version message, not a schema dump", () => {
    expect(() => parseRunSpecV1({ instruction: "x" })).toThrow(
      "unsupported version undefined",
    );
  });

  it("REFUSES a RunSpecV2 body — v1 execution has no fenced attempt to write into", () => {
    expect(() =>
      parseRunSpecV1({
        version: 2,
        goal: "edit the repo",
        run_kind: "general",
      }),
    ).toThrow("unsupported version 2");
  });

  it("rejects a missing instruction", () => {
    expect(() => parseRunSpecV1({ version: 1 })).toThrow(/instruction/);
  });

  it("rejects an empty instruction with the field-prefixed message", () => {
    expect(() => parseRunSpecV1({ version: 1, instruction: "" })).toThrow(
      "instruction: instruction must not be empty",
    );
  });

  it("rejects an invalid riskCeiling", () => {
    expect(() =>
      parseRunSpecV1({
        version: 1,
        instruction: "x",
        toolPolicy: { riskCeiling: "extreme" },
      }),
    ).toThrow(/toolPolicy.riskCeiling/);
  });

  it("accepts toolPolicy.ontology, the per-run graph grant", () => {
    const parsed = parseRunSpecV1({
      version: 1,
      instruction: "which accounts are at renewal risk?",
      toolPolicy: { allowlist: ["read_file"], ontology: true },
    });
    expect(parsed.toolPolicy?.ontology).toBe(true);
  });

  it("leaves toolPolicy.ontology undefined when a run does not ask", () => {
    // Absent, not false — the driver reads `=== true`, so an omitted flag and
    // an explicit false mean the same thing and neither grants the graph.
    const parsed = parseRunSpecV1({
      version: 1,
      instruction: "x",
      toolPolicy: { allowlist: ["read_file"] },
    });
    expect(parsed.toolPolicy?.ontology).toBeUndefined();
  });

  it("rejects a non-boolean toolPolicy.ontology", () => {
    expect(() =>
      parseRunSpecV1({
        version: 1,
        instruction: "x",
        toolPolicy: { ontology: "yes" },
      }),
    ).toThrow(/toolPolicy.ontology/);
  });

  it("rejects an unrecognized history role", () => {
    expect(() =>
      parseRunSpecV1({
        version: 1,
        instruction: "x",
        history: [{ role: "narrator", content: "x" }],
      }),
    ).toThrow(/history\.0\.role/);
  });

  it("joins multiple issues into one message", () => {
    let message = "";
    try {
      parseRunSpecV1({ version: 1, instruction: "", model: "" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("instruction:");
    expect(message).toContain("model:");
    expect(message).toContain("; ");
  });

  it("throws a plain Error — never a typed v2 admission error", () => {
    // A legacy parse failure must not be reportable as a governed-admission
    // rejection: the two have different security meanings.
    try {
      parseRunSpecV1({ version: 1 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(err)).toBe(Error.prototype);
      expect((err as { issues?: unknown }).issues).toBeUndefined();
    }
  });
});

describe("buildLegacyRunSpecV1", () => {
  it("emits version + instruction and OMITS absent optional keys", () => {
    const spec = buildLegacyRunSpecV1({ instruction: "hi" });
    expect(Object.keys(spec).sort()).toEqual(["instruction", "version"]);
    expect(spec.version).toBe(LEGACY_RUN_SPEC_VERSION);
  });

  it("includes model and toolPolicy when supplied", () => {
    const spec = buildLegacyRunSpecV1({
      instruction: "hi",
      model: "claude-sonnet",
      toolPolicy: { allowlist: ["read_file"], riskCeiling: "low" },
    });
    expect(spec).toEqual({
      version: 1,
      instruction: "hi",
      model: "claude-sonnet",
      toolPolicy: { allowlist: ["read_file"], riskCeiling: "low" },
    });
  });

  it("never writes an explicit `undefined` value for an omitted key", () => {
    // JSON.stringify drops undefined silently, so an accidental
    // `model: undefined` would be invisible at the SQL boundary but visible
    // to every in-process key check.
    const spec = buildLegacyRunSpecV1({ instruction: "hi" });
    expect(Object.prototype.hasOwnProperty.call(spec, "model")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(spec, "toolPolicy")).toBe(
      false,
    );
  });

  it("round-trips through the parser (writer and reader agree)", () => {
    const spec = buildLegacyRunSpecV1({
      instruction: "hi",
      model: "m",
      toolPolicy: { riskCeiling: "high" },
    });
    expect(parseRunSpecV1(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });
});

describe("legacy code-mode labelling", () => {
  it("labels repo-edit as code mode", () => {
    expect(isLegacyCodeModeSurface("repo-edit")).toBe(true);
  });

  it.each(["api-chat", "chat", "a2a", "", "REPO-EDIT"])(
    "does not label %o as code mode",
    (surface) => {
      expect(isLegacyCodeModeSurface(surface)).toBe(false);
    },
  );

  it("exposes exactly one code-mode surface today", () => {
    // A second entry is a real policy change (PR 1B's contract guard and the
    // drain query both key off this set) — it should not land unnoticed.
    expect([...LEGACY_CODE_MODE_SURFACES]).toEqual(["repo-edit"]);
  });
});

describe("runSpecV1Schema", () => {
  it("is exported so a caller can safeParse without the throwing wrapper", () => {
    expect(runSpecV1Schema.safeParse(VALID).success).toBe(true);
    expect(runSpecV1Schema.safeParse({ version: 2 }).success).toBe(false);
  });
});
