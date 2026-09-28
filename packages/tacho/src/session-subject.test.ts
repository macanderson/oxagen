import { describe, expect, it } from "vitest";
import {
  SESSION_SUBJECT_MAX,
  capSubject,
  clipSummary,
  sessionSubject,
} from "./session-subject";

const PR = "https://github.com/macanderson/oxagen/pull/123";
const ISSUE = "https://github.com/macanderson/oxagen/issues/45";

const points = (text: string): number => Array.from(text).length;

describe("sessionSubject", () => {
  it("names a leading pull request URL after the verb that follows it", () => {
    expect(sessionSubject(`${PR} fix conflicts`)).toBe("Fix conflicts on PR 123");
  });

  it("reads a pull request URL inline after a preposition", () => {
    expect(sessionSubject(`fix conflicts on ${PR}`)).toBe("Fix conflicts on PR 123");
  });

  it("gives a bare verb the reference as its object", () => {
    expect(sessionSubject("review https://github.com/o/r/pull/7")).toBe("Review PR 7");
    expect(sessionSubject("please review https://github.com/o/r/pull/7")).toBe(
      "Review PR 7",
    );
    expect(sessionSubject("https://github.com/o/r/pull/7 review")).toBe("Review PR 7");
  });

  it("names an issue URL on its own", () => {
    expect(sessionSubject(ISSUE)).toBe("Issue 45");
  });

  it("does not name the same reference twice", () => {
    expect(sessionSubject(`Fix conflicts on PR 123 ${PR}`)).toBe(
      "Fix conflicts on PR 123",
    );
  });

  it("keeps the first sentence, less the please in front of it", () => {
    expect(
      sessionSubject("Please repair authentication. The redirect loops after login."),
    ).toBe("Repair authentication");
    expect(sessionSubject("Why does CI fail?")).toBe("Why does CI fail");
  });

  it("reads the first line with words in it and drops a list marker", () => {
    expect(sessionSubject("\n\n- fix the flaky login test\n- update the docs")).toBe(
      "Fix the flaky login test",
    );
  });

  it("leaves a first word that is not all lowercase as written", () => {
    expect(sessionSubject("iOS build breaks on launch")).toBe(
      "iOS build breaks on launch",
    );
  });

  it("cuts a long prompt on a word, with no ellipsis", () => {
    const prompt =
      "Refactor the billing proration path so that upgrades in the middle of a cycle credit the unused days correctly and emit one invoice line";
    const subject = sessionSubject(prompt) ?? "";
    expect(points(subject)).toBeLessThanOrEqual(SESSION_SUBJECT_MAX);
    expect(subject).not.toContain("…");
    expect(prompt.startsWith(subject)).toBe(true);
    expect(prompt[subject.length]).toBe(" ");
    // The cut drops the "of a" it would otherwise end on.
    expect(subject).toBe(
      "Refactor the billing proration path so that upgrades in the middle",
    );
  });

  it("prefers a clause boundary to a word boundary", () => {
    expect(
      sessionSubject(
        "Fix the flaky checkout test, which times out on CI whenever the payment mock takes longer than five seconds to answer",
      ),
    ).toBe("Fix the flaky checkout test");
  });

  it("returns null for a prompt with no words", () => {
    expect(sessionSubject("")).toBeNull();
    expect(sessionSubject("   \n\t ")).toBeNull();
    expect(sessionSubject(null)).toBeNull();
    expect(sessionSubject(undefined)).toBeNull();
    expect(sessionSubject(" \n <br> \n")).toBeNull();
    expect(sessionSubject("...")).toBeNull();
  });
});

describe("capSubject", () => {
  it("collapses whitespace and drops trailing punctuation", () => {
    expect(capSubject("  Fix   the   login\nredirect.  ")).toBe("Fix the login redirect");
  });

  it("cuts on a word boundary within the cap", () => {
    const title = `${"Rename the ".repeat(10)}thing`;
    const capped = capSubject(title) ?? "";
    expect(points(capped)).toBeLessThanOrEqual(SESSION_SUBJECT_MAX);
    expect(title.startsWith(capped)).toBe(true);
    expect(title[capped.length]).toBe(" ");
  });

  it("hard-cuts a single word longer than the cap", () => {
    expect(capSubject("a".repeat(100))).toBe("a".repeat(SESSION_SUBJECT_MAX));
  });

  it("returns null when nothing is left", () => {
    expect(capSubject(null)).toBeNull();
    expect(capSubject("   ")).toBeNull();
    expect(capSubject("...")).toBeNull();
  });
});

describe("clipSummary", () => {
  it("keeps the first three sentences", () => {
    expect(clipSummary("One. Two. Three. Four.")).toBe("One. Two. Three.");
  });

  it("stops before a sentence that would pass the character cap", () => {
    const [x, y, z] = ["x", "y", "z"].map((c) => `${c.repeat(150)}.`);
    expect(clipSummary(`${x} ${y} ${z}`)).toBe(`${x} ${y}`);
  });

  it("cuts one overlong sentence on a word and marks the cut", () => {
    const clipped = clipSummary("word ".repeat(100)) ?? "";
    expect(points(clipped)).toBeLessThanOrEqual(400);
    expect(clipped.endsWith("word…")).toBe(true);
  });

  it("returns null for an empty summary", () => {
    expect(clipSummary(null)).toBeNull();
    expect(clipSummary("  ")).toBeNull();
  });
});
