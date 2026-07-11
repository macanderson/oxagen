/**
 * Unit coverage for the pure edit-integrity primitives (docs/specs/
 * unpoisonable-edits): the content-hash anchor, the single-file syntactic
 * check, the before/after error delta, and the per-run anchor ledger. The
 * tool-layer wiring that composes them is covered in tools.edit-integrity.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  hashContent,
  checkSyntax,
  newSyntaxErrors,
  EditIntegrityLedger,
} from "./edit-integrity";

describe("hashContent", () => {
  it("is deterministic and 16 lowercase-hex chars", () => {
    const a = hashContent("hello world");
    const b = hashContent("hello world");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  it("hashes the empty string to a stable 16-char value", () => {
    expect(hashContent("")).toHaveLength(16);
    expect(hashContent("")).toBe(hashContent(""));
  });
});

describe("checkSyntax", () => {
  it("passes valid TypeScript", () => {
    const r = checkSyntax("a.ts", "export const x = 1;");
    expect(r).toEqual({ supported: true, errors: [] });
  });

  it("reports a syntactic error with a 1-based line number for a .ts file", () => {
    const r = checkSyntax("a.ts", "const a = 1;\nconst b = (");
    expect(r.supported).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^line 2: /);
    expect(r.errors[0]).toContain("Expression expected");
  });

  it("passes valid JSX in a .tsx file without React in scope (jsx preserved)", () => {
    const r = checkSyntax(
      "a.tsx",
      'export const El = () => <div className="x">hi</div>;',
    );
    expect(r).toEqual({ supported: true, errors: [] });
  });

  it("reports errors for malformed JSX in a .tsx file", () => {
    const r = checkSyntax("a.tsx", "export const El = () => <div>;");
    expect(r.supported).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("passes valid JSON and reports a single message for invalid JSON", () => {
    expect(checkSyntax("a.json", '{"a":1}')).toEqual({
      supported: true,
      errors: [],
    });
    const bad = checkSyntax("a.json", "{bad}");
    expect(bad.supported).toBe(true);
    expect(bad.errors).toHaveLength(1);
  });

  it("returns unsupported (no errors) for an extension it does not understand", () => {
    expect(checkSyntax("README.md", "# heading <not code")).toEqual({
      supported: false,
      errors: [],
    });
    expect(checkSyntax("script.py", "def f(: pass")).toEqual({
      supported: false,
      errors: [],
    });
  });

  it("caps the reported errors at 5", () => {
    // 10 stray closing braces yield 10 raw diagnostics; the checker surfaces 5.
    const r = checkSyntax("a.ts", Array(10).fill("}").join("\n"));
    expect(r.errors).toHaveLength(5);
  });
});

describe("newSyntaxErrors", () => {
  it("returns only errors present after but not before", () => {
    expect(newSyntaxErrors(["e1"], ["e1", "e2"])).toEqual(["e2"]);
  });

  it("returns nothing when an already-broken file gains no new error", () => {
    // A pre-broken file carries its error in `before`, so an unrelated edit that
    // leaves that same error in place introduces nothing — the gate must not fire.
    expect(newSyntaxErrors(["e1"], ["e1"])).toEqual([]);
  });

  it("treats every after-error as new when before was empty (a create)", () => {
    expect(newSyntaxErrors([], ["e1", "e2"])).toEqual(["e1", "e2"]);
  });

  it("returns nothing when a broken file is fully repaired", () => {
    expect(newSyntaxErrors(["e1"], [])).toEqual([]);
  });
});

describe("EditIntegrityLedger", () => {
  it("records and reads back a hash", () => {
    const led = new EditIntegrityLedger("/repo");
    expect(led.get("a.ts")).toBeUndefined();
    led.record("a.ts", "deadbeefdeadbeef");
    expect(led.get("a.ts")).toBe("deadbeefdeadbeef");
  });

  it("normalizes relative and absolute spellings of the same file to one entry", () => {
    const led = new EditIntegrityLedger("/repo");
    led.record("a.ts", "hash1");
    // The absolute spelling of the same file resolves to the same key.
    expect(led.get("/repo/a.ts")).toBe("hash1");
    // Re-recording under the absolute spelling updates the shared entry.
    led.record("/repo/a.ts", "hash2");
    expect(led.get("a.ts")).toBe("hash2");
  });

  it("keeps distinct files under distinct keys", () => {
    const led = new EditIntegrityLedger("/repo");
    led.record("a.ts", "hash-a");
    led.record("b.ts", "hash-b");
    expect(led.get("a.ts")).toBe("hash-a");
    expect(led.get("b.ts")).toBe("hash-b");
  });
});
