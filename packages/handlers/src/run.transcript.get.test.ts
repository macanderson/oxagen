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
  planTranscriptPage,
  type RunTranscriptGetDeps,
  toolResultsOf,
  withToolUseFacts,
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

  it("steps: each model call, tool call and event is its own entry, within its turn", async () => {
    // Before ADR-182 every other frame folded into the step before it, so
    // turn 2's prompt sat inside turn 1's tool call.
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(
      out.entries.map((e) => [e.seq, e.endSeq, e.kind, e.frames, e.turn]),
    ).toEqual([
      ["0", "0", "frame", 1, null],
      ["1", "1", "frame", 1, 1],
      ["2", "2", "model_call", 1, 1],
      ["3", "3", "tool_call", 1, 1],
      ["4", "4", "frame", 1, 2],
      ["5", "5", "model_call", 1, 2],
      ["6", "6", "frame", 1, 2],
    ]);
    expect(out.entries.map((e) => e.cost?.micros ?? null)).toEqual([
      null,
      null,
      "40",
      null,
      null,
      "60",
      null,
    ]);
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
      // The gate records the call it decided on, as hook-handler.ts seals it.
      tachoRow(1, {
        kind: "policy_decision",
        toolName: "",
        toolStatus: "",
        policyDecision: "route",
        toolUseId: "tu_shared",
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

  // #3370: `kinds` is the union over every folded frame. A turn whose model
  // call filled its response slot still holds the failed tool call after it,
  // and that call is the entry's only sign of an error.
  it("turns: an entry answers to the chips of every frame it folds, not only its halves", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
      }),
      tachoRow(1, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        model: "haiku",
        provider: "anthropic",
        turnSeq: 1,
      }),
      tachoRow(2, { turnSeq: 1, toolStatus: "error" }),
    ]);
    const out = await transcript(input({ zoom: "turns" }), ctx());
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.kinds).toEqual(
      expect.arrayContaining(["prompt", "responses", "tools", "errors"]),
    );
    // A turn with no failed call answers no errors chip (negative).
    const clean = harness([
      tachoRow(0, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
      }),
      tachoRow(1, { turnSeq: 1 }),
    ]);
    const quiet = await clean.transcript(input({ zoom: "turns" }), ctx());
    expect(quiet.entries[0]?.kinds).toContain("tools");
    expect(quiet.entries[0]?.kinds).not.toContain("errors");
  });

  it("filters the entries by the chips pressed after folding, and echoes the selection", async () => {
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

  it("steps: a filtered read shows the same step, both halves and all, as an unfiltered one", async () => {
    const { transcript } = harness([
      tachoRow(0, { kind: "llm_call", toolName: "", model: "haiku" }),
      tachoRow(1, {
        kind: "policy_decision",
        toolName: "Read",
        toolStatus: "",
        policyDecision: "allow",
        toolUseId: "tu_r",
      }),
      tachoRow(2, {
        kind: "tool_requested",
        toolStatus: "",
        toolUseId: "tu_r",
      }),
      tachoRow(3, { kind: "tool_call", toolUseId: "tu_r" }),
    ]);
    const all = await transcript(input({ zoom: "steps" }), ctx());
    const policy = await transcript(
      input({ zoom: "steps", kinds: ["policy"] }),
      ctx(),
    );
    expect(policy.entries).toEqual([all.entries[1]]);
    expect(policy.entries[0]?.request?.seq).toBe("2");
    expect(policy.entries[0]?.response?.seq).toBe("3");
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
    expect(
      decodeTranscriptCursor(
        encodeTranscriptCursor({ through: "42", high: "44" }),
      ),
    ).toEqual({ through: "42", high: "44" });
    // A cursor issued before `high` existed names one frame, read as both.
    const legacy = Buffer.from("t:42", "utf8").toString("base64url");
    expect(decodeTranscriptCursor(legacy)).toEqual({
      through: "42",
      high: "42",
    });
    const three = Buffer.from("t:1,2,3", "utf8").toString("base64url");
    expect(decodeTranscriptCursor(three)).toBeNull();
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
      counts: {
        kinds: {
          prompt: 0,
          responses: 0,
          thinking: 0,
          tools: 0,
          policy: 0,
          usage: 0,
          recall: 0,
          seal: 0,
          errors: 0,
        },
        entries: 0,
        errors: 0,
        policy: 0,
      },
      figures: {
        steps: { model: 0, tool: 0 },
        prompts: 0,
        calls: { count: 0, failed: 0, tools: [], families: [], batches: null },
        wall: { modelMs: 0, toolMs: 0, waitingMs: 0 },
      },
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
    expect(decodeTranscriptCursor(out.cursor as string)).toEqual({
      through: out.entries.at(-1)?.seq,
      high: out.entries.at(-1)?.endSeq,
    });
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
    expect(decodeTranscriptCursor(out.cursor as string)).toEqual({
      through: "-1",
      high: "-1",
    });
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
    expect(decodeTranscriptCursor(caughtUp.cursor as string)).toEqual(
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

describe("planTranscriptPage", () => {
  const span = (open: number, end: number) => ({ open, end });

  it("sends the first page from the start and stands on its last fold", () => {
    const folds = [span(0, 0), span(1, 2), span(3, 3)];
    expect(planTranscriptPage(folds, null, 2)).toEqual({
      indexes: [0, 1],
      through: 1,
      high: 2,
    });
    expect(planTranscriptPage([], null, 2)).toEqual({
      indexes: [],
      through: -1,
      high: -1,
    });
  });

  it("resumes at the next fold when openings overlap", () => {
    // start A, start B, done A, done B: A spans 1..3 and B spans 2..4. A
    // cursor that kept only A's end looked for an opening past 3 and never
    // sent B (Codex P1 on #3352).
    const folds = [span(1, 3), span(2, 4)];
    expect(planTranscriptPage(folds, { through: 0, high: 3 }, 5)).toEqual({
      indexes: [1],
      through: 1,
      high: 4,
    });
  });

  it("sends a grown fold once per growth, then nothing", () => {
    // Live: A and B both started and were sent. A completes before B.
    const sent = { through: 1, high: 2 };
    const aDone = [span(1, 3), span(2, 2)];
    const resent = planTranscriptPage(aDone, sent, 5);
    expect(resent).toEqual({ indexes: [0], through: 1, high: 3 });
    // The single-frame cursor sent B again here, though B had not changed.
    const bDone = [span(1, 3), span(2, 4)];
    const next = planTranscriptPage(bDone, resent, 5);
    expect(next).toEqual({ indexes: [1], through: 1, high: 4 });
    expect(planTranscriptPage(bDone, next, 5).indexes).toEqual([]);
  });

  it("does not resend the folds inside a grown fold's span (negative)", () => {
    // A Task call opens at 0 and its subagent's steps land inside its span.
    // When the Task call completes, only the Task entry has changed. The
    // single-frame cursor sent the Task entry and every step after it, and
    // stood where it stood before, so each read sent the same page again.
    const beforeDone = [span(0, 0), span(1, 1), span(2, 2), span(3, 3)];
    const first = planTranscriptPage(beforeDone, null, 2);
    const second = planTranscriptPage(beforeDone, first, 2);
    expect(second).toEqual({ indexes: [2, 3], through: 3, high: 3 });
    const taskDone = [span(0, 5), span(1, 1), span(2, 2), span(3, 3)];
    const third = planTranscriptPage(taskDone, second, 2);
    expect(third).toEqual({ indexes: [0], through: 3, high: 5 });
    for (let poll = 0; poll < 3; poll += 1) {
      expect(planTranscriptPage(taskDone, third, 2).indexes).toEqual([]);
    }
  });

  it("sends grown folds first, oldest growth first, and fills the rest with new folds", () => {
    const folds = [span(0, 6), span(1, 5), span(2, 2), span(7, 7), span(8, 8)];
    expect(planTranscriptPage(folds, { through: 2, high: 2 }, 3)).toEqual({
      indexes: [1, 0, 3],
      through: 3,
      high: 7,
    });
  });

  it("leaves grown folds past the limit for the next page, never dropping one", () => {
    const folds = [span(0, 9), span(1, 7), span(2, 8)];
    const first = planTranscriptPage(folds, { through: 2, high: 2 }, 2);
    expect(first).toEqual({ indexes: [1, 2], through: 2, high: 8 });
    expect(planTranscriptPage(folds, first, 2)).toEqual({
      indexes: [0],
      through: 2,
      high: 9,
    });
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

  it("reads only the price rows for the page's models over the page's span", async () => {
    // #4202. The page loaded the organization's whole price book, 28,246 rows
    // in production, for every read, whatever its limit.
    const { deps } = harness([
      tachoRow(1, {
        kind: "llm_call",
        model: "claude-opus-5",
        provider: "anthropic",
        ts: "2026-09-11 09:00:10.000",
        ...stored(modelStream(["first."]), "text/event-stream"),
      }),
      tachoRow(2, {
        kind: "llm_call",
        model: "claude-haiku-4.5",
        provider: "anthropic",
        ts: "2026-09-11 09:00:40.000",
        ...stored(modelStream(["second."]), "text/event-stream"),
      }),
    ]);
    const priceBook = vi.fn(() => Promise.resolve([]));
    deps.priceBook = priceBook;

    await createRunTranscriptGetHandler(deps)(
      input({ zoom: "everything" }),
      ctx(),
    );

    expect(priceBook).toHaveBeenCalledTimes(1);
    // A frame names its model under its provider, the id `outputRate` prices.
    expect(priceBook).toHaveBeenCalledWith({
      orgId: ctx().orgId,
      models: ["anthropic/claude-opus-5", "anthropic/claude-haiku-4.5"],
      from: new Date("2026-09-11T09:00:10.000Z"),
      to: new Date("2026-09-11T09:00:40.000Z"),
    });
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

  it("steps: a live subagent's steps are sent once when its Task call completes", async () => {
    // The repeat the Run page showed 20 to 40 times over: a Task call's step
    // spans its subagent's steps. When the Task result landed, every read of
    // the live run sent the Task step and each subagent step after it again.
    const live = { outcome: "running", sealedAt: null };
    const running = harness(root.slice(0, 3), live, children);
    const first = await running.transcript(input({ zoom: "steps" }), ctx());
    // The prompt, the Task call, the subagent's brief, its model call and its
    // Grep call.
    expect(first.entries.map((e) => e.label.split(" ")[0])).toHaveLength(5);
    const done = harness(root, live, children);
    const reads: string[][] = [];
    let after = first.cursor as string;
    for (let poll = 0; poll < 4; poll += 1) {
      const page = await done.transcript(
        input({ zoom: "steps", after }),
        ctx(),
      );
      reads.push(page.entries.map((e) => `${e.seq}-${e.endSeq}`));
      after = page.cursor as string;
    }
    // The Task step once with its result, the turn's end as its own entry,
    // then nothing.
    expect(reads).toEqual([["1-3", "4-4"], [], [], []]);
  });

  it("reads a cursor of either form, and refuses a malformed chain cursor (negative)", () => {
    const composite = encodeTranscriptCursor({
      through: `${CHILD}:2`,
      high: `${CHILD.toUpperCase()}:3`,
    });
    expect(decodeTranscriptCursor(composite)).toEqual({
      through: `${CHILD}:2`,
      high: `${CHILD}:3`,
    });
    expect(
      decodeTranscriptCursor(
        encodeTranscriptCursor({ through: "7", high: "7" }),
      ),
    ).toEqual({ through: "7", high: "7" });
    expect(
      decodeTranscriptCursor(
        encodeTranscriptCursor({ through: "not-a-uuid:2", high: "2" }),
      ),
    ).toBeNull();
    // The longest cursor, two subagent keys at the largest seq, fits the
    // contract's 256-character bound.
    const longest = encodeTranscriptCursor({
      through: `${CHILD}:${"9".repeat(19)}`,
      high: `${CHILD}:${"9".repeat(19)}`,
    });
    expect(longest.length).toBeLessThanOrEqual(256);
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

describe("get_run_transcript states what the fold says about each entry (ADR-182)", () => {
  const blank = { toolName: "", toolStatus: "", toolUseId: "" };
  const governed = [
    tachoRow(0, {
      kind: "turn_start",
      ...blank,
      turnSeq: 1,
      ...stored("Fix the build."),
    }),
    tachoRow(1, {
      kind: "policy_decision",
      toolName: "Bash",
      toolStatus: "",
      toolUseId: "tu_b",
      policyDecision: "allow",
      turnSeq: 1,
    }),
    tachoRow(2, {
      kind: "tool_requested",
      toolName: "Bash",
      toolStatus: "",
      toolUseId: "tu_b",
      turnSeq: 1,
    }),
    tachoRow(3, {
      kind: "tool_call",
      toolName: "Bash",
      toolUseId: "tu_b",
      turnSeq: 1,
    }),
    // The transcript's copy of the prompt, sealed with its words.
    tachoRow(4, {
      kind: "turn_end",
      ...blank,
      turnSeq: 1,
      ...stored("Fix the build."),
    }),
    tachoRow(5, { kind: "oxagen:hook_health", ...blank, turnSeq: 1 }),
  ];

  it("names each entry, what kind of row it is, how it ended, and what it repeats", async () => {
    const { transcript } = harness(governed);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(
      out.entries.map((e) => [e.key, e.node, e.quiet, e.outcome, e.echoOf]),
    ).toEqual([
      ["0", "prompt", false, null, null],
      ["1", "tool", false, "ok", null],
      ["4", "reply", false, null, "0"],
      ["5", "control", true, null, null],
    ]);
    const call = out.entries[1];
    expect(call).toMatchObject({
      subject: "Bash",
      family: "shell",
      model: null,
      approvalId: null,
      parentKey: null,
      durationMs: 2_000,
      recall: null,
    });
    expect(call?.gates?.map((g) => [g.seq, g.decision])).toEqual([
      ["1", "allow"],
    ]);
    expect(call?.decision).toEqual(call?.gates?.[0]);
    expect(out.entries[0]?.request?.text).toBe("Fix the build.");
  });

  it("counts the run's entries at the zoom whatever the chips pressed", async () => {
    const { transcript } = harness(governed);
    const all = await transcript(input({ zoom: "steps" }), ctx());
    const tools = await transcript(
      input({ zoom: "steps", kinds: ["tools"] }),
      ctx(),
    );
    expect(tools.entries.map((e) => e.key)).toEqual(["1"]);
    expect(tools.counts).toEqual(all.counts);
    expect(all.counts).toMatchObject({ entries: 3, errors: 0, policy: 1 });
    expect(all.counts?.kinds).toMatchObject({ prompt: 1, tools: 1, policy: 1 });
    // A later page says what the whole run holds, not what the page holds.
    const first = await transcript(input({ zoom: "steps", limit: 2 }), ctx());
    const later = await transcript(
      input({ zoom: "steps", limit: 2, after: first.cursor ?? undefined }),
      ctx(),
    );
    expect(later.entries.map((e) => e.key)).toEqual(["4", "5"]);
    expect(later.counts).toEqual(all.counts);
  });

  it("carries the whole body when asked, and an excerpt when asked", async () => {
    const long = "z".repeat(TRANSCRIPT_STEP_TEXT_MAX + 50);
    const { transcript } = harness([
      tachoRow(0, { kind: "tool_call", ...stored(long) }),
    ]);
    const full = await transcript(
      input({ zoom: "steps", text: "full" }),
      ctx(),
    );
    expect(full.entries[0]?.response?.text).toBe(long);
    expect(full.entries[0]?.response?.truncated).toBe(false);
    const excerpt = await transcript(
      input({ zoom: "everything", text: "excerpt" }),
      ctx(),
    );
    expect(excerpt.entries[0]?.response?.text).toHaveLength(
      TRANSCRIPT_STEP_TEXT_MAX,
    );
    // Asking for nothing keeps the zoom's cap (negative).
    const plain = await transcript(input({ zoom: "steps" }), ctx());
    expect(plain.entries[0]?.response?.truncated).toBe(true);
  });

  it("reads a steering manifest's recall from its body, and falls back when the body cannot be read", async () => {
    const manifest = JSON.stringify({
      schema: "oxagen.steering.manifest/1",
      included: 1,
      cut: 1,
      spent_tokens: 120,
      items: [
        { id: "rec_1", kind: "rule", tokens: 120, outcome: "included" },
        { id: "rec_2", kind: "fact", tokens: 900, outcome: "cut" },
      ],
    });
    const { transcript } = harness([
      tachoRow(0, { kind: "steering.manifest", ...blank, ...stored(manifest) }),
      tachoRow(1, {
        kind: "steering.manifest",
        ...blank,
        contentDigest: `sha256:${"e".repeat(64)}`,
        bytesRef: `evb:v1:k:${"e".repeat(64)}`,
      }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries[0]?.recall).toEqual({
      unit: "items",
      count: 1,
      tokens: 120,
      cut: 1,
      items: [{ kind: "rule", label: "rec_1", tokens: 120 }],
    });
    expect(out.entries[1]?.recall).toEqual({
      unit: "frames",
      count: null,
      tokens: null,
      cut: null,
      items: [],
    });
  });

  it("does not parse a recall body that no longer hashes to its digest (negative)", async () => {
    const claimed = stored(JSON.stringify({ included: 9, items: [] }));
    objects.set(claimed.bytesRef, {
      bytes: enc.encode(JSON.stringify({ included: 1, items: [] })),
      contentType: "application/json",
    });
    const { transcript } = harness([
      tachoRow(0, { kind: "steering.manifest", ...blank, ...claimed }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries[0]?.recall?.count).toBeNull();
  });

  it("names the tool step that recorded each call a reply made, and none for a call nobody recorded", async () => {
    const { transcript } = harness([
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        ...stored(modelStream(["Writing it."]), "text/event-stream"),
      }),
      tachoRow(2, {
        kind: "tool_call",
        toolName: "Write",
        toolUseId: "toolu_a",
      }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    const call = out.entries[0]?.response?.assembly?.blocks[1];
    expect(call).toMatchObject({
      kind: "tool_use",
      stepKey: "2",
      result: null,
    });
    const alone = harness([
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        ...stored(modelStream(["Writing it."]), "text/event-stream"),
      }),
    ]);
    const unrecorded = await alone.transcript(input({ zoom: "steps" }), ctx());
    expect(unrecorded.entries[0]?.response?.assembly?.blocks[1]).toMatchObject({
      kind: "tool_use",
      stepKey: null,
    });
  });

  it("nests a subagent's steps under the call that spawned them", async () => {
    const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
    const { transcript } = harness(
      [
        tachoRow(0, { kind: "turn_start", ...blank, turnSeq: 1 }),
        tachoRow(1, {
          kind: "tool_requested",
          toolName: "Task",
          toolUseId: "toolu_task",
        }),
        tachoRow(2, {
          kind: "subagent_start",
          ...blank,
          toolUseId: "toolu_task",
        }),
        tachoRow(3, {
          kind: "tool_call",
          toolName: "Task",
          toolUseId: "toolu_task",
          ts: "2026-09-11 09:00:30.000",
        }),
      ],
      undefined,
      [
        tachoRow(0, {
          kind: "tool_call",
          toolName: "Grep",
          toolUseId: "toolu_g",
          sessionUuid: CHILD,
          rootSessionUuid: SESSION_UUID,
          parentSessionUuid: SESSION_UUID,
          subagentId: "agent-1",
          subagentType: "Explore",
          spawnToolUseId: "toolu_task",
          ts: "2026-09-11 09:00:10.000",
        }),
      ],
    );
    const out = await transcript(input({ zoom: "steps" }), ctx());
    const grep = out.entries.find((e) => e.subject === "Grep");
    expect(grep).toMatchObject({ key: `${CHILD}:0`, parentKey: "1" });
    expect(grep?.subagent?.parentSessionUuid).toBe(SESSION_UUID);
  });
});

describe("toolResultsOf and withToolUseFacts", () => {
  const base = {
    id: "b",
    chars: 1,
    tokens: 0,
    partial: false,
    cost: null,
  };
  const half = (blocks: unknown[]) =>
    ({
      seq: "1",
      type: "llm_call",
      digest: null,
      bytesRef: null,
      redactions: [],
      fidelity: "full",
      text: null,
      truncated: false,
      assembly: {
        blocks,
        precis: "",
        stopReason: null,
        ttftMs: null,
        durationMs: null,
        tokensPerSecond: null,
        usage: {
          inputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: null,
        },
        partial: false,
        wire: { events: 0, bytes: 0 },
      },
    }) as Parameters<typeof withToolUseFacts>[0];
  const use = (callKey: string | null) => ({
    ...base,
    kind: "tool_use",
    name: "Read",
    input: {},
    inputRaw: false,
    inputFolded: false,
    callKey,
    verdict: null,
  });

  it("joins a tool_result to the call it answers, and claims each call once", () => {
    const answered = half([
      {
        ...base,
        kind: "tool_result",
        forId: "k1",
        ok: false,
        summary: "no such file",
        bytes: null,
        ms: null,
      },
    ]);
    const results = toolResultsOf([answered, null]);
    const out = withToolUseFacts(
      half([
        use("k1"),
        use(null),
        { ...base, kind: "text", text: "x", truncated: false },
      ]),
      (uses) => uses.map((u) => (u.callKey === null ? null : "7")),
      results,
    );
    expect(out?.assembly?.blocks).toEqual([
      {
        ...use("k1"),
        stepKey: "7",
        result: { ok: false, summary: "no such file" },
      },
      { ...use(null), stepKey: null, result: null },
      { ...base, kind: "text", text: "x", truncated: false },
    ]);
  });

  it("leaves a half with no assembly, or no tool_use block, as it is (negative)", () => {
    const claim = () => [];
    expect(withToolUseFacts(null, claim, new Map())).toBeNull();
    const plain = {
      ...(half([]) as NonNullable<Parameters<typeof withToolUseFacts>[0]>),
      assembly: null,
    };
    expect(withToolUseFacts(plain, claim, new Map())).toBe(plain);
    const textOnly = half([
      { ...base, kind: "text", text: "x", truncated: false },
    ]);
    expect(withToolUseFacts(textOnly, claim, new Map())).toBe(textOnly);
  });
});

describe("get_run_transcript search and figures (#3942, ADR-182)", () => {
  const blank = { toolName: "", toolStatus: "", toolUseId: "" };
  // The Read call's request was kept as a digest only; its result was kept.
  const readRequest = { ...stored('{"path":"src/limits.ts"}'), bytesRef: "" };
  const forged = stored("the real words");
  objects.set(forged.bytesRef, {
    bytes: enc.encode("words the record does not vouch for"),
    contentType: "text/plain",
  });
  const run = [
    tachoRow(0, {
      kind: "turn_start",
      ...blank,
      turnSeq: 1,
      ...stored("Find the flaky test."),
    }),
    tachoRow(1, {
      kind: "tool_requested",
      toolName: "Grep",
      toolStatus: "",
      toolUseId: "tu_g",
      turnSeq: 1,
      body: JSON.stringify({ tool_target: "packages/Retry" }),
      ...stored('{"pattern":"flaky"}'),
    }),
    tachoRow(2, {
      kind: "tool_call",
      toolName: "Grep",
      toolUseId: "tu_g",
      turnSeq: 1,
      ...stored("src/runner.test.ts:12: it.retry(3)"),
    }),
    tachoRow(3, {
      kind: "tool_requested",
      toolName: "Read",
      toolStatus: "",
      toolUseId: "tu_r",
      turnSeq: 1,
      ...readRequest,
    }),
    tachoRow(4, {
      kind: "tool_call",
      toolName: "Read",
      toolUseId: "tu_r",
      turnSeq: 1,
      ...stored("RETRY_LIMIT = 3"),
    }),
    tachoRow(5, {
      kind: "turn_end",
      ...blank,
      turnSeq: 1,
      ...stored("The runner calls retry three times."),
    }),
    // A body that no longer hashes to its digest is not searched.
    tachoRow(6, { kind: "turn_start", ...blank, turnSeq: 2, ...forged }),
  ];

  it("finds the query in any half, ignoring case, and says where it matched", async () => {
    const { transcript } = harness(run);
    const out = await transcript(
      input({ zoom: "steps", query: "  RETRY " }),
      ctx(),
    );
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.entries.map((e) => [e.key, e.matches])).toEqual([
      ["1", ["target", "response"]],
      ["3", ["response"]],
      ["5", ["response"]],
    ]);
    // The digest-only request and the half that no longer hashes.
    expect(out.search).toEqual({ query: "retry", matched: 3, unsearched: 2 });
  });

  it("matches the label and the tool on the entry, with no body read", async () => {
    const { transcript, getBody } = harness(
      run.map((r) => ({ ...r, bytesRef: "" })),
    );
    const out = await transcript(
      input({ zoom: "steps", query: "grep" }),
      ctx(),
    );
    expect(out.entries.map((e) => [e.key, e.matches])).toEqual([
      ["1", ["label", "subject"]],
    ]);
    expect(getBody).not.toHaveBeenCalled();
    // Each call's two halves were digests only. A prompt or reply kept as a
    // digest is no half of its entry, so it is not counted.
    expect(out.search).toMatchObject({ matched: 1, unsearched: 4 });
  });

  it("narrows by the chips first, then the query, and pages the matches on the cursor", async () => {
    const { transcript } = harness(run);
    const tools = await transcript(
      input({ zoom: "steps", kinds: ["tools"], query: "retry" }),
      ctx(),
    );
    expect(tools.entries.map((e) => e.key)).toEqual(["1", "3"]);
    const first = await transcript(
      input({ zoom: "steps", query: "retry", limit: 2 }),
      ctx(),
    );
    expect(first.entries.map((e) => e.key)).toEqual(["1", "3"]);
    const later = await transcript(
      input({
        zoom: "steps",
        query: "retry",
        limit: 2,
        after: first.cursor ?? undefined,
      }),
      ctx(),
    );
    expect(later.entries.map((e) => e.key)).toEqual(["5"]);
    expect(later.cursor).toBeNull();
    expect(later.search).toEqual(first.search);
  });

  it("answers an empty page for a query nothing holds, with the search and figures (negative)", async () => {
    const { transcript } = harness(run);
    const out = await transcript(
      input({ zoom: "steps", query: "nowhere" }),
      ctx(),
    );
    expect(out.entries).toEqual([]);
    expect(out.search).toEqual({ query: "nowhere", matched: 0, unsearched: 2 });
    expect(out.figures?.calls.count).toBe(2);
  });

  it("carries no search and no matches on a read with no query (negative)", async () => {
    const { transcript } = harness(run);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.search).toBeUndefined();
    expect(out.entries.every((e) => e.matches === undefined)).toBe(true);
  });

  it("counts the run's figures over its steps, whatever the zoom, chips or query", async () => {
    const { transcript } = harness(run);
    const steps = await transcript(input({ zoom: "steps" }), ctx());
    expect(steps.figures).toEqual({
      steps: { model: 0, tool: 2 },
      prompts: 2,
      calls: {
        count: 2,
        failed: 0,
        tools: [
          { name: "Grep", calls: 1 },
          { name: "Read", calls: 1 },
        ],
        families: [
          {
            family: "read",
            calls: 1,
            share: 0.5,
            ms: 1_000,
            failed: 0,
            tools: 1,
          },
          {
            family: "search",
            calls: 1,
            share: 0.5,
            ms: 1_000,
            failed: 0,
            tools: 1,
          },
        ],
        batches: {
          count: 1,
          parallel: 1,
          widest: 2,
          fanOut: 2,
          serialMs: 2_000,
          togetherMs: 3_000,
          histogram: [{ width: 2, batches: 1 }],
        },
      },
      wall: { modelMs: 0, toolMs: 2_000, waitingMs: 0 },
    });
    for (const over of [
      { zoom: "everything" },
      { zoom: "turns" },
      { zoom: "steps", kinds: ["seal"] },
      { zoom: "steps", query: "retry", limit: 1 },
    ]) {
      const out = await transcript(input(over), ctx());
      expect(out.figures).toEqual(steps.figures);
    }
  });
});
