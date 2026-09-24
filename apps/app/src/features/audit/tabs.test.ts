// Which route segment names an Audit tab. Events is the page's own route, so
// `/audit/events` is a 404 rather than a second address for it, and a segment
// is matched exactly: a mistyped or differently cased tab is not a fallback.
import { describe, expect, it } from "vitest";
import { AUDIT_TABS, auditTabOf } from "./tabs";

describe("auditTabOf", () => {
  it.each(["incidents", "receipts", "exports", "keys", "retention"])(
    "names the %s tab from its segment",
    (segment) => {
      expect(auditTabOf(segment)).toBe(segment);
    },
  );

  it("gives Events no segment of its own (negative)", () => {
    expect(auditTabOf("events")).toBeNull();
  });

  it.each(["", "Exports", "export", "exports/", "../keys", "retention?x=1"])(
    "names no tab for %j (negative)",
    (segment) => {
      expect(auditTabOf(segment)).toBeNull();
    },
  );

  it("has a segment for every tab but Events", () => {
    expect(AUDIT_TABS.filter((tab) => auditTabOf(tab) === null)).toEqual([
      "events",
    ]);
  });
});
