import { describe, expect, it } from "vitest";
import type { RawRecord } from "../connectors/types";
import { advanceCursor, mergeCursor, readCursor } from "./cursor";

function rec(externalId: string, updatedAt: string): RawRecord {
  return {
    sourceRecordType: "issue",
    externalId,
    raw: { id: externalId, updatedAt },
    receivedAt: "2026-07-04T00:00:00.000Z",
  };
}

// A connector that reports the record's updatedAt as its cursor.
const withCursorOf = {
  cursorOf(_recordType: string, raw: unknown): string | null {
    const u = (raw as { updatedAt?: unknown }).updatedAt;
    return typeof u === "string" ? u : null;
  },
};

describe("readCursor", () => {
  it("returns the string cursor for a record type", () => {
    expect(readCursor({ issue: "2026-01-01T00:00:00Z" }, "issue")).toBe(
      "2026-01-01T00:00:00Z",
    );
  });

  it("returns null for missing / non-string / null map", () => {
    expect(readCursor(null, "issue")).toBeNull();
    expect(readCursor({}, "issue")).toBeNull();
    expect(readCursor({ issue: 42 }, "issue")).toBeNull();
  });
});

describe("advanceCursor", () => {
  it("returns the max cursorOf across the batch (ISO strings sort lexically)", () => {
    const batch = [
      rec("1", "2026-01-01T00:00:00.000Z"),
      rec("2", "2026-03-15T12:00:00.000Z"),
      rec("3", "2026-02-01T00:00:00.000Z"),
    ];
    expect(advanceCursor(withCursorOf, "issue", batch, null)).toBe(
      "2026-03-15T12:00:00.000Z",
    );
  });

  it("never regresses below the prior cursor", () => {
    const batch = [rec("1", "2026-01-01T00:00:00.000Z")];
    expect(
      advanceCursor(withCursorOf, "issue", batch, "2026-06-01T00:00:00.000Z"),
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("keeps the prior cursor when the connector has no cursorOf", () => {
    expect(
      advanceCursor(
        {},
        "issue",
        [rec("1", "2026-01-01T00:00:00.000Z")],
        "prior",
      ),
    ).toBe("prior");
  });

  it("ignores records whose cursorOf is null", () => {
    const batch: RawRecord[] = [
      { sourceRecordType: "issue", externalId: "x", raw: {}, receivedAt: "" },
    ];
    expect(advanceCursor(withCursorOf, "issue", batch, "keep")).toBe("keep");
  });

  it("returns prior on an empty batch", () => {
    expect(advanceCursor(withCursorOf, "issue", [], "keep")).toBe("keep");
    expect(advanceCursor(withCursorOf, "issue", [], null)).toBeNull();
  });
});

describe("mergeCursor", () => {
  it("sets a record type's cursor without mutating the input", () => {
    const before = { issue: "a" };
    const after = mergeCursor(before, "pull_request", "b");
    expect(after).toEqual({ issue: "a", pull_request: "b" });
    expect(before).toEqual({ issue: "a" });
  });

  it("clears the cursor when next is null", () => {
    expect(
      mergeCursor({ issue: "a", pull_request: "b" }, "issue", null),
    ).toEqual({
      pull_request: "b",
    });
  });

  it("handles a null starting map", () => {
    expect(mergeCursor(null, "issue", "a")).toEqual({ issue: "a" });
  });
});
