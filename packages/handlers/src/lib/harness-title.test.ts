import { describe, expect, it } from "vitest";
import { latestHarnessTitle } from "./harness-title";

const frame = (ts: string, body: unknown) => ({ ts, body });

describe("latestHarnessTitle", () => {
  it("takes the latest session_title by frame time, not by batch order", () => {
    expect(
      latestHarnessTitle([
        frame("2026-09-23T10:05:00.000Z", { session_title: "Second name" }),
        frame("2026-09-23T10:00:00.000Z", { session_title: "First name" }),
      ]),
    ).toEqual({
      title: "Second name",
      at: new Date("2026-09-23T10:05:00.000Z"),
    });
  });

  it("trims the title and skips blank, non-string and missing values", () => {
    expect(
      latestHarnessTitle([
        frame("2026-09-23T10:00:00.000Z", { session_title: "  Kept  " }),
        frame("2026-09-23T10:01:00.000Z", { session_title: "   " }),
        frame("2026-09-23T10:02:00.000Z", { session_title: 7 }),
        frame("2026-09-23T10:03:00.000Z", { prompt: "no title" }),
        frame("2026-09-23T10:04:00.000Z", null),
      ])?.title,
    ).toBe("Kept");
  });

  // #4224: the harness puts no bound on its title, and the column stored it
  // whole.
  it("cuts a long title to the display cap, never between a surrogate pair", () => {
    // The cut falls at unit 255, and the emoji's halves sit at 254 and 255.
    const long = `${"a".repeat(254)}😀${"a".repeat(44)}`;
    expect(long).toHaveLength(300);
    const title = latestHarnessTitle([
      frame("2026-09-23T10:00:00.000Z", { session_title: long }),
    ])?.title;
    expect(title).toBe(`${"a".repeat(254)}…`);
    expect(title!.length).toBeLessThanOrEqual(256);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("keeps a title of exactly 256 units whole", () => {
    const exact = "b".repeat(256);
    expect(
      latestHarnessTitle([
        frame("2026-09-23T10:00:00.000Z", { session_title: exact }),
      ])?.title,
    ).toBe(exact);
  });

  it("skips a frame whose time does not parse", () => {
    expect(
      latestHarnessTitle([frame("garbage", { session_title: "Lost" })]),
    ).toBeNull();
  });

  it("returns null for a batch with no title", () => {
    expect(latestHarnessTitle([])).toBeNull();
  });
});
