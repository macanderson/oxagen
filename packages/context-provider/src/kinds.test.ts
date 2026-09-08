import type { RecordKind } from "@oxagen/engram";
import { describe, expect, it } from "vitest";
import { frameKindOf, recordKindsFor, SERVED_FRAME_KINDS } from "./kinds";

const EVERY_RECORD_KIND: RecordKind[] = [
  "episodic",
  "semantic",
  "procedural",
  "entity",
  "edge",
];

describe("frameKindOf", () => {
  it.each([
    ["episodic", "episode"],
    ["semantic", "fact"],
    ["procedural", "memory"],
    ["entity", "graph"],
    ["edge", "graph"],
  ] as const)("serves %s as %s", (record, expected) => {
    expect(frameKindOf(record)).toBe(expected);
  });

  it("is total over every record kind engram defines", () => {
    for (const kind of EVERY_RECORD_KIND) {
      expect(frameKindOf(kind)).toBeDefined();
    }
  });
});

describe("SERVED_FRAME_KINDS", () => {
  it("lists each served kind once, so the handshake has no duplicates", () => {
    expect([...SERVED_FRAME_KINDS].sort()).toEqual([
      "episode",
      "fact",
      "graph",
      "memory",
    ]);
  });

  it("promises nothing engram cannot produce", () => {
    expect(SERVED_FRAME_KINDS).not.toContain("doc");
    expect(SERVED_FRAME_KINDS).not.toContain("snippet");
    expect(SERVED_FRAME_KINDS).not.toContain("symbol");
  });
});

describe("recordKindsFor", () => {
  it("fetches both record kinds behind a graph frame", () => {
    expect(recordKindsFor(["graph"]).sort()).toEqual(["edge", "entity"]);
  });

  it("round-trips every served kind", () => {
    expect(recordKindsFor(SERVED_FRAME_KINDS).sort()).toEqual(
      [...EVERY_RECORD_KIND].sort(),
    );
  });

  // A filter this provider cannot honour must narrow, never widen.
  it("selects nothing for a kind it does not serve", () => {
    expect(recordKindsFor(["doc"])).toEqual([]);
    expect(recordKindsFor([])).toEqual([]);
  });

  it("ignores an unserved kind beside a served one", () => {
    expect(recordKindsFor(["doc", "fact"])).toEqual(["semantic"]);
  });
});
