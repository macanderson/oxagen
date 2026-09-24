import { isHandlerError } from "@oxagen/oxagen/handler-error";
import {
  runTranscriptGet,
  TRANSCRIPT_STEP_TEXT_MAX,
  TRANSCRIPT_TEXT_MAX,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { digestBytes } from "@oxagen/tacho";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { tachoFrame as tachoFrameOf } from "@oxagen/run-ledger";
import { describe, expect, it, vi } from "vitest";
import {
  createRunTranscriptGetHandler,
  cursorPosition,
  decodeTranscriptCursor,
  elapsedMs,
  encodeTranscriptCursor,
  foldPageStart,
  type RunTranscriptGetDeps,
} from "./run.transcript.get";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  summary,
  tachoRow,
  tachoSession,
} from "./run.test-support";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";

const enc = new TextEncoder();
const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
function stored(text: string | Uint8Array, contentType = "text/plain") {
  const bytes = typeof text === "string" ? enc.encode(text) : text;
  const digest = digestBytes(bytes);
  const ref = `evb:v1:k:${digest.slice(7)}`;
  objects.set(ref, { bytes, contentType });
  return { contentDigest: digest, bytesRef: ref };
}

/** The input defaults the contract fills in, so a test names only what it varies. */
const input = (over: Record<string, unknown>) =>
  runTranscriptGet.input.parse({ runId: TACHO_ID, ...over });

function harness(
  rows: TachoFrameRow[],
  session?: Partial<{ outcome: string; sealedAt: Date | null }>,
  subagentRows: TachoFrameRow[] = [],
) {
  const stores = memoryStores(
    [],
    [
      tachoSession({
        publicId: TACHO_ID,
        ...(session ? { session } : {}),
      }),
    ],
  );
  const getBody = vi.fn((_scope: unknown, ref: string) => {
    const object = objects.get(ref);
    if (!object) return Promise.reject(new Error(`no object for ${ref}`));
    return Promise.resolve({ ...object, digestHex: ref.slice(-64) });
  });
  const deps: RunTranscriptGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, rows),
    tachoSubagentFrames: memorySubagentFrames(SESSION_UUID, subagentRows),
    bodies: { getBody, getAssembly: () => Promise.resolve(null) },
    priceBook: () => Promise.resolve([]),
  };
  return { transcript: createRunTranscriptGetHandler(deps), getBody, deps };
}

/**
 * An in-memory `selectTachoSubagentEvents`: every chain under the root, in
 * (session, seq) order, strictly after the position, at most `limit`.
 */
function memorySubagentFrames(root: string, rows: TachoFrameRow[]) {
  const ordered = [...rows].sort((a, b) =>
    a.sessionUuid === b.sessionUuid
      ? a.seq - b.seq
      : (a.sessionUuid ?? "") < (b.sessionUuid ?? "")
        ? -1
        : 1,
  );
  return (args: {
    rootSessionUuid: string;
    after: { sessionUuid: string; seq: number } | null;
    limit: number;
  }) =>
    Promise.resolve(
      args.rootSessionUuid !== root
        ? []
        : ordered
            .filter((r) => {
              const after = args.after;
              if (after === null) return true;
              const session = r.sessionUuid ?? "";
              return (
                session > after.sessionUuid ||
                (session === after.sessionUuid && r.seq > after.seq)
              );
            })
            .slice(0, args.limit),
    );
}

const rows = [
  tachoRow(0, { kind: "agent_start", toolName: "", toolStatus: "" }),
  tachoRow(1, { kind: "turn_start", toolName: "", toolStatus: "", turnSeq: 1 }),
  tachoRow(2, {
    kind: "llm_call",
    toolName: "",
    toolStatus: "",
    model: "haiku",
    provider: "anthropic",
    costUsdMicros: 40,
    turnSeq: 1,
    ...stored("What is in README?"),
  }),
  tachoRow(3, {
    turnSeq: 1,
    ...stored('{"path":"README.md"}', "application/json"),
  }),
  tachoRow(4, {
    kind: "turn_start",
    toolName: "",
    toolStatus: "",
    turnSeq: 2,
  }),
  tachoRow(5, {
    kind: "llm_call",
    toolName: "",
    toolStatus: "",
    model: "haiku",
    provider: "anthropic",
    costUsdMicros: 60,
    turnSeq: 2,
    contentDigest: `sha256:${"9".repeat(64)}`,
  }),
  tachoRow(6, { kind: "agent_stop", toolName: "", toolStatus: "" }),
];

describe("get_run_transcript", () => {
  it("everything: a turn's prompt and reply are the boundary frames' halves", async () => {
    // The recorder keeps the prompt on turn_start and the reply on turn_end.
    // The fold keeps both out of the step slots, which used to leave the
    // prompt on no half at all: the page read as if nobody had typed.
    const prompt = "please do another round of polish on the runs page";
    const reply = "Done. The pager reaches every run now.";
    const { transcript } = harness([
      tachoRow(0, { kind: "agent_start", toolName: "", toolStatus: "" }),
      tachoRow(1, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
        ...stored(prompt, "text/plain"),
      }),
      tachoRow(2, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        model: "haiku",
        provider: "anthropic",
        turnSeq: 1,
        ...stored("On it."),
      }),
      tachoRow(3, {
        kind: "turn_end",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
        ...stored(reply, "text/plain"),
      }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    const start = out.entries[1];
    const end = out.entries[3];
    expect(start?.type).toBe("turn_start");
    expect(start?.request?.text).toBe(prompt);
    expect(start?.response).toBeNull();
    expect(end?.type).toBe("turn_end");
    expect(end?.request).toBeNull();
    expect(end?.response?.text).toBe(reply);
    // A boundary without a retained body still shows no half (negative).
    const bare = harness([
      tachoRow(0, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
      }),
    ]);
    const none = await bare.transcript(input({ zoom: "everything" }), ctx());
    expect([none.entries[0]?.request, none.entries[0]?.response]).toEqual([
      null,
      null,
    ]);
  });

  it("turns: the prompt is the turn's request and the model's reply stays its response", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
        ...stored("what is in README?", "text/plain"),
      }),
      tachoRow(1, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        model: "haiku",
        provider: "anthropic",
        turnSeq: 1,
        ...stored("A readme."),
      }),
    ]);
    const out = await transcript(input({ zoom: "turns" }), ctx());
    const turn = out.entries[0];
    expect(turn?.request?.text).toBe("what is in README?");
    expect(turn?.response?.text).toBe("A readme.");
  });

  it("everything: one entry per frame, the body on the half that carried it", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.complete).toBe(true);
    expect(out.cursor).toBeNull();
    expect(
      out.entries.map((e) => [
        e.seq,
        e.kind,
        e.response?.text ?? null,
        e.response?.fidelity ?? null,
      ]),
    ).toEqual([
      // Non-step openings leave both halves empty (see foldTranscript open()).
      ["0", "frame", null, null],
      ["1", "frame", null, null],
      ["2", "model_call", "What is in README?", "full"],
      ["3", "tool_call", '{"path":"README.md"}', "full"],
      ["4", "frame", null, null],
      ["5", "model_call", null, "digest_only"],
      ["6", "frame", null, null],
    ]);
    // A single terminal receipt has no request half to show.
    expect(out.entries.every((e) => e.request === null)).toBe(true);
    // The turn numbering is the same at every zoom.
    expect(out.entries.map((e) => e.turn)).toEqual([null, 1, 1, 1, 2, 2, 2]);
    expect(out.entries[2]?.cost).toEqual({
      micros: "40",
      currency: "USD",
      basis: "client_attested",
    });
  });

  it("cumulative cost is a prefix sum over the run, not over the entry", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(
      out.entries.map((e) => [
        e.seq,
        e.cost?.micros ?? null,
        e.cumulativeCost?.micros ?? null,
      ]),
    ).toEqual([
      ["0", null, null],
      ["1", null, null],
      ["2", "40", "40"],
      ["3", null, "40"],
      ["4", null, "40"],
      ["5", "60", "100"],
      ["6", null, "100"],
    ]);
  });

  it("elapsed is measured from the run's start and never reads negative", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    const first = out.entries[0]?.elapsedMs ?? -1;
    const last = out.entries.at(-1)?.elapsedMs ?? -1;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    // A frame observed before the run's recorded start reports 0, not a
    // negative duration.
    expect(elapsedMs(Date.parse("2026-09-11T10:00:00Z"), new Date(0))).toBe(0);
  });

  it("steps: a tool call is ONE entry carrying what went in and what came back", async () => {
    // The two halves a wrapped session writes: `tool_requested` then
    // `tool_call`. Before the fold paired them this was two entries, each with
    // half the exchange.
    const { transcript } = harness([
      tachoRow(0, {
        kind: "tool_requested",
        toolStatus: "",
        toolUseId: "tu_shared",
        ...stored('{"path":"README.md"}', "application/json"),
      }),
      tachoRow(1, {
        kind: "tool_call",
        toolUseId: "tu_shared",
        ...stored("# Oxagen"),
      }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0];
    expect(entry?.kind).toBe("tool_call");
    expect(entry?.frames).toBe(2);
    expect(entry?.callId).toBe("tu_shared");
    expect(entry?.request).toMatchObject({
      seq: "0",
      type: "tool_requested",
      text: '{"path":"README.md"}',
      fidelity: "full",
    });
    expect(entry?.response).toMatchObject({
      seq: "1",
      type: "tool_call",
      text: "# Oxagen",
      fidelity: "full",
    });
  });

  it("carries the effort a model call ran at, and null where none was recorded", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        effort: "high",
      }),
      tachoRow(1, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        effort: "",
      }),
      tachoRow(2, { kind: "tool_call" }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries.map((entry) => entry.effort)).toEqual([
      "high",
      null,
      null,
    ]);
  });

  it("steps: a second response of the same kind opens a new step, it does not join the first", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "tool_requested",
        toolStatus: "",
        toolUseId: "tu_shared",
      }),
      tachoRow(1, { kind: "tool_call", toolUseId: "tu_shared" }),
      tachoRow(2, { kind: "tool_call" }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries.map((e) => [e.seq, e.endSeq, e.frames])).toEqual([
      ["0", "1", 2],
      ["2", "2", 1],
    ]);
  });

  it("steps: model and tool calls, folding the frames between and summing their cost", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries.map((e) => [e.seq, e.endSeq, e.kind, e.frames])).toEqual(
      [
        ["0", "1", "frame", 2],
        ["2", "2", "model_call", 1],
        ["3", "4", "tool_call", 2],
        ["5", "6", "model_call", 2],
      ],
    );
  });

  it("turns: one entry per turn with the turn's cost", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "turns" }), ctx());
    expect(
      out.entries.map((e) => [
        e.seq,
        e.endSeq,
        e.frames,
        e.cost?.micros ?? null,
      ]),
    ).toEqual([
      ["0", "0", 1, null],
      ["1", "3", 3, "40"],
      ["4", "6", 3, "60"],
    ]);
    expect(out.entries.map((e) => e.turn)).toEqual([null, 1, 2]);
  });

  it("folds a policy decision into the step it was made about, and names it", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "tool_requested",
        toolStatus: "",
        toolUseId: "tu_shared",
      }),
      tachoRow(1, {
        kind: "policy_decision",
        toolName: "",
        toolStatus: "",
        policyDecision: "route",
      }),
      tachoRow(2, { kind: "tool_call", toolUseId: "tu_shared" }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.decision).toMatchObject({
      seq: "1",
      decision: "route",
      type: "policy_decision",
    });
    expect(out.entries[0]?.kinds).toContain("policy");
  });

  it("filters frames by the chips pressed before folding, and echoes the selection", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(
      input({ zoom: "everything", kinds: ["tools"] }),
      ctx(),
    );
    expect(out.kinds).toEqual(["tools"]);
    expect(out.entries.map((e) => e.seq)).toEqual(["3"]);
    // Cumulative cost still counts the hidden model call that came before.
    expect(out.entries[0]?.cumulativeCost?.micros).toBe("40");
    // An empty selection is not every chip off: it keeps every frame.
    const all = await transcript(
      input({ zoom: "everything", kinds: [] }),
      ctx(),
    );
    expect(all.entries).toHaveLength(rows.length);
  });

  it("pages on a cursor it owns and refuses one it did not write (negative)", async () => {
    const { transcript } = harness(rows);
    const first = await transcript(
      input({ zoom: "everything", limit: 3 }),
      ctx(),
    );
    expect(first.entries.map((e) => e.seq)).toEqual(["0", "1", "2"]);
    expect(first.cursor).not.toBeNull();
    const second = await transcript(
      input({ zoom: "everything", limit: 3, after: first.cursor as string }),
      ctx(),
    );
    expect(second.entries.map((e) => e.seq)).toEqual(["3", "4", "5"]);
    // The prefix sum keeps counting from the run's start across the page break.
    expect(second.entries.at(-1)?.cumulativeCost?.micros).toBe("100");
    const last = await transcript(
      input({ zoom: "everything", limit: 3, after: second.cursor as string }),
      ctx(),
    );
    expect(last.entries.map((e) => e.seq)).toEqual(["6"]);
    expect(last.cursor).toBeNull();

    await expect(
      transcript(input({ zoom: "everything", after: "not-ours" }), ctx()),
    ).rejects.toThrow();
    expect(decodeTranscriptCursor("not-a-cursor")).toBeNull();
    expect(decodeTranscriptCursor(encodeTranscriptCursor("42"))).toBe("42");
  });

  it("a digest_only recording answers every half with text null and says so", async () => {
    const { transcript, getBody } = harness(
      rows.map((r) => ({ ...r, bytesRef: "" })),
    );
    const out = await transcript(input({ zoom: "everything" }), ctx());
    // Only step halves carry a response; non-step openings leave it null.
    const halves = out.entries
      .map((e) => e.response)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    expect(halves.length).toBeGreaterThan(0);
    expect(halves.every((r) => r.text === null)).toBe(true);
    expect(halves.every((r) => r.fidelity === "digest_only")).toBe(true);
    expect(getBody).not.toHaveBeenCalled();
  });

  it("cuts a long body at the text cap and marks it, and shows nothing for a body that is not text or does not hash (negative)", async () => {
    const long = "x".repeat(TRANSCRIPT_TEXT_MAX + 5);
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0xc3]);
    const forged = stored("real");
    objects.set(forged.bytesRef, {
      bytes: enc.encode("forged"),
      contentType: "text/plain",
    });
    const { transcript } = harness([
      tachoRow(0, { ...stored(long) }),
      tachoRow(1, { ...stored(binary, "application/octet-stream") }),
      tachoRow(2, { ...forged }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries[0]?.response).toMatchObject({
      text: "x".repeat(TRANSCRIPT_TEXT_MAX),
      truncated: true,
    });
    expect(out.entries[1]?.response).toMatchObject({
      text: null,
      fidelity: "full",
    });
    expect(out.entries[2]?.response).toMatchObject({
      text: null,
      fidelity: "full",
    });
  });

  it("carries an excerpt at a folded zoom and the whole body at everything", async () => {
    // A page of 200 steps at the full cap is megabytes of body text nobody
    // asked for on that render; a folded entry stands for an exchange, so it
    // carries an excerpt and says it was cut.
    const long = "y".repeat(TRANSCRIPT_TEXT_MAX + 5);
    const { transcript } = harness([tachoRow(0, { ...stored(long) })]);

    const steps = await transcript(input({ zoom: "steps" }), ctx());
    expect(steps.entries[0]?.response).toMatchObject({
      text: "y".repeat(TRANSCRIPT_STEP_TEXT_MAX),
      truncated: true,
    });

    const all = await transcript(input({ zoom: "everything" }), ctx());
    expect(all.entries[0]?.response).toMatchObject({
      text: "y".repeat(TRANSCRIPT_TEXT_MAX),
      truncated: true,
    });
  });

  it("is not_found for a run outside the workspace (negative) and empty for a run with no frames", async () => {
    const { transcript } = harness([]);
    await expect(
      transcript(input({ runId: "tse_nope", zoom: "turns" }), ctx()),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "not_found");
    expect(await transcript(input({ zoom: "turns" }), ctx())).toEqual({
      zoom: "turns",
      kinds: [],
      entries: [],
      cursor: null,
      complete: true,
    });
  });

  it("keeps a resume cursor on a live run whose transcript fits in one page", async () => {
    const { transcript } = harness(rows, {
      outcome: "running",
      sealedAt: null,
    });
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries).toHaveLength(rows.length);
    expect(out.cursor).not.toBeNull();
    expect(decodeTranscriptCursor(out.cursor as string)).toBe(
      out.entries.at(-1)?.endSeq,
    );
  });

  it("keeps a resume cursor on a live run with zero entries", async () => {
    const { transcript } = harness([], {
      outcome: "running",
      sealedAt: null,
    });
    const out = await transcript(input({ zoom: "turns" }), ctx());
    expect(out.entries).toEqual([]);
    expect(out.cursor).not.toBeNull();
    // A wrapped session numbers frames from 0, so the start cursor is -1.
    expect(decodeTranscriptCursor(out.cursor as string)).toBe("-1");
  });

  it("keeps a resume cursor on a live run caught up past every fold", async () => {
    const { transcript } = harness(rows, {
      outcome: "running",
      sealedAt: null,
    });
    const first = await transcript(input({ zoom: "everything" }), ctx());
    const after = first.cursor as string;
    const caughtUp = await transcript(
      input({ zoom: "everything", after }),
      ctx(),
    );
    expect(caughtUp.entries).toEqual([]);
    expect(caughtUp.cursor).not.toBeNull();
    expect(decodeTranscriptCursor(caughtUp.cursor as string)).toBe(
      decodeTranscriptCursor(after),
    );
  });

  it("answers no cursor for a sealed run whose page held every fold (negative)", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries).toHaveLength(rows.length);
    expect(out.cursor).toBeNull();
  });

  it("pages overlapping steps in fold order, not by opening.seq vs endSeq (negative)", async () => {
    // start A, start B, complete A, complete B. Fold A owns 1..3 and fold B
    // owns 2..4. A cursor that stores A's endSeq used to look for
    // opening.seq > 3 and skip B entirely (Codex P1 on #3352).
    const events = [
      event(1, {
        eventType: "tool.engine_call_started",
        payload: {
          tool_call_id: "tc_a",
          tool_name: "a",
          input_digest: `sha256:${"a".repeat(64)}`,
        },
      }),
      event(2, {
        eventType: "tool.engine_call_started",
        payload: {
          tool_call_id: "tc_b",
          tool_name: "b",
          input_digest: `sha256:${"b".repeat(64)}`,
        },
      }),
      event(3, {
        eventType: "tool.engine_call_completed",
        payload: {
          tool_call_id: "tc_a",
          tool_name: "a",
          outcome: "completed",
          input_digest: `sha256:${"a".repeat(64)}`,
          duration_ms: 1,
        },
      }),
      event(4, {
        eventType: "tool.engine_call_completed",
        payload: {
          tool_call_id: "tc_b",
          tool_name: "b",
          outcome: "completed",
          input_digest: `sha256:${"b".repeat(64)}`,
          duration_ms: 1,
        },
      }),
    ];
    const stores = memoryStores(
      [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
      [],
    );
    const deps: RunTranscriptGetDeps = {
      queries: stores.queries,
      store: {
        getRunByPublicId: (id) =>
          Promise.resolve(id === LEDGER_ID ? summary() : null),
        readAttemptEventsSince: memoryEvents(events),
      },
      readRunRollups: stores.readRunRollups,
      readWitnessFor: stores.readWitnessFor,
      tachoFrames: memoryTachoFrames(SESSION_UUID, []),
      bodies: {
        getBody: () => Promise.reject(new Error("no bodies in this test")),
        getAssembly: () => Promise.resolve(null),
      },
      priceBook: () => Promise.resolve([]),
    };
    const transcript = createRunTranscriptGetHandler(deps);
    const first = await transcript(
      runTranscriptGet.input.parse({
        runId: LEDGER_ID,
        zoom: "steps",
        limit: 1,
      }),
      ctx(),
    );
    expect(first.entries.map((e) => [e.seq, e.endSeq])).toEqual([["1", "3"]]);
    expect(first.cursor).not.toBeNull();
    const second = await transcript(
      runTranscriptGet.input.parse({
        runId: LEDGER_ID,
        zoom: "steps",
        limit: 1,
        after: first.cursor as string,
      }),
      ctx(),
    );
    expect(second.entries.map((e) => [e.seq, e.endSeq])).toEqual([["2", "4"]]);
  });
});

describe("foldPageStart", () => {
  const fold = (opening: string, endSeq: string) => ({
    opening: { seq: opening } as { seq: string },
    endSeq,
  });

  it("resumes at the next fold after an endSeq cursor, even when openings overlap", () => {
    const folds = [fold("1", "3"), fold("2", "4")];
    expect(foldPageStart(folds, null)).toBe(0);
    expect(foldPageStart(folds, "3")).toBe(1);
    expect(foldPageStart(folds, "4")).toBe(-1);
  });

  it("re-emits a fold that grew past the cursor (a live request that gained its response)", () => {
    const folds = [fold("1", "3"), fold("4", "4")];
    expect(foldPageStart(folds, "1")).toBe(0);
  });

  it("re-emits an earlier fold that grew past an exact cursor owner (Codex P1 on #3352)", () => {
    // Live: start A(1), start B(2). Client pages A then B, leaving cursor 2.
    // complete A(3) arrives: A expands to 1..3 while B still ends at 2. The
    // exact-match branch used to advance past B and return -1, so A's response
    // never emitted. Re-emit A first; once the client holds A's new endSeq,
    // the next page advances to B as usual.
    const before = [fold("1", "1"), fold("2", "2")];
    expect(foldPageStart(before, "1")).toBe(1);
    expect(foldPageStart(before, "2")).toBe(-1);
    const afterACompletes = [fold("1", "3"), fold("2", "2")];
    expect(foldPageStart(afterACompletes, "2")).toBe(0);
    expect(foldPageStart(afterACompletes, "3")).toBe(1);
    // After the client pages A's new endSeq, B's completion is the next fold.
    // A stale cursor of 2 with both complete has no exact owner, so the grown
    // path re-emits B (last containing range), which is the remaining delta.
    const bothComplete = [fold("1", "3"), fold("2", "4")];
    expect(foldPageStart(bothComplete, "3")).toBe(1);
    expect(foldPageStart(bothComplete, "2")).toBe(1);
  });

  it("falls through to opening.seq when the cursor sits between folds", () => {
    const folds = [fold("1", "1"), fold("5", "5")];
    expect(foldPageStart(folds, "3")).toBe(1);
  });
});

// ── Reassembly (spec §14) ───────────────────────────────────────────────────

/** A recorded model stream: what a streaming provider actually writes down. */
function modelStream(
  chunks: readonly string[],
  stopReason = "end_turn",
): string {
  const events: string[] = [
    JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 41,
          cache_read_input_tokens: 21_000,
          cache_creation_input_tokens: 512,
          output_tokens: 1,
        },
      },
    }),
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    }),
    ...chunks.map((text) =>
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
    JSON.stringify({ type: "content_block_stop", index: 0 }),
    JSON.stringify({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_a", name: "Write" },
    }),
    JSON.stringify({
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          file_path: "/p/notes.md",
          content: "x".repeat(900),
        }),
      },
    }),
    JSON.stringify({ type: "content_block_stop", index: 1 }),
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: 400 },
    }),
    JSON.stringify({ type: "message_stop" }),
  ];
  return events.map((data) => `event: e\ndata: ${data}\n\n`).join("");
}

describe("get_run_transcript reassembly", () => {
  it("answers the message, not the stream, and leaves the wire off the page", async () => {
    const wire = modelStream(["I'll write ", "the filing plan."]);
    const { transcript } = harness([
      tachoRow(1, {
        kind: "llm_call",
        model: "claude-opus-5",
        provider: "anthropic",
        ttftMs: 290,
        apiDurationMs: 8000,
        ...stored(wire, "text/event-stream"),
      }),
    ]);

    const page = await transcript(input({ zoom: "everything" }), ctx());
    const body = page.entries[0]?.response ?? page.entries[0]?.request;

    expect(body?.text).toBeNull();
    const assembly = body?.assembly;
    expect(assembly).not.toBeNull();
    expect(assembly?.blocks.map((b) => b.kind)).toEqual(["text", "tool_use"]);
    const text = assembly?.blocks[0];
    expect(text?.kind === "text" && text.text).toBe(
      "I'll write the filing plan.",
    );
    expect(assembly?.precis).toBe(
      "Wrote the filing plan, then asked for Write.",
    );
    expect(assembly?.stopReason).toBe("end_turn");
    expect(assembly?.ttftMs).toBe(290);
    expect(assembly?.durationMs).toBe(8000);
    expect(assembly?.tokensPerSecond).toBe(50);
    expect(assembly?.usage).toEqual({
      inputTokens: 41,
      cacheReadTokens: 21_000,
      cacheWriteTokens: 512,
      outputTokens: 400,
    });
    expect(assembly?.partial).toBe(false);
    expect(assembly?.wire.bytes).toBe(Buffer.byteLength(wire, "utf8"));
    // The point of the change: the page is a fraction of the transport.
    expect(JSON.stringify(page).length).toBeLessThan(assembly?.wire.bytes ?? 0);
  });

  it("folds a long field in a tool call's input to its length", async () => {
    const { transcript } = harness([
      tachoRow(1, {
        kind: "llm_call",
        model: "claude-opus-5",
        provider: "anthropic",
        ...stored(modelStream(["done."]), "text/event-stream"),
      }),
    ]);

    const page = await transcript(input({ zoom: "everything" }), ctx());
    const call = (page.entries[0]?.response ?? page.entries[0]?.request)
      ?.assembly?.blocks[1];

    expect(call?.kind).toBe("tool_use");
    if (call?.kind !== "tool_use") throw new Error("expected a tool call");
    expect(call.inputFolded).toBe(true);
    expect(call.input).toEqual({
      file_path: "/p/notes.md",
      content: "…900 characters",
    });
  });

  it("renders the blocks of a stream that was cut off, and says it was", async () => {
    const cut = modelStream(["half a senten"]).split(
      'event: e\ndata: {"type":"content_block_stop',
    )[0] as string;
    const { transcript } = harness([
      tachoRow(1, {
        kind: "llm_call",
        model: "claude-opus-5",
        provider: "anthropic",
        ...stored(cut, "text/event-stream"),
      }),
    ]);

    const page = await transcript(input({ zoom: "everything" }), ctx());
    const assembly = (page.entries[0]?.response ?? page.entries[0]?.request)
      ?.assembly;

    expect(assembly?.partial).toBe(true);
    expect(assembly?.blocks).toHaveLength(1);
    const only = assembly?.blocks[0];
    expect(only?.kind === "text" && only.text).toBe("half a senten");
    expect(only?.partial).toBe(true);
  });

  it("leaves a body that is not a model stream reading exactly as before", async () => {
    const { transcript } = harness([
      tachoRow(1, { kind: "tool_call", ...stored("the tool's result") }),
    ]);

    const page = await transcript(input({ zoom: "everything" }), ctx());
    const body = page.entries[0]?.response ?? page.entries[0]?.request;

    expect(body?.assembly).toBeNull();
    expect(body?.text).toBe("the tool's result");
  });

  it("prices each block at the model's output rate when the book has one", async () => {
    const { transcript } = harness([
      tachoRow(1, {
        kind: "llm_call",
        model: "claude-opus-5",
        provider: "anthropic",
        ...stored(modelStream(["priced."]), "text/event-stream"),
      }),
    ]);
    const page = await transcript(input({ zoom: "everything" }), ctx());
    const assembly = (page.entries[0]?.response ?? page.entries[0]?.request)
      ?.assembly;

    // The harness's book prices nothing, so every block's cost is left out
    // rather than drawn as a zero.
    expect(assembly?.blocks.every((b) => b.cost === null)).toBe(true);
    expect(assembly?.blocks.reduce((sum, b) => sum + b.tokens, 0)).toBe(400);
  });
});

describe("get_run_transcript and one unreadable body", () => {
  // One body the store could not answer (a missing object, an unknown key id,
  // a transient failure) used to reject the whole page, and with it the
  // Policy, Context and stats tabs that read the same page.
  it("answers the page with that half unread and every other half read", async () => {
    const { transcript, getBody } = harness([
      tachoRow(0, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
        ...stored("Fix the build."),
      }),
      tachoRow(1, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
        contentDigest: `sha256:${"5".repeat(64)}`,
        bytesRef: `evb:v1:k:${"5".repeat(64)}`,
      }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(getBody).toHaveBeenCalledTimes(2);
    expect(out.entries.map((e) => e.request?.text ?? null)).toEqual([
      "Fix the build.",
      null,
    ]);
    const unread = out.entries[1]?.response;
    expect(unread?.text).toBeNull();
    expect(unread?.assembly).toBeNull();
    expect(unread?.digest).toBe(`sha256:${"5".repeat(64)}`);
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
  });

  it("answers the page when the stored reassembly cannot be read", async () => {
    const wire = stored(modelStream(["Done."]), "text/event-stream");
    const { deps } = harness([
      tachoRow(0, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        ...wire,
      }),
    ]);
    const handler = createRunTranscriptGetHandler({
      ...deps,
      bodies: {
        getBody: deps.bodies.getBody,
        getAssembly: () => Promise.reject(new Error("store unavailable")),
      },
    });
    const out = await handler(input({ zoom: "everything" }), ctx());
    expect(out.entries[0]?.response?.text).toBeNull();
    expect(out.entries[0]?.response?.assembly).toBeNull();
  });
});

describe("get_run_transcript cost in a proxy-metered session", () => {
  it("counts an observed call once: the harness's own report after it carries no cost", async () => {
    const observed = {
      kind: "llm_call",
      toolName: "",
      toolStatus: "",
      source: "collector",
      fidelity: "proxy",
      attrs: { "oxagen.metering": "observed" },
      body: JSON.stringify({ input_tokens: 10, output_tokens: 5 }),
    };
    const { transcript } = harness([
      tachoRow(0, { ...observed, costUsdMicros: 500 }),
      // The harness's OTel record of the same call.
      tachoRow(1, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        source: "otel_log",
        body: JSON.stringify({ input_tokens: 10, output_tokens: 5 }),
        costUsdMicros: 500,
      }),
      // A later sighting the host stamped.
      tachoRow(2, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        source: "transcript",
        attrs: { "oxagen.llm_call_duplicate_of": "collector" },
        costUsdMicros: 500,
      }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries.map((e) => e.cost?.micros ?? null)).toEqual([
      "500",
      null,
      null,
    ]);
    expect(out.entries.at(-1)?.cumulativeCost?.micros).toBe("500");
  });
});

describe("get_run_transcript and subagent chains", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
  const child = (seq: number, over: Partial<TachoFrameRow>): TachoFrameRow =>
    tachoRow(seq, {
      sessionUuid: CHILD,
      rootSessionUuid: SESSION_UUID,
      parentSessionUuid: SESSION_UUID,
      subagentId: "agent-1",
      subagentType: "Explore",
      spawnToolUseId: "toolu_task",
      ts: `2026-09-11 09:00:${String(10 + seq).padStart(2, "0")}.000`,
      ...over,
    });
  const root = [
    tachoRow(0, {
      kind: "turn_start",
      toolName: "",
      toolStatus: "",
      turnSeq: 1,
    }),
    tachoRow(1, {
      kind: "tool_requested",
      toolName: "Task",
      toolUseId: "toolu_task",
      turnSeq: 1,
    }),
    tachoRow(2, {
      kind: "subagent_start",
      toolName: "",
      toolStatus: "",
      toolUseId: "toolu_task",
      turnSeq: 1,
    }),
    tachoRow(3, {
      kind: "tool_call",
      toolName: "Task",
      toolUseId: "toolu_task",
      turnSeq: 1,
      ts: "2026-09-11 09:00:30.000",
    }),
    tachoRow(4, {
      kind: "turn_end",
      toolName: "",
      toolStatus: "",
      turnSeq: 1,
      ts: "2026-09-11 09:00:31.000",
    }),
  ];
  const children = [
    child(0, { kind: "turn_start", toolName: "", toolStatus: "", turnSeq: 1 }),
    child(1, {
      kind: "llm_call",
      toolName: "",
      toolStatus: "",
      costUsdMicros: 300,
      ...stored("Looking at the repository."),
    }),
    child(2, {
      kind: "tool_requested",
      toolName: "Grep",
      toolUseId: "toolu_g",
    }),
    child(3, { kind: "tool_call", toolName: "Grep", toolUseId: "toolu_g" }),
  ];

  it("shows the subagent's work where it was spawned, named as the subagent's", async () => {
    // A subagent records on its own chain. The transcript read only the
    // root's, so none of this reached the Run page.
    const { transcript } = harness(root, undefined, children);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(
      out.entries.map((e) =>
        e.subagent ? `${e.subagent.id}:${e.seq}` : e.seq,
      ),
    ).toEqual([
      "0",
      "1",
      "2",
      "agent-1:0",
      "agent-1:1",
      "agent-1:2",
      "agent-1:3",
      "3",
      "4",
    ]);
    const model = out.entries[4];
    expect(model?.response?.text).toBe("Looking at the repository.");
    expect(model?.response?.sessionUuid).toBe(CHILD);
    expect(model?.cost?.micros).toBe("300");
    // The subagent's turn_start is inside the run's first turn.
    expect(out.entries.map((e) => e.turn)).toEqual(Array(9).fill(1));
    // Negative: the run's own frames name no subagent.
    expect(out.entries[0]?.subagent).toBeUndefined();
  });

  it("steps: the parent's Task call pairs with its result across the subagent's steps", async () => {
    const { transcript } = harness(root, undefined, children);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    const task = out.entries.find(
      (e) => e.label.startsWith("Task") && e.subagent === undefined,
    );
    expect(task?.request?.seq).toBe("1");
    expect(task?.response?.seq).toBe("3");
    const grep = out.entries.find((e) => e.label.startsWith("Grep"));
    expect(grep?.subagent?.sessionUuid).toBe(CHILD);
    expect([grep?.request?.seq, grep?.response?.seq]).toEqual(["2", "3"]);
  });

  it("pages one entry at a time through both chains and returns each entry once", async () => {
    const { transcript } = harness(root, undefined, children);
    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = await transcript(
        input({
          zoom: "everything",
          limit: 1,
          ...(after === undefined ? {} : { after }),
        }),
        ctx(),
      );
      for (const e of page.entries) seen.push(e.subagent ? `c${e.seq}` : e.seq);
      if (page.cursor === null) break;
      after = page.cursor;
    }
    expect(seen).toEqual(["0", "1", "2", "c0", "c1", "c2", "c3", "3", "4"]);
  });

  it("reads a cursor of either form, and refuses a malformed chain cursor (negative)", () => {
    const composite = encodeTranscriptCursor(`${CHILD}:2`);
    expect(decodeTranscriptCursor(composite)).toBe(`${CHILD}:2`);
    expect(decodeTranscriptCursor(encodeTranscriptCursor("7"))).toBe("7");
    expect(
      decodeTranscriptCursor(encodeTranscriptCursor("not-a-uuid:2")),
    ).toBeNull();
  });

  it("resumes a cursor whose frame is no longer shown before the next frame of its chain", () => {
    const frames = [0, 1, 3].map((seq) =>
      tachoFrameOf(tachoRow(seq, { kind: "turn_end" })),
    );
    expect(cursorPosition(frames, "2")).toBe(1);
    expect(cursorPosition(frames, "3")).toBe(2);
    expect(cursorPosition(frames, "-1")).toBe(-1);
    expect(cursorPosition(frames, "9")).toBe(2);
  });
});

describe("get_run_transcript and one model call seen twice", () => {
  it("shows a proxied call once when its later sighting carries no body", async () => {
    const body = JSON.stringify({ request_id: "req_1", input_tokens: 3 });
    const { transcript } = harness([
      tachoRow(0, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        source: "collector",
        body,
        costUsdMicros: 80,
        ...stored("The reply."),
      }),
      tachoRow(1, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        source: "otel_log",
        body,
        attrs: { "oxagen.llm_call_duplicate_of": "collector" },
        costUsdMicros: 80,
      }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.response?.text).toBe("The reply.");
    expect(out.entries[0]?.cost?.micros).toBe("80");
  });
});
