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

/**
 * #1353: an error's identity was its POSITION, because the formatted string
 * starts with a line number. Any edit that shifted lines above a pre-existing
 * error renamed it, and the agent was told it had introduced damage it had not
 * touched.
 */
describe("newSyntaxErrors identifies an error by its message, not its line", () => {
  it("does not report a pre-existing error that an edit merely pushed down", () => {
    const before = ["line 12: Unterminated string literal."];
    // Three imports added at the top; the same untouched error is now at 15.
    const after = ["line 15: Unterminated string literal."];
    expect(newSyntaxErrors(before, after)).toEqual([]);
  });

  it("does not report one an edit pulled up either", () => {
    expect(
      newSyntaxErrors(
        ["line 40: Declaration or statement expected."],
        ["line 8: Declaration or statement expected."],
      ),
    ).toEqual([]);
  });

  it("still reports a genuinely new error", () => {
    expect(
      newSyntaxErrors(
        ["line 12: Unterminated string literal."],
        ["line 15: Unterminated string literal.", "line 3: ',' expected."],
      ),
    ).toEqual(["line 3: ',' expected."]);
  });

  it("reports a SECOND instance of a message that already appeared once", () => {
    // Multiplicity is what stops the message-based match hiding real damage.
    const introduced = newSyntaxErrors(
      ["line 12: Unterminated string literal."],
      [
        "line 3: Unterminated string literal.",
        "line 15: Unterminated string literal.",
      ],
    );
    expect(introduced).toHaveLength(1);
    // Reported with its real post-edit line number, not the pre-edit one.
    expect(introduced[0]).toMatch(/^line \d+: Unterminated string literal\.$/);
  });

  it("reports every new instance when several appear", () => {
    expect(
      newSyntaxErrors([], ["line 1: ',' expected.", "line 2: ',' expected."]),
    ).toHaveLength(2);
  });

  it("handles messages with no line prefix at all (JSON parse errors)", () => {
    const before = ["Unexpected token } in JSON at position 41"];
    expect(newSyntaxErrors(before, before)).toEqual([]);
    expect(
      newSyntaxErrors(before, [...before, "Unexpected end of JSON input"]),
    ).toEqual(["Unexpected end of JSON input"]);
  });
});

/**
 * #1357: the anchor treats an absent entry as "nothing to check", so every
 * spelling that missed the map was a free pass past the stale-content refusal.
 */
describe("EditIntegrityLedger keys every spelling of one file together", () => {
  it.each([
    "src/foo.ts",
    "./src/foo.ts",
    "src/../src/foo.ts",
    "src//foo.ts",
    "/repo/src/foo.ts",
  ])(
    "reads back the anchor recorded under a different spelling: %s",
    (spelling) => {
      const ledger = new EditIntegrityLedger("/repo");
      ledger.record("src/foo.ts", "deadbeefdeadbeef");
      expect(ledger.get(spelling)).toBe("deadbeefdeadbeef");
    },
  );

  it("records under one spelling and refuses to leak into another file", () => {
    const ledger = new EditIntegrityLedger("/repo");
    ledger.record("./src/foo.ts", "aaaaaaaaaaaaaaaa");
    expect(ledger.get("src/foo.ts")).toBe("aaaaaaaaaaaaaaaa");
    expect(ledger.get("src/bar.ts")).toBeUndefined();
  });

  it("lets a later record under another spelling overwrite the same entry", () => {
    const ledger = new EditIntegrityLedger("/repo");
    ledger.record("src/foo.ts", "aaaaaaaaaaaaaaaa");
    ledger.record("/repo/src/foo.ts", "bbbbbbbbbbbbbbbb");
    expect(ledger.get("./src/foo.ts")).toBe("bbbbbbbbbbbbbbbb");
  });
});
