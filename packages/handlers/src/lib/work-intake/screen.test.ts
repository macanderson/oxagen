// The work intake screen (P1-03, #5103): credentials become markers, control
// characters go, and everything else passes as it was.
import { describe, expect, it } from "vitest";
import { screenText, screenValue } from "./screen";

const TOKEN = `ghp_${"a1".repeat(18)}`;

describe("screenText", () => {
  it("replaces a credential with a marker and counts it", () => {
    expect(screenText(`push with ${TOKEN} please`)).toEqual({ text: "push with [redacted:github_token] please", redactions: 1 });
  });

  it("drops control characters but keeps tabs and line breaks", () => {
    expect(screenText("a\u0000b\u0007c\td\ne\r\nf\u009b")).toEqual({ text: "abc\td\ne\r\nf", redactions: 0 });
  });

  it("does not count a marker the text already held", () => {
    expect(screenText("[redacted:github_token] stays").redactions).toBe(0);
  });
});

describe("screenValue", () => {
  it("screens every string in a JSON value and leaves the rest", () => {
    const value = { subject: `key ${TOKEN}`, labels: ["Bug", TOKEN], count: 3, open: true, owner: null };
    expect(screenValue(value)).toEqual({
      value: {
        subject: "key [redacted:github_token]",
        labels: ["Bug", "[redacted:github_token]"],
        count: 3,
        open: true,
        owner: null,
      },
      redactions: 2,
    });
  });
});
