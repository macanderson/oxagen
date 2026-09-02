/**
 * slug.test.ts — unit tests for slugify().
 *
 * Tests:
 *   1. Happy-path transforms (lowercase, hyphenate, etc.)
 *   2. Unicode and non-ASCII characters stripped
 *   3. Repeated hyphens collapsed
 *   4. Leading/trailing hyphens trimmed
 *   5. Empty string → ""
 *   6. Symbol-only input → ""
 *   7. Whitespace-only → ""
 *   8. Every output matches the server validation regex
 *
 * Server validation regex: ^[a-z0-9]+(?:-[a-z0-9]+)*$
 * (empty string is NOT matched — intentional; the form validates non-empty
 * separately from slug format)
 */

import { describe, it, expect } from "vitest";
import { slugify, isValidSlug, SLUG_PATTERN } from "./slug";

// The regex the server validates against. We derive it here — if the source
// module ever changes the rules the tests serve as a canary.
const SERVER_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// 1. Happy-path transforms
// ---------------------------------------------------------------------------

describe("slugify — happy path", () => {
  it("lowercases uppercase input", () => {
    expect(slugify("HELLO")).toBe("hello");
  });

  it("converts spaces to hyphens", () => {
    expect(slugify("hello world")).toBe("hello-world");
  });

  it("trims leading and trailing whitespace before converting", () => {
    expect(slugify("  hello world  ")).toBe("hello-world");
  });

  it("produces expected slug for a typical org name", () => {
    expect(slugify("Acme Corporation")).toBe("acme-corporation");
  });

  it("handles numeric characters", () => {
    expect(slugify("team 42")).toBe("team-42");
  });

  it("handles already-valid slugs unchanged", () => {
    expect(slugify("my-workspace")).toBe("my-workspace");
  });

  it("handles mixed alphanumeric", () => {
    expect(slugify("Area51 HQ")).toBe("area51-hq");
  });
});

// ---------------------------------------------------------------------------
// 2. Unicode / non-ASCII stripped
// ---------------------------------------------------------------------------

describe("slugify — unicode", () => {
  it("strips emoji characters", () => {
    expect(slugify("hello 🌍 world")).toBe("hello-world");
  });

  it("strips accented characters (non-ASCII)", () => {
    // é, ñ, ü etc. are not in [a-z0-9\s-] so they are dropped
    expect(slugify("café")).toBe("caf");
  });

  it("strips CJK characters entirely", () => {
    const result = slugify("工作区");
    expect(result).toBe("");
  });

  it("strips Arabic script characters", () => {
    const result = slugify("مرحبا");
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. Repeated hyphens collapsed
// ---------------------------------------------------------------------------

describe("slugify — hyphen collapsing", () => {
  it("collapses consecutive hyphens to one", () => {
    expect(slugify("hello---world")).toBe("hello-world");
  });

  it("collapses hyphens introduced by stripping chars between words", () => {
    // "hello @ world" → "hello  world" (@ dropped) → "hello-world"
    // Actually: "hello @ world" → "hello  world" → "hello-world"
    expect(slugify("hello @ world")).toBe("hello-world");
  });

  it("collapses mixed spaces and hyphens", () => {
    // multiple spaces produce multiple hyphens which then collapse
    expect(slugify("a   b")).toBe("a-b");
  });
});

// ---------------------------------------------------------------------------
// 4. Leading/trailing hyphens trimmed
// ---------------------------------------------------------------------------

describe("slugify — leading/trailing hyphen trim", () => {
  it("trims a leading hyphen", () => {
    // A string starting with a special char followed by alphanumeric
    expect(slugify("-start")).toBe("start");
  });

  it("trims a trailing hyphen", () => {
    expect(slugify("end-")).toBe("end");
  });

  it("trims both leading and trailing hyphens", () => {
    expect(slugify("-both-")).toBe("both");
  });

  it("trims hyphens resulting from stripped leading chars", () => {
    // "@hello" → after strip: "hello"; after trim: "hello"
    expect(slugify("@hello")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// 5. Empty string → ""
// ---------------------------------------------------------------------------

describe("slugify — maxLen truncation", () => {
  it("truncates to maxLen", () => {
    expect(slugify("hello world", 5)).toBe("hello");
  });

  it("never leaves a trailing hyphen when the cut lands on one", () => {
    // "hello-world".slice(0, 6) === "hello-", which SLUG_PATTERN rejects.
    expect(slugify("hello world", 6)).toBe("hello");
    expect(SLUG_PATTERN.test(slugify("hello world", 6))).toBe(true);
  });
});

describe("slugify — empty input", () => {
  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 6. Symbol-only input → ""
// ---------------------------------------------------------------------------

describe("slugify — symbol-only", () => {
  it('returns empty string for "@#$%"', () => {
    expect(slugify("@#$%")).toBe("");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(slugify("!!!")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 7. Whitespace-only → ""
// ---------------------------------------------------------------------------

describe("slugify — whitespace-only", () => {
  it("returns empty string for spaces only", () => {
    // spaces → hyphen → trim → ""
    expect(slugify("   ")).toBe("");
  });

  it("returns empty string for tab/newline", () => {
    expect(slugify("\t\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 8. All non-empty results match the server validation regex
// ---------------------------------------------------------------------------

describe("slugify — server regex conformance", () => {
  const corpus = [
    "Hello World",
    "My Organization",
    "acme-corp",
    "team 42",
    "test---name",
    "Foo Bar Baz",
    "  leading trailing  ",
    "Area51",
    "CamelCase",
    "a",
    "123",
    "a1b2c3",
  ];

  for (const input of corpus) {
    it(`"${input}" produces a server-valid slug`, () => {
      const result = slugify(input);
      expect(result.length).toBeGreaterThan(0);
      expect(SERVER_SLUG_REGEX.test(result)).toBe(true);
    });
  }

  it("does NOT produce double hyphens in any case", () => {
    const inputs = ["a--b", "a   b", "a@#b", "A--B--C"];
    for (const input of inputs) {
      const result = slugify(input);
      expect(result).not.toContain("--");
    }
  });

  it("does NOT produce a leading or trailing hyphen in any case", () => {
    const inputs = ["-start", "end-", "-both-", "@leading", "trailing@"];
    for (const input of inputs) {
      const result = slugify(input);
      if (result.length > 0) {
        expect(result.startsWith("-")).toBe(false);
        expect(result.endsWith("-")).toBe(false);
      }
    }
  });
});

describe("isValidSlug / SLUG_PATTERN", () => {
  it("accepts well-formed kebab-case slugs", () => {
    for (const s of ["oxagen", "acme", "mac-anderson", "a", "team-1", "x9"]) {
      expect(isValidSlug(s)).toBe(true);
    }
  });

  it("rejects static/metadata paths that fall through to [orgSlug]", () => {
    for (const s of [
      "favicon.ico",
      "robots.txt",
      "sitemap.xml",
      "apple-touch-icon.png",
      "manifest.webmanifest",
    ]) {
      expect(isValidSlug(s)).toBe(false);
    }
  });

  it("rejects malformed slugs (empty, spaces, punctuation, bad hyphens, caps)", () => {
    for (const s of [
      "",
      " ",
      "a b",
      "a_b",
      "-lead",
      "trail-",
      "a--b",
      "Acme",
      "café",
    ]) {
      expect(isValidSlug(s)).toBe(false);
    }
  });

  it("agrees with the server validation regex used by the create actions", () => {
    expect(SLUG_PATTERN.source).toBe(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.source);
  });

  it("accepts every slugify() output that is non-empty", () => {
    for (const input of [
      "Hello World",
      "Ácme Inc.",
      "  multi   space  ",
      "a@#b",
    ]) {
      const out = slugify(input);
      if (out.length > 0) expect(isValidSlug(out)).toBe(true);
    }
  });
});
