/**
 * Envelope wire-contract tests (ADR-023) — pins the ONE public format of the
 * CLI so an accidental schema break is loud.
 *
 * The GOLDEN array below is hand-written, one literal per event type: it is the
 * wire contract. Each sample must serialize → parse → deep-equal itself, and
 * the set of golden types must equal the schema's discriminator set (the
 * additive-only guard: adding/removing/renaming a type without touching the
 * golden set fails here). The rest asserts `parseSessionEventLine`'s tolerance
 * (torn/blank/foreign/wrong-version lines yield null, never throw) and the
 * small usage/cap helpers.
 */
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  addTurnUsage,
  capForWire,
  emptyTurnUsage,
  parseSessionEventLine,
  serializeSessionEvent,
  sessionEventSchema,
  type SessionEvent,
} from "../events.js";

// One canonical, fully-populated sample per event type (optional fields
// included so they are pinned too). TypeScript's excess-property + discriminated
// -union checks make this array a compile-time contract as well as a runtime one.
const GOLDEN: SessionEvent[] = [
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 1,
    ts: 1_720_000_000_000,
    type: "session.start",
    title: "auth fix",
    prompt: "fix the failing auth test",
    cwd: "/repo",
    model: "fable-5",
    agent: "code",
    mode: "conversation",
    owner: "tui",
    pid: 4242,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 2,
    ts: 1_720_000_000_001,
    type: "session.state",
    state: "running",
    reason: "dispatched",
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 3,
    ts: 1_720_000_000_002,
    type: "stage",
    kind: "plan",
    label: "Planning",
    detail: "3 steps",
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 4,
    ts: 1_720_000_000_003,
    type: "message",
    role: "user",
    text: "please fix it",
    turn: 1,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 5,
    ts: 1_720_000_000_004,
    type: "message.delta",
    text: "Looking at ",
    turn: 1,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 6,
    ts: 1_720_000_000_005,
    type: "message.end",
    text: "Looking at the auth module, the bug is a missing await.",
    turn: 1,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 7,
    ts: 1_720_000_000_006,
    type: "reasoning.delta",
    text: "The stack trace points at session.ts",
    turn: 1,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 8,
    ts: 1_720_000_000_007,
    type: "tool.start",
    name: "read_file",
    input: '{"path":"src/auth/session.ts"}',
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 9,
    ts: 1_720_000_000_008,
    type: "tool.end",
    name: "read_file",
    ok: true,
    durationMs: 12,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 10,
    ts: 1_720_000_000_009,
    type: "diff",
    changedFiles: ["src/auth/session.ts"],
    changedLines: 4,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 11,
    ts: 1_720_000_000_010,
    type: "turn.end",
    turn: 1,
    steps: 5,
    stopReason: "complete",
    changedFiles: ["src/auth/session.ts"],
    usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.021 },
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 12,
    ts: 1_720_000_000_011,
    type: "usage",
    cumulative: { inputTokens: 1200, outputTokens: 340, costUsd: 0.021 },
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 13,
    ts: 1_720_000_000_012,
    type: "error",
    message: "gateway timed out",
    fatal: false,
  },
  {
    v: 1,
    sid: "s-abcd-1111",
    seq: 14,
    ts: 1_720_000_000_013,
    type: "session.end",
    state: "done",
    summary: "Fixed the missing await in session.ts",
    durationMs: 43_120,
    usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.021 },
  },
];

describe("session event envelope — golden wire contract", () => {
  it("every event type round-trips through serialize → parse unchanged", () => {
    for (const event of GOLDEN) {
      const line = serializeSessionEvent(event);
      const parsed = parseSessionEventLine(line);
      expect(parsed, `type ${event.type} must parse`).not.toBeNull();
      expect(parsed).toEqual(event);
    }
  });

  it("the golden set covers exactly the schema's discriminator types (additive-only guard)", () => {
    // If a type is added, removed, or renamed in the schema without touching
    // GOLDEN, these two sets diverge and this test fails.
    const schemaTypes = sessionEventSchema.options
      .map((o) => o.shape.type.value)
      .sort();
    const goldenTypes = GOLDEN.map((e) => e.type).sort();
    expect(goldenTypes).toEqual(schemaTypes);
    expect(GOLDEN).toHaveLength(14);
    expect(new Set(goldenTypes).size).toBe(GOLDEN.length); // no duplicate types
  });

  it("stamps and preserves the schema version", () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
    for (const event of GOLDEN) expect(event.v).toBe(1);
  });

  it("optional fields may be omitted and still round-trip", () => {
    const minimalStart: SessionEvent = {
      v: 1,
      sid: "s-abcd-2222",
      seq: 1,
      ts: 1_720_000_000_100,
      type: "session.start",
      title: "no model/agent",
      prompt: "go",
      cwd: "/repo",
      mode: "once",
      owner: "worker",
      pid: 99,
    };
    expect(parseSessionEventLine(serializeSessionEvent(minimalStart))).toEqual(
      minimalStart,
    );
  });
});

describe("parseSessionEventLine — tolerance", () => {
  it("returns null (never throws) for torn, blank, and foreign lines", () => {
    const bad = [
      '{"v":1,"sid":"x","seq":3,"ts":1,"type":"messa', // torn tail line (crash mid-append)
      "", // blank
      "   ", // whitespace only
      "\t", // tab only
      '{"hello":1}', // valid JSON, not an envelope
      "not json at all",
      "[]", // JSON array
      "42", // JSON number
      '"a string"', // JSON string
      "null", // JSON null
      "true", // JSON boolean
      '{"v":1}', // envelope-ish but incomplete
    ];
    for (const line of bad) {
      expect(() => parseSessionEventLine(line)).not.toThrow();
      expect(
        parseSessionEventLine(line),
        `line ${JSON.stringify(line)} must be null`,
      ).toBeNull();
    }
  });

  it("rejects a wrong schema version", () => {
    const v2 =
      '{"v":2,"sid":"x","seq":1,"ts":1,"type":"error","message":"m","fatal":false}';
    expect(parseSessionEventLine(v2)).toBeNull();
    // Same payload at v1 is the control — it must parse, proving only `v` differs.
    const v1 =
      '{"v":1,"sid":"x","seq":1,"ts":1,"type":"error","message":"m","fatal":false}';
    expect(parseSessionEventLine(v1)).not.toBeNull();
  });

  it("rejects non-positive seq and non-positive ts", () => {
    const control =
      '{"v":1,"sid":"x","seq":1,"ts":1,"type":"error","message":"m","fatal":false}';
    expect(parseSessionEventLine(control)).not.toBeNull();
    // seq must be a positive integer starting at 1.
    expect(
      parseSessionEventLine(control.replace('"seq":1', '"seq":0')),
    ).toBeNull();
    expect(
      parseSessionEventLine(control.replace('"seq":1', '"seq":-1')),
    ).toBeNull();
    expect(
      parseSessionEventLine(control.replace('"seq":1', '"seq":1.5')),
    ).toBeNull();
    // ts must be a positive integer.
    expect(
      parseSessionEventLine(control.replace('"ts":1', '"ts":0')),
    ).toBeNull();
    expect(
      parseSessionEventLine(control.replace('"ts":1', '"ts":-1')),
    ).toBeNull();
  });

  it("rejects an empty sid", () => {
    const control =
      '{"v":1,"sid":"x","seq":1,"ts":1,"type":"error","message":"m","fatal":false}';
    expect(
      parseSessionEventLine(control.replace('"sid":"x"', '"sid":""')),
    ).toBeNull();
  });
});

describe("usage helpers", () => {
  it("emptyTurnUsage is all-zero and a fresh object each call", () => {
    expect(emptyTurnUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(emptyTurnUsage()).not.toBe(emptyTurnUsage());
  });

  it("addTurnUsage sums componentwise without mutating its inputs", () => {
    const a = { inputTokens: 1, outputTokens: 2, costUsd: 0.5 };
    const b = { inputTokens: 10, outputTokens: 20, costUsd: 1.5 };
    expect(addTurnUsage(a, b)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      costUsd: 2,
    });
    expect(a).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 0.5 });
    expect(b).toEqual({ inputTokens: 10, outputTokens: 20, costUsd: 1.5 });
    // Adding the empty usage is the identity.
    expect(addTurnUsage(a, emptyTurnUsage())).toEqual(a);
  });
});

describe("capForWire — 2 KB tool-input boundary", () => {
  it("passes short and exactly-max strings through untouched", () => {
    expect(capForWire("abc", 10)).toBe("abc");
    expect(capForWire("", 10)).toBe("");
    const exact = "a".repeat(10);
    expect(capForWire(exact, 10)).toBe(exact); // length === max: unchanged, no ellipsis
    expect(capForWire(exact, 10)).not.toContain("…");
  });

  it("caps max+1 to length max with a trailing ellipsis", () => {
    const over = "a".repeat(11);
    const capped = capForWire(over, 10);
    expect(capped).toHaveLength(10);
    expect(capped.endsWith("…")).toBe(true);
    expect(capped).toBe("a".repeat(9) + "…");
  });

  it("defaults to a 2048 boundary", () => {
    const atLimit = "b".repeat(2048);
    expect(capForWire(atLimit)).toBe(atLimit);
    const over = "b".repeat(2049);
    const capped = capForWire(over);
    expect(capped).toHaveLength(2048);
    expect(capped.endsWith("…")).toBe(true);
  });
});
