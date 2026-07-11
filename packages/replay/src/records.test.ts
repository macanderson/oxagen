import { describe, expect, it } from "vitest";
import {
  RECORD_SCHEMA_VERSION,
  isTruncatedBlob,
  parseReplayRecordLine,
  replayRecordSchema,
  serializeReplayRecord,
  type ReplayRecord,
} from "./records.js";

// The golden set: one fully-populated literal per record type. Adding a type
// to the schema without adding it here (or vice versa) fails the parity test
// below — the same additive-only guard the ADR-023 envelope uses.
const base = {
  rv: RECORD_SCHEMA_VERSION,
  sid: "s-1",
  ts: 1720000000000,
} as const;
const GOLDEN: ReplayRecord[] = [
  {
    ...base,
    seq: 1,
    t: "run.meta",
    cwd: "/repo",
    prompt: "fix the flaky test",
    model: "balanced",
    agent: "coder",
    cliVersion: "1.2.3",
    gitHead: "a".repeat(40),
  },
  {
    ...base,
    seq: 2,
    t: "fs.layer",
    turn: 0,
    files: [
      { path: "src/a.ts", ref: "b".repeat(64), bytes: 10 },
      { path: "src/gone.ts", ref: null, bytes: 0 },
      { path: "big.bin", ref: null, bytes: 99999999, isSkipped: true },
    ],
  },
  { ...base, seq: 3, t: "turn.start", turn: 1, prompt: "fix the flaky test" },
  {
    ...base,
    seq: 4,
    t: "tool.io",
    turn: 1,
    idx: 1,
    name: "edit_file",
    callId: "call_1",
    inputRef: "c".repeat(64),
    outputRef: "d".repeat(64),
    ok: true,
    durationMs: 42,
  },
  {
    ...base,
    seq: 5,
    t: "turn.end",
    turn: 1,
    historyRef: "e".repeat(64),
    changedFiles: ["src/a.ts"],
    steps: 3,
    stopReason: "complete",
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
  },
  { ...base, seq: 6, t: "feedback", verdict: "down", comment: "wrong file" },
  {
    ...base,
    seq: 7,
    t: "distill",
    reason: "thumbs_down",
    itemRef: "f".repeat(64),
    datasetSlug: "fleet-distilled-failures",
    isPushed: true,
  },
];

describe("record-v1 golden stability", () => {
  it("every golden record serializes → parses → deep-equals itself", () => {
    for (const record of GOLDEN) {
      const line = serializeReplayRecord(record);
      expect(parseReplayRecordLine(line)).toEqual(record);
    }
  });

  it("the golden set covers exactly the schema's record types", () => {
    const goldenTypes = [...new Set(GOLDEN.map((r) => r.t))].sort();
    const schemaTypes = replayRecordSchema.options
      .map((o) => o.shape.t.value)
      .sort();
    expect(goldenTypes).toEqual(schemaTypes);
  });

  it("schema version is pinned at 1", () => {
    expect(RECORD_SCHEMA_VERSION).toBe(1);
  });
});

describe("parseReplayRecordLine tolerance", () => {
  it("returns null for blank, torn, and foreign lines", () => {
    expect(parseReplayRecordLine("")).toBeNull();
    expect(parseReplayRecordLine("   ")).toBeNull();
    expect(parseReplayRecordLine('{"t":"run.meta","sid"')).toBeNull();
    expect(parseReplayRecordLine('{"hello":"world"}')).toBeNull();
  });

  it("rejects a wrong schema version", () => {
    const record = { ...GOLDEN[0], rv: 2 };
    expect(parseReplayRecordLine(JSON.stringify(record))).toBeNull();
  });
});

describe("isTruncatedBlob", () => {
  it("recognizes a marker and rejects payload-shaped values", () => {
    expect(
      isTruncatedBlob({
        __truncated: true,
        bytes: 10,
        sha256: "a".repeat(64),
        head: "x",
      }),
    ).toBe(true);
    expect(isTruncatedBlob({ bytes: 10 })).toBe(false);
    expect(isTruncatedBlob("payload")).toBe(false);
  });
});
