import { describe, it, expect } from "vitest";
import { parseInvocation, applyArgs, expandSlash } from "../expand.js";
import type { SlashCommand } from "../types.js";

function registry(...cmds: Array<Partial<SlashCommand> & { name: string; template: string }>): Map<string, SlashCommand> {
  const m = new Map<string, SlashCommand>();
  for (const c of cmds) m.set(c.name, { description: "", source: "test", ...c });
  return m;
}

describe("parseInvocation", () => {
  it("splits name and args", () => {
    expect(parseInvocation("/review src/x.ts here")).toEqual({ name: "review", args: "src/x.ts here" });
  });
  it("handles a bare command", () => {
    expect(parseInvocation("/status")).toEqual({ name: "status", args: "" });
  });
  it("returns null for non-slash input", () => {
    expect(parseInvocation("hello")).toBeNull();
  });
});

describe("applyArgs", () => {
  it("substitutes $ARGUMENTS", () => {
    expect(applyArgs("Review: $ARGUMENTS", "a b c")).toBe("Review: a b c");
  });
  it("substitutes positional $1/$2 and blanks missing ones", () => {
    expect(applyArgs("$1 vs $2 vs $3", "one two")).toBe("one vs two vs ");
  });
  it("leaves the template intact when there are no placeholders", () => {
    expect(applyArgs("no placeholders", "x")).toBe("no placeholders");
  });
});

describe("expandSlash", () => {
  const reg = registry(
    { name: "review", template: "Review $ARGUMENTS for bugs.", model: "a/b" },
    { name: "explain", template: "Explain $1." },
  );

  it("expands a known command and carries its model", () => {
    const res = expandSlash("/review src/auth.ts", reg);
    expect(res).toEqual({ command: "review", prompt: "Review src/auth.ts for bugs.", model: "a/b" });
  });

  it("returns null for an unknown command", () => {
    expect(expandSlash("/nope x", reg)).toBeNull();
  });

  it("returns an error for non-slash input", () => {
    expect(expandSlash("hello", reg)).toEqual({ error: "not a slash command" });
  });
});
