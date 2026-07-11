/**
 * Coverage for the un-poisonable-edits guard (guard/edit-guard.ts): the
 * stale-read hash anchor, the syntax-regression gate, the in-memory splice
 * reproduction, and the fail-open behavior when the parser is unavailable.
 * House style: dependency injection over module mocking — a MemoryWorkspace
 * plus an injectable TypeScript loader; no vi.mock.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import {
  computeEditResult,
  countSyntaxErrors,
  createEditGuard,
  staleFileDeniedMessage,
  syntaxRegressionDeniedMessage,
} from "./edit-guard";

const VALID_TS = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const BROKEN_TS = `export function add(a: number, b: number): number {\n  return a + b;\n`; // missing closing brace

describe("computeEditResult", () => {
  it("applies a unique exact-match replacement", () => {
    expect(computeEditResult("a b c", "b", "x", false)).toBe("a x c");
  });

  it("returns null when old_string is absent (native error path)", () => {
    expect(computeEditResult("a b c", "z", "x", false)).toBeNull();
  });

  it("returns null when old_string is ambiguous without replace_all", () => {
    expect(computeEditResult("b b", "b", "x", false)).toBeNull();
  });

  it("replaces every occurrence with replace_all", () => {
    expect(computeEditResult("b b", "b", "x", true)).toBe("x x");
  });

  it("returns null for replace_all with zero matches", () => {
    expect(computeEditResult("a", "z", "x", true)).toBeNull();
  });

  it("returns null for an empty old_string", () => {
    expect(computeEditResult("a", "", "x", false)).toBeNull();
  });
});

describe("countSyntaxErrors", () => {
  it("reports zero errors for valid TypeScript", async () => {
    const report = await countSyntaxErrors("a.ts", VALID_TS);
    expect(report).toEqual({ count: 0 });
  });

  it("reports errors with a line-anchored first message for broken TypeScript", async () => {
    const report = await countSyntaxErrors("a.ts", BROKEN_TS);
    expect(report).not.toBeNull();
    expect(report!.count).toBeGreaterThan(0);
    expect(report!.first).toMatch(/line \d+:/);
  });

  it("parses TSX with JSX syntax accepted", async () => {
    const report = await countSyntaxErrors(
      "c.tsx",
      `export const C = () => <div>hello</div>;\n`,
    );
    expect(report).toEqual({ count: 0 });
  });

  it("validates JSON without the TypeScript module", async () => {
    expect(await countSyntaxErrors("p.json", `{"a": 1}`)).toEqual({ count: 0 });
    const broken = await countSyntaxErrors("p.json", `{"a": }`);
    expect(broken!.count).toBe(1);
    expect(broken!.first).toBeTruthy();
  });

  it("returns null for unsupported file types", async () => {
    expect(await countSyntaxErrors("readme.md", "# hi")).toBeNull();
    expect(await countSyntaxErrors("script.py", "def f(:")).toBeNull();
    expect(await countSyntaxErrors("Makefile", "all:")).toBeNull();
  });

  it("fails open (null) when the TypeScript loader yields nothing", async () => {
    const report = await countSyntaxErrors("a.ts", BROKEN_TS, async () => null);
    expect(report).toBeNull();
  });
});

describe("createEditGuard — hash anchor", () => {
  it("denies an edit when the file changed on disk after the recorded read", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    await guard.recordRead("a.ts");
    // Out-of-band mutation (a formatter, bash, or another session).
    await ws.writeFile("a.ts", VALID_TS + "// drifted\n");
    const verdict = await guard.checkEdit("a.ts", "return a + b;", "return b + a;");
    expect(verdict).toEqual({ ok: false, denial: staleFileDeniedMessage("a.ts") });
  });

  it("allows an edit when the file is unchanged since the read", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    await guard.recordRead("a.ts");
    const verdict = await guard.checkEdit("a.ts", "return a + b;", "return b + a;");
    expect(verdict.ok).toBe(true);
  });

  it("performs no check when the file was never read (fail open)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    const verdict = await guard.checkEdit("a.ts", "return a + b;", "return b + a;");
    expect(verdict.ok).toBe(true);
  });

  it("refreshes the anchor after an applied edit so chained edits pass", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    await guard.recordRead("a.ts");
    const first = await guard.checkEdit("a.ts", "return a + b;", "return b + a;");
    expect(first.ok).toBe(true);
    await ws.editFile("a.ts", "return a + b;", "return b + a;");
    await guard.noteEditApplied("a.ts", first.ok ? first.newContent : null);
    const second = await guard.checkEdit("a.ts", "return b + a;", "return a + b;");
    expect(second.ok).toBe(true);
  });

  it("re-reads for the anchor when the splice was not locally computable", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    await guard.recordRead("a.ts");
    await ws.editFile("a.ts", "return a + b;", "return b + a;");
    await guard.noteEditApplied("a.ts", null); // newContent unknown → re-read
    const verdict = await guard.checkEdit("a.ts", "return b + a;", "return a + b;");
    expect(verdict.ok).toBe(true);
  });

  it("keys relative and root-joined absolute paths identically", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS }, "/repo");
    const guard = createEditGuard(ws);
    await guard.recordRead("a.ts");
    guard.recordContent("/repo/a.ts", "something else entirely");
    const verdict = await guard.checkEdit("a.ts", "return a + b;", "return b + a;");
    expect(verdict.ok).toBe(false);
  });

  it("is inert when disabled", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws, { hashGuard: false, syntaxGuard: false });
    await guard.recordRead("a.ts");
    await ws.writeFile("a.ts", "totally different content");
    const verdict = await guard.checkEdit("a.ts", "different", "changed");
    expect(verdict).toEqual({ ok: true, newContent: null });
  });
});

describe("createEditGuard — syntax-regression gate", () => {
  it("denies an edit that would introduce a syntax error, before any write", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    const verdict = await guard.checkEdit("a.ts", "return a + b;\n}", "return a + b;");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.denial).toContain("new syntax error");
      expect(verdict.denial).toContain("a.ts");
    }
    // Nothing was written: the workspace still holds the original content.
    expect(await ws.readFile("a.ts")).toBe(VALID_TS);
  });

  it("allows an edit that keeps the file parsing cleanly", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    const verdict = await guard.checkEdit("a.ts", "a + b", "b + a");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.newContent).toContain("b + a");
  });

  it("gates only the delta: an already-broken file stays editable", async () => {
    const ws = new MemoryWorkspace({ "b.ts": BROKEN_TS });
    const guard = createEditGuard(ws);
    const verdict = await guard.checkEdit("b.ts", "a + b", "b + a");
    expect(verdict.ok).toBe(true);
  });

  it("honors allow_syntax_errors for intentional breakage", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    const verdict = await guard.checkEdit("a.ts", "return a + b;\n}", "return a + b;", {
      allowSyntaxErrors: true,
    });
    expect(verdict.ok).toBe(true);
  });

  it("skips the gate for ambiguous splices (native corrective error path)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x }\nx }\n" });
    const guard = createEditGuard(ws);
    const verdict = await guard.checkEdit("a.ts", "x }", "x");
    expect(verdict).toEqual({ ok: true, newContent: null });
  });

  it("fails open when the TypeScript module cannot be loaded", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws, { loadTs: async () => null });
    const verdict = await guard.checkEdit("a.ts", "return a + b;\n}", "return a + b;");
    expect(verdict.ok).toBe(true);
  });

  it("denies a write_file that would break a currently-clean file", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const guard = createEditGuard(ws);
    const verdict = await guard.checkWrite("a.ts", BROKEN_TS);
    expect(verdict.ok).toBe(false);
  });

  it("denies a NEW file that does not parse (zero pre-existing errors)", async () => {
    const ws = new MemoryWorkspace();
    const guard = createEditGuard(ws);
    const verdict = await guard.checkWrite("fresh.ts", BROKEN_TS);
    expect(verdict.ok).toBe(false);
  });

  it("allows overwriting a broken file with equally-or-less broken content", async () => {
    const ws = new MemoryWorkspace({ "b.ts": BROKEN_TS });
    const guard = createEditGuard(ws);
    expect((await guard.checkWrite("b.ts", BROKEN_TS)).ok).toBe(true);
    expect((await guard.checkWrite("b.ts", VALID_TS)).ok).toBe(true);
  });

  it("allows writes to unsupported file types", async () => {
    const ws = new MemoryWorkspace();
    const guard = createEditGuard(ws);
    const verdict = await guard.checkWrite("notes.md", "# unbalanced ( { [");
    expect(verdict.ok).toBe(true);
  });

  it("honors allow_syntax_errors on writes", async () => {
    const ws = new MemoryWorkspace();
    const guard = createEditGuard(ws);
    const verdict = await guard.checkWrite("fixture.ts", BROKEN_TS, {
      allowSyntaxErrors: true,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("denial messages", () => {
  it("pluralizes the syntax-regression count", () => {
    expect(syntaxRegressionDeniedMessage("a.ts", 1, undefined)).toContain(
      "1 new syntax error in a.ts",
    );
    expect(syntaxRegressionDeniedMessage("a.ts", 3, "line 2: oops")).toContain(
      "3 new syntax errors in a.ts (first: line 2: oops)",
    );
  });

  it("stale message names the path and the remedy", () => {
    const message = staleFileDeniedMessage("src/x.ts");
    expect(message).toContain("src/x.ts");
    expect(message).toContain("Re-read");
  });
});
