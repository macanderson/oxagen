import { isHandlerError } from "@oxagen/oxagen/handler-error";
import {
  runTranscriptGet,
  TRANSCRIPT_STEP_TEXT_MAX,
  TRANSCRIPT_TEXT_MAX,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { digestBytes } from "@oxagen/recorder";
import type { TachoFrameRow } from "@oxagen/telemetry";
import {
  type RunFrame,
  spliceSubagentChains,
  stepFolds,
  tachoFrame as tachoFrameOf,
  type TranscriptFold,
  wordsDigest,
} from "@oxagen/run-ledger";
import {
  BodyKeyGoneError,
  BodyUnopenableError,
} from "@oxagen/run-ledger/evidence-store";
import { StorageNotFoundError } from "@oxagen/storage";
import { describe, expect, it, vi } from "vitest";
import {
  createRunTranscriptGetHandler,
  cursorPosition,
  decodeBeforeCursor,
  decodeTranscriptCursor,
  elapsedMs,
  encodeBeforeCursor,
  encodeTranscriptCursor,
  planPageBefore,
  planTranscriptPage,
  RECEIPT_SETTLE_MS,
  readWords,
  type RunTranscriptGetDeps,
  toolResultsOf,
  unsentFolds,
  withToolUseFacts,
} from "./run.transcript.get";
import {
  ctx,
  event,
  SCOPE,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memorySubagentChains,
  memorySubagentFrames,
  memoryTachoFrames,
  type SubagentChainFixture,
  subagentChain,
  summary,
  tachoRow,
  tachoSession,
} from "./run.test-support";
import {
  createWordsCache,
  UNREADABLE,
  type WordsCache,
} from "./lib/transcript-words-cache";
import { decodeFrameCursor, encodeFrameCursor } from "./run.get";

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

/** The server's clock on every read, so a cursor's receipt is known. */
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

/** A receipt time as ClickHouse renders `received_at`. */
const receipt = (ms: number) =>
  new Date(ms).toISOString().replace("T", " ").replace("Z", "");

/**
 * A wrapped run's handler over `rows`. `options.chains` lists the subagent
 * chains in Postgres, which a read needs to read a window of the run;
 * without them every read reads the whole run.
 */
function harness(
  rows: TachoFrameRow[],
  session?: Partial<{
    outcome: string;
    sealedAt: Date | null;
    seqCount: number;
  }>,
  subagentRows: TachoFrameRow[] = [],
  options: { chains?: SubagentChainFixture[]; now?: () => number } = {},
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
  const tachoFrames = vi.fn(memoryTachoFrames(SESSION_UUID, rows));
  const deps: RunTranscriptGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames,
    tachoSubagentFrames: memorySubagentFrames(subagentRows),
    ...(options.chains === undefined
      ? {}
      : { tachoChains: memorySubagentChains(options.chains) }),
    bodies: { getBody, getAssembly: () => Promise.resolve(null) },
    priceBook: () => Promise.resolve([]),
    now: options.now ?? (() => NOW),
  };
  return {
    transcript: createRunTranscriptGetHandler(deps),
    getBody,
    deps,
    tachoFrames,
  };
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

  it("carries a proxied request's effort ahead of the harness's report on the same frame (#3891)", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        effort: "medium",
        body: JSON.stringify({ request_effort: "low" }),
      }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.entries.map((entry) => entry.effort)).toEqual(["low"]);
  });

  // #4351: one model reply is one step, however many parts it arrives in. A
  // transcript writes one record per content block, and the host marks each
  // block after the first as a later sighting of its own source.
  it("steps: a reply in two parts is one model step that carries both parts", async () => {
    const part = (seq: number, text: string, attrs: Record<string, string>) =>
      tachoRow(seq, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        toolUseId: "",
        source: "transcript",
        attrs,
        body: JSON.stringify({ request_id: "req_parts" }),
        ...stored(text),
      });
    const { transcript } = harness([
      part(0, "Reading the config first.", {}),
      part(1, "The flag is off in prod.", {
        "oxagen.llm_call_duplicate_of": "transcript",
      }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.entries).toHaveLength(1);
    const [entry] = out.entries;
    expect(entry).toMatchObject({ node: "model", frames: 2 });
    expect(entry?.response?.text).toBe("Reading the config first.");
    expect(entry?.parts?.map((p) => p.text)).toEqual([
      "The flag is off in prod.",
    ]);
  });

  it("steps: a reply in one part carries no parts (negative)", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "llm_call",
        toolName: "",
        toolStatus: "",
        toolUseId: "",
        source: "transcript",
        attrs: {},
        body: JSON.stringify({ request_id: "req_one" }),
        ...stored("Done."),
      }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries[0]?.parts).toBeUndefined();
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

  it("names an entry's tool as its harness knows it, and keeps the recorded name as the subject", async () => {
    const { transcript } = harness([
      tachoRow(0, { kind: "tool_call", toolName: "claude_code__Bash" }),
      tachoRow(1, { kind: "tool_call", toolName: "Read@2.1.4" }),
      tachoRow(2, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        turnSeq: 1,
      }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.entries.map((e) => [e.subject, e.tool])).toEqual([
      ["claude_code__Bash", "Bash"],
      ["Read@2.1.4", "Read"],
      [null, null],
    ]);
  });

  it("says which decisions are the harness checking itself, so no reader keeps its own list of sources", async () => {
    const decided = (seq: number, source: string | null) =>
      tachoRow(seq, {
        kind: "policy_decision",
        toolName: "",
        toolStatus: "",
        policyDecision: "allow",
        body: JSON.stringify(source === null ? {} : { policy_source: source }),
      });
    const { transcript } = harness([
      decided(0, "bundle"),
      decided(1, "managed_settings"),
      decided(2, "harness"),
      decided(3, null),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(
      out.entries.map((e) => [e.decision?.source, e.decision?.harness]),
    ).toEqual([
      ["bundle", false],
      ["managed_settings", true],
      ["harness", true],
      [null, false],
    ]);
  });

  it("names the rules each decision fired, in order, and says no producer assessed taint (#3971)", async () => {
    const decided = (seq: number, body: Record<string, unknown>) =>
      tachoRow(seq, {
        kind: "policy_decision",
        toolName: "",
        toolStatus: "",
        policyDecision: "allow",
        body: JSON.stringify({ policy_source: "bundle", ...body }),
      });
    const { transcript } = harness([
      decided(0, {
        policy_rule: "Bash(git add:*) and Bash(git commit:*)",
        policy_rules: ["Bash(git add:*)", "Bash(git commit:*)"],
      }),
      // A decision no rule made names none.
      decided(1, {}),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(
      out.entries.map((e) => [e.decision?.rules, e.decision?.taint]),
    ).toEqual([
      [["Bash(git add:*)", "Bash(git commit:*)"], null],
      [[], null],
    ]);
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
        ...stored("Reading it."),
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

  it("reads the last page from the end and pages backward to the first entry", async () => {
    const { transcript } = harness(rows);
    const whole = await transcript(input({ zoom: "everything" }), ctx());
    // A read from the start answers no `before`: the reader holds the head.
    expect("before" in whole).toBe(false);
    const tail = await transcript(
      input({ zoom: "everything", limit: 3, from: "end" }),
      ctx(),
    );
    expect(tail.entries.map((e) => e.seq)).toEqual(["4", "5", "6"]);
    // A sealed run's tail holds its last entry, so nothing lies past it.
    expect(tail.cursor).toBeNull();
    expect(tail.before).not.toBeNull();
    const middle = await transcript(
      input({ zoom: "everything", limit: 3, before: tail.before as string }),
      ctx(),
    );
    // A backward page is the entries a forward read sends there, the prefix
    // sum from the run's start included.
    expect(middle.entries).toEqual(whole.entries.slice(1, 4));
    const head = await transcript(
      input({ zoom: "everything", limit: 3, before: middle.before as string }),
      ctx(),
    );
    expect(head.entries.map((e) => e.seq)).toEqual(["0"]);
    expect(head.before).toBeNull();
    // The counts and figures are the whole run's on every page.
    expect(tail.counts).toEqual(whole.counts);
    expect(tail.figures).toEqual(whole.figures);
    expect(tail.frameCursor).toBe(whole.frameCursor);
  });

  it("answers a live run's tail with the cursor a reader of every page holds", async () => {
    const { transcript } = harness(rows, {
      outcome: "running",
      sealedAt: null,
    });
    const whole = await transcript(input({ zoom: "everything" }), ctx());
    const tail = await transcript(
      input({ zoom: "everything", limit: 2, from: "end" }),
      ctx(),
    );
    expect(tail.entries.map((e) => e.seq)).toEqual(["5", "6"]);
    expect(decodeTranscriptCursor(tail.cursor as string)).toEqual(
      decodeTranscriptCursor(whole.cursor as string),
    );
    const caughtUp = await transcript(
      input({ zoom: "everything", after: tail.cursor as string }),
      ctx(),
    );
    expect(caughtUp.entries).toEqual([]);
  });

  it("refuses a before cursor it did not write, and a read at two positions (negative)", async () => {
    const { transcript } = harness(rows);
    const first = await transcript(
      input({ zoom: "everything", limit: 3 }),
      ctx(),
    );
    const tail = await transcript(
      input({ zoom: "everything", limit: 3, from: "end" }),
      ctx(),
    );
    await expect(
      transcript(input({ zoom: "everything", before: "not-ours" }), ctx()),
    ).rejects.toThrow();
    // A forward cursor is not a `before` cursor.
    await expect(
      transcript(
        input({ zoom: "everything", before: first.cursor as string }),
        ctx(),
      ),
    ).rejects.toThrow();
    await expect(
      transcript(
        input({
          zoom: "everything",
          from: "end",
          before: tail.before as string,
        }),
        ctx(),
      ),
    ).rejects.toThrow("conflicting_position");
    await expect(
      transcript(
        input({
          zoom: "everything",
          from: "start",
          after: first.cursor as string,
        }),
        ctx(),
      ),
    ).rejects.toThrow("conflicting_position");
    expect(decodeBeforeCursor(encodeBeforeCursor("42"))).toBe("42");
    expect(
      decodeBeforeCursor(encodeTranscriptCursor({ through: "1", high: "1" })),
    ).toBeNull();
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
      frameCursor: null,
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
        frames: { kinds: { policy: 0, recall: 0 }, policy: 0 },
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
    // A live read also carries the receipt watermark, which stands a settle
    // margin behind the server's clock (#4083).
    expect(decodeTranscriptCursor(out.cursor as string)).toMatchObject({
      through: out.entries.at(-1)?.seq,
      high: out.entries.at(-1)?.endSeq,
      received: { after: NOW - RECEIPT_SETTLE_MS, sent: 0 },
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
      received: { after: NOW - RECEIPT_SETTLE_MS, sent: 0 },
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
    // A ledger run has no receipt times, so its cursor carries no watermark.
    expect(
      decodeTranscriptCursor(first.cursor as string)?.received,
    ).toBeUndefined();
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

describe("planPageBefore", () => {
  const span = (open: number, end: number) => ({ open, end });

  it("sends the folds just ahead of a point and stands on the last of them", () => {
    const folds = [span(0, 0), span(1, 2), span(3, 3), span(4, 6)];
    expect(planPageBefore(folds, 4, 2)).toEqual({
      indexes: [2, 3],
      through: 3,
      high: 6,
      start: 2,
    });
    expect(planPageBefore(folds, 2, 5)).toEqual({
      indexes: [0, 1],
      through: 1,
      high: 2,
      start: 0,
    });
    expect(planPageBefore(folds, 0, 2)).toEqual({
      indexes: [],
      through: -1,
      high: -1,
      start: 0,
    });
    expect(planPageBefore([], 0, 2)).toEqual({
      indexes: [],
      through: -1,
      high: -1,
      start: 0,
    });
  });

  it("stands past a fold ahead of the page that ends after the page does (negative)", () => {
    // A Task call open across the page: its end is the reader's `high`, so a
    // read after the page sends it only once it grows again.
    const folds = [span(0, 9), span(1, 1), span(2, 2)];
    expect(planPageBefore(folds, 3, 2)).toEqual({
      indexes: [1, 2],
      through: 2,
      high: 9,
      start: 1,
    });
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
    // The fold that grew to 9 is left, and the plan says so.
    expect(first).toEqual({
      indexes: [1, 2],
      through: 2,
      high: 8,
      unsent: 1,
    });
    expect(planTranscriptPage(folds, first, 2)).toEqual({
      indexes: [0],
      through: 2,
      high: 9,
    });
  });

  describe("with a receipt (#4083)", () => {
    /** A fold whose latest frame the server received at `received`. */
    const at = (open: number, end: number, received: number | null) => ({
      open,
      end,
      received,
    });

    it("sends an entry before the cursor with a frame received after the receipt, oldest receipt first", () => {
      const folds = [100, 300, 200, 50].map((received, i) =>
        at(i, i, received),
      );
      const cursor = { through: 3, high: 3, received: { after: 150, sent: 0 } };
      expect(planTranscriptPage(folds, cursor, 10, 1000)).toEqual({
        indexes: [2, 1],
        through: 3,
        high: 3,
        received: { after: 1000, sent: 0 },
      });
    });

    it("sends grown entries first, then late ones, then new ones", () => {
      const folds = [
        at(0, 5, 500),
        at(1, 1, 400),
        at(2, 2, 100),
        at(6, 6, 100),
      ];
      const cursor = { through: 2, high: 4, received: { after: 200, sent: 0 } };
      expect(planTranscriptPage(folds, cursor, 10, 1000)).toEqual({
        indexes: [0, 1, 3],
        through: 3,
        high: 6,
        received: { after: 1000, sent: 0 },
      });
    });

    it("stops inside a batch that shares one receipt time, and the next page carries on after it", () => {
      const folds = [0, 1, 2].map((i) => at(i, i, 500));
      const cursor = { through: 2, high: 2, received: { after: 100, sent: 0 } };
      const first = planTranscriptPage(folds, cursor, 2, 1000);
      expect(first).toEqual({
        indexes: [0, 1],
        through: 2,
        high: 2,
        received: { after: 499, sent: 2 },
        unsent: 1,
      });
      expect(planTranscriptPage(folds, first, 2, 1000)).toEqual({
        indexes: [2],
        through: 2,
        high: 2,
        received: { after: 1000, sent: 0 },
      });
    });

    it("holds the receipt on a batch a full page ended on until the settle time passes it", () => {
      const folds = [at(0, 0, 500), at(1, 1, 500)];
      const cursor = { through: 1, high: 1, received: { after: 100, sent: 0 } };
      const first = planTranscriptPage(folds, cursor, 2, 400);
      expect(first).toEqual({
        indexes: [0, 1],
        through: 1,
        high: 1,
        received: { after: 499, sent: 2 },
      });
      // Nothing is sent twice in a row while the batch is inside the margin.
      const held = planTranscriptPage(folds, first, 2, 400);
      expect(held).toEqual({
        indexes: [],
        through: 1,
        high: 1,
        received: { after: 499, sent: 2 },
      });
      expect(planTranscriptPage(folds, held, 2, 600)).toEqual({
        indexes: [],
        through: 1,
        high: 1,
        received: { after: 600, sent: 0 },
      });
    });

    it("starts a receipt for a cursor that carries none, and sets none without a settle time (negative)", () => {
      const folds = [at(0, 0, 500), at(1, 1, 500)];
      // A cursor written before the receipt existed misses these frames once.
      expect(planTranscriptPage(folds, { through: 1, high: 1 }, 5, 1000)).toEqual(
        {
          indexes: [],
          through: 1,
          high: 1,
          received: { after: 1000, sent: 0 },
        },
      );
      const plain = planTranscriptPage(folds, null, 5);
      expect(plain).toEqual({ indexes: [0, 1], through: 1, high: 1 });
      expect(plain).not.toHaveProperty("received");
    });

    it("never reads an entry with no receipt time as late (negative)", () => {
      const folds = [at(0, 0, null), span(1, 1)];
      const cursor = { through: 1, high: 1, received: { after: 100, sent: 0 } };
      expect(planTranscriptPage(folds, cursor, 5, 1000)).toEqual({
        indexes: [],
        through: 1,
        high: 1,
        received: { after: 1000, sent: 0 },
      });
    });

    // Batch A1 (#4384) answered more late entries than one page holds by
    // rewinding the page to the first of them. This planner answers it with
    // the receipt's `sent` count instead, which "stops inside a batch that
    // shares one receipt time" covers. The two cases below are A1's, on
    // this planner.
    it("sends an entry that grew and was received late once, and a late entry past the cursor once, as a new one", () => {
      const grew = [at(0, 5, 500), at(1, 1, 100)];
      const cursor = { through: 1, high: 1, received: { after: 200, sent: 0 } };
      expect(planTranscriptPage(grew, cursor, 5, 1000)).toEqual({
        indexes: [0],
        through: 1,
        high: 5,
        received: { after: 1000, sent: 0 },
      });
      const past = [at(0, 0, 100), at(1, 1, 100), at(2, 2, 500)];
      expect(planTranscriptPage(past, cursor, 5, 1000)).toEqual({
        indexes: [2],
        through: 2,
        high: 2,
        received: { after: 1000, sent: 0 },
      });
    });

    it("sends grown entries before a late one, so the page cannot pass their ends (negative)", () => {
      // f0 and f1 grew to 10 and 11, f3 is late, and f4 opens at 12. A page
      // that sent f3 and f4 first would raise `high` to 12, past both grown
      // entries, and no later read would send them.
      const folds = [
        at(0, 10, 100),
        at(1, 11, 100),
        at(2, 2, 100),
        at(3, 3, 500),
        at(12, 12, 100),
      ];
      const cursor = { through: 3, high: 3, received: { after: 200, sent: 0 } };
      const first = planTranscriptPage(folds, cursor, 2, 1000);
      expect(first).toEqual({
        indexes: [0, 1],
        through: 3,
        high: 11,
        received: { after: 499, sent: 0 },
        unsent: 1,
      });
      const second = planTranscriptPage(folds, first, 2, 1000);
      expect(second).toEqual({
        indexes: [3, 4],
        through: 4,
        high: 12,
        received: { after: 1000, sent: 0 },
      });
      expect(planTranscriptPage(folds, second, 2, 1000)).toEqual({
        indexes: [],
        through: 4,
        high: 12,
        received: { after: 1000, sent: 0 },
      });
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
    // The point of the change: the entry is a fraction of the transport.
    // The run's counts and figures ride the first page whatever its entries
    // hold, so the entry is what is measured.
    expect(JSON.stringify(page.entries[0]).length).toBeLessThan(
      assembly?.wire.bytes ?? 0,
    );
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
    const rows = [
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
    ];
    // Each half on the page is read once, at either zoom. The prompt's read
    // for its words (`readWords`) is the read its half is answered from.
    for (const zoom of ["steps", "everything"] as const) {
      const { transcript, getBody } = harness(rows);
      await transcript(input({ zoom }), ctx());
      expect(getBody).toHaveBeenCalledTimes(2);
      expect(new Set(getBody.mock.calls.map(([, ref]) => ref)).size).toBe(2);
    }
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
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

  it("answers the frame cursor of the run's own last frame, so the stream opens past what the read held (A-06)", async () => {
    // The Run stream reads the run's own chain. Opened with no cursor it
    // sent every frame from the first, 200 to a read, before it reached
    // anything new. The transcript names the last frame it folded instead.
    const { transcript } = harness(root, undefined, children);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.frameCursor).toBe(encodeFrameCursor("4"));
  });

  it("passes over a subagent's frames spliced in after the run's last frame (negative)", async () => {
    // The root recorded up to the spawn, and the subagent's chain is spliced
    // in after it, so the read's last frame is the subagent's seq 3. That seq
    // names no frame on the run's own chain, and a stream opened there would
    // skip the root's frames 3 and 4 when they land.
    const { transcript } = harness(root.slice(0, 3), undefined, children);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries.at(-1)?.subagent?.sessionUuid).toBe(CHILD);
    expect(out.frameCursor).toBe(encodeFrameCursor("2"));
    expect(decodeFrameCursor(out.frameCursor ?? "")).toBe("2");
  });

  it("answers no frame cursor for a run that recorded no frame (negative)", async () => {
    const { transcript } = harness([]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries).toEqual([]);
    expect(out.frameCursor).toBeNull();
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
    // The longest cursor, two subagent keys at the largest seq and a receipt
    // at the largest time and count, fits the contract's 256-character bound.
    const longest = encodeTranscriptCursor({
      through: `${CHILD}:${"9".repeat(19)}`,
      high: `${CHILD}:${"9".repeat(19)}`,
      received: { after: 999_999_999_999_999, sent: 999_999_999_999_999 },
    });
    expect(longest.length).toBeLessThanOrEqual(256);
    expect(input({ zoom: "steps", after: longest }).after).toBe(longest);
    expect(decodeTranscriptCursor(longest)?.received).toEqual({
      after: 999_999_999_999_999,
      sent: 999_999_999_999_999,
    });
  });

  it("reads a cursor with a receipt, and still reads the two forms written before it (#4083)", () => {
    const received = { after: 1_789_117_265_000, sent: 0 };
    expect(
      decodeTranscriptCursor(
        encodeTranscriptCursor({ through: `${CHILD}:2`, high: "4", received }),
      ),
    ).toEqual({ through: `${CHILD}:2`, high: "4", received });
    // A cursor written before the receipt carries none, and reads as the
    // positions alone.
    const twoPart = Buffer.from("t:7,9", "utf8").toString("base64url");
    expect(decodeTranscriptCursor(twoPart)).toEqual({
      through: "7",
      high: "9",
    });
    expect(decodeTranscriptCursor(twoPart)).not.toHaveProperty("received");
    const onePart = Buffer.from("t:7", "utf8").toString("base64url");
    expect(decodeTranscriptCursor(onePart)).not.toHaveProperty("received");
    // Negative: a receipt this handler did not write is refused, not read as
    // no receipt.
    for (const text of [
      "t:7,9,1789117265000",
      "t:7,9,1789117265000,0123456789ab,1",
      "t:7,9,soon,0123456789ab",
      "t:7,9,1789117265000,0123456789AB",
      "t:7,9,1789117265000,0123",
      `t:7,9,${"9".repeat(16)},0123456789ab`,
    ]) {
      expect(
        decodeTranscriptCursor(Buffer.from(text, "utf8").toString("base64url")),
      ).toBeNull();
    }
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

describe("the transcript cursor's receipt and window (#4083, #3823)", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
  const raw = (text: string) => Buffer.from(text, "utf8").toString("base64url");

  it("reads back the receipt and the window start it wrote", () => {
    const both = {
      through: "12",
      high: `${CHILD}:3`,
      received: { after: 1_790_000_000_000, sent: 2 },
      from: { seq: "9", turn: 3, cost: -40, observed: true },
    };
    expect(decodeTranscriptCursor(encodeTranscriptCursor(both))).toEqual(both);
    // A window that starts before the run's first turn and first cost.
    const early = {
      through: "5",
      high: "5",
      from: { seq: "0", turn: null, cost: null, observed: false },
    };
    expect(decodeTranscriptCursor(encodeTranscriptCursor(early))).toEqual(
      early,
    );
    const receiptOnly = {
      through: "5",
      high: "6",
      received: { after: 0, sent: 0 },
    };
    expect(
      decodeTranscriptCursor(encodeTranscriptCursor(receiptOnly)),
    ).toEqual(receiptOnly);
  });

  it("writes a cursor with neither in the two-field form", () => {
    expect(
      encodeTranscriptCursor({
        through: "42",
        high: "44",
        received: null,
        from: null,
      }),
    ).toBe(raw("t:42,44"));
  });

  it.each([
    "t:1,2,3,4,5",
    "t:1,2,,,4,1,,2",
    "t:1,2,abc,0,,,,",
    "t:1,2,100,,,,,",
    "t:1,2,,,,3,,",
    "t:1,2,,,4,1,1.5,0",
    "t:1,2,,,4,-1,,0",
    "t:7,9,soon,0123456789ab",
    "t:7,9,1789117265000,0123456789AB",
    "t:7,9,1789117265000,0123",
    `t:7,9,${"9".repeat(16)},0123456789ab`,
  ])("refuses the malformed cursor %s (negative)", (text) => {
    expect(decodeTranscriptCursor(raw(text))).toBeNull();
  });

  it("reads a cursor from the seen receipt as a receipt the settle margin earlier (#4384)", () => {
    // A Run page open across the deploy holds a cursor the seen receipt
    // wrote: two frames, the latest receipt time its read held, and a digest.
    const seen = decodeTranscriptCursor(
      raw(`t:7,${CHILD}:3,1789117265000,0123456789ab`),
    );
    expect(seen).toEqual({
      through: "7",
      high: `${CHILD}:3`,
      received: { after: 1_789_117_265_000 - RECEIPT_SETTLE_MS, sent: 0 },
    });
    // It names no window, so the next read reads the whole run.
    expect(seen).not.toHaveProperty("from");
    // A receipt time inside the margin reads as the epoch.
    expect(
      decodeTranscriptCursor(raw("t:7,9,5000,0123456789ab"))?.received,
    ).toEqual({ after: 0, sent: 0 });
  });

  it("leaves out a window start the contract's cap cannot carry, and keeps the receipt", () => {
    const key = `${CHILD}:${"9".repeat(19)}`;
    const received = { after: 999_999_999_999_999, sent: 999_999_999_999_999 };
    // With the window start this cursor is 270 characters, past the 256 the
    // contract allows.
    const longest = encodeTranscriptCursor({
      through: key,
      high: key,
      received,
      from: {
        seq: "9".repeat(19),
        turn: 999_999_999_999_999,
        cost: -999_999_999_999_999,
        observed: true,
      },
    });
    expect(longest.length).toBeLessThanOrEqual(256);
    expect(decodeTranscriptCursor(longest)).toEqual({
      through: key,
      high: key,
      received,
    });
    // A cursor a real run writes keeps its window start.
    const real = {
      through: `${CHILD}:412`,
      high: `${CHILD}:415`,
      received: { after: 1_790_000_000_000, sent: 3 },
      from: { seq: "1200", turn: 14, cost: 2_500_000, observed: true },
    };
    expect(decodeTranscriptCursor(encodeTranscriptCursor(real))).toEqual(real);
  });
});

describe("get_run_transcript and a late subagent frame (#4083)", () => {
  // Batch A1 (#4384) tested these cases against its `seen` receipt. Its
  // idle-read case is the four-read case below, which sends the frame again
  // while it is inside the settle margin (`RECEIPT_SETTLE_MS`). Its
  // unreadable-frame case is the two settle-margin cases, one of them a
  // frame readable 30 seconds after its stamp, and its paging case is the
  // planner's "stops inside a batch that shares one receipt time".
  const A = "0192d4a8-7c1e-7a00-8000-00000000a0a0";
  const B = "0192d4a8-7c1e-7a00-8000-00000000b0b0";
  const bare = { toolName: "", toolStatus: "" };
  const live = { outcome: "running", sealedAt: null };
  /**
   * When the server received every frame the run held at its first read:
   * before the settle margin of that read, so no read counts them as late.
   */
  const early = receipt(NOW - 2 * RECEIPT_SETTLE_MS);
  const onChain =
    (sessionUuid: string, subagentId: string, spawnToolUseId: string) =>
    (seq: number, over: Partial<TachoFrameRow>): TachoFrameRow =>
      tachoRow(seq, {
        sessionUuid,
        rootSessionUuid: SESSION_UUID,
        parentSessionUuid: SESSION_UUID,
        subagentId,
        subagentType: "Explore",
        spawnToolUseId,
        receivedAt: early,
        ...over,
      });
  const onA = onChain(A, "agent-1", "toolu_A");
  const onB = onChain(B, "agent-2", "toolu_B");

  /** A live run in its second turn, with two subagents at work in it. */
  function twoSubagents() {
    const root = [
      tachoRow(0, { kind: "turn_start", ...bare, turnSeq: 1 }),
      tachoRow(1, {
        kind: "llm_call",
        ...bare,
        model: "haiku",
        provider: "anthropic",
        costUsdMicros: 10,
        turnSeq: 1,
      }),
      tachoRow(2, { kind: "turn_end", ...bare, turnSeq: 1 }),
      tachoRow(3, { kind: "turn_start", ...bare, turnSeq: 2 }),
      tachoRow(4, {
        kind: "tool_requested",
        toolName: "Task",
        toolUseId: "toolu_A",
        turnSeq: 2,
      }),
      tachoRow(5, {
        kind: "subagent_start",
        ...bare,
        toolUseId: "toolu_A",
        turnSeq: 2,
      }),
      tachoRow(6, {
        kind: "tool_requested",
        toolName: "Task",
        toolUseId: "toolu_B",
        turnSeq: 2,
      }),
      tachoRow(7, {
        kind: "subagent_start",
        ...bare,
        toolUseId: "toolu_B",
        turnSeq: 2,
      }),
    ].map((row) => ({ ...row, receivedAt: early }));
    const children = [
      onA(0, { kind: "turn_start", ...bare }),
      onB(0, { kind: "turn_start", ...bare }),
      onB(1, {
        kind: "tool_requested",
        toolName: "Grep",
        toolUseId: "toolu_g",
      }),
    ];
    const chains = [
      subagentChain({
        sessionUuid: A,
        rootSessionUuid: SESSION_UUID,
        subagentId: "agent-1",
        spawnToolUseId: "toolu_A",
        seqCount: 2,
      }),
      subagentChain({
        sessionUuid: B,
        rootSessionUuid: SESSION_UUID,
        subagentId: "agent-2",
        spawnToolUseId: "toolu_B",
        seqCount: 2,
      }),
    ];
    return { root, children, chains };
  }

  it.each([
    { read: "a window of the run", windowed: true },
    { read: "the whole run", windowed: false },
  ])(
    "sends a subagent frame that landed before the cursor on the next read, reading $read",
    async ({ windowed }) => {
      const { root, children, chains } = twoSubagents();
      let clock = NOW;
      const { transcript, tachoFrames } = harness(root, live, children, {
        ...(windowed ? { chains } : {}),
        now: () => clock,
      });
      const first = await transcript(input({ zoom: "everything" }), ctx());
      // The run's eight frames and the subagents' three.
      expect(first.entries).toHaveLength(11);
      expect(decodeTranscriptCursor(first.cursor as string)).toEqual({
        through: `${B}:1`,
        high: `${B}:1`,
        received: { after: NOW - RECEIPT_SETTLE_MS, sent: 0 },
        from: { seq: "3", turn: 2, cost: 10, observed: false },
      });

      // Subagent A records a model call. In fold order it sits inside A's
      // chain, before B's frames, so before the cursor: a cursor of fold
      // positions alone never sent it until the page was reloaded.
      children.push(
        onA(1, {
          kind: "llm_call",
          ...bare,
          costUsdMicros: 300,
          receivedAt: receipt(NOW + 1_000),
        }),
      );
      tachoFrames.mockClear();
      clock = NOW + 5_000;
      const second = await transcript(
        input({ zoom: "everything", after: first.cursor as string }),
        ctx(),
      );
      expect(
        second.entries.map((e) => [
          e.seq,
          e.subagent?.sessionUuid,
          e.turn,
          e.cumulativeCost?.micros,
        ]),
      ).toEqual([["1", A, 2, "310"]]);
      // A window reads the run's own chain from the second turn's first
      // frame, not from the run's first frame.
      expect(tachoFrames.mock.calls[0]?.[0].afterSeq).toBe(windowed ? 2 : -1);
      expect(decodeTranscriptCursor(second.cursor as string)).toMatchObject({
        through: `${B}:1`,
        high: `${B}:1`,
        received: { after: NOW + 5_000 - RECEIPT_SETTLE_MS, sent: 0 },
      });

      // The frame is still inside that receipt's settle margin, so the next
      // read sends it once more. That read's clock has passed the frame by
      // the margin, so its receipt passes the frame.
      clock = NOW + 2_000 + RECEIPT_SETTLE_MS;
      const third = await transcript(
        input({ zoom: "everything", after: second.cursor as string }),
        ctx(),
      );
      expect(
        third.entries.map((e) => [e.seq, e.subagent?.sessionUuid]),
      ).toEqual([["1", A]]);
      expect(decodeTranscriptCursor(third.cursor as string)?.received).toEqual(
        { after: NOW + 2_000, sent: 0 },
      );
      // Once the receipt has passed it, it is not sent again.
      const fourth = await transcript(
        input({ zoom: "everything", after: third.cursor as string }),
        ctx(),
      );
      expect(fourth.entries).toEqual([]);
    },
  );

  it("keeps a cursor on a sealed run while late entries remain past the limit", async () => {
    const { root, children } = twoSubagents();
    const reading = harness(root, live, children);
    const first = await reading.transcript(
      input({ zoom: "everything" }),
      ctx(),
    );
    // Subagent A records two model calls, both before the cursor in fold
    // order, and the run seals.
    for (const seq of [1, 2]) {
      children.push(
        onA(seq, {
          kind: "llm_call",
          ...bare,
          costUsdMicros: 300,
          receivedAt: receipt(NOW + 1_000),
        }),
      );
    }
    const { transcript } = harness(root, undefined, children, {
      now: () => NOW + 5_000,
    });
    const second = await transcript(
      input({ zoom: "everything", limit: 1, after: first.cursor as string }),
      ctx(),
    );
    expect(second.entries.map((e) => [e.seq, e.subagent?.sessionUuid])).toEqual(
      [["1", A]],
    );
    // The page holds every fold, but not every change: a null cursor here
    // lost the second call (Codex review on #4421).
    expect(second.cursor).not.toBeNull();
    const third = await transcript(
      input({ zoom: "everything", limit: 1, after: second.cursor as string }),
      ctx(),
    );
    expect(third.entries.map((e) => [e.seq, e.subagent?.sessionUuid])).toEqual(
      [["2", A]],
    );
    // Negative control: with nothing left, the sealed run answers no cursor.
    expect(third.cursor).toBeNull();
  });

  it("sends a frame received inside the settle margin that the read before it missed", async () => {
    // Ingest stamps a batch's receipt time before ClickHouse can return the
    // batch, so a read can miss a frame the server received before the read.
    const { root, children, chains } = twoSubagents();
    let clock = NOW;
    const { transcript } = harness(root, live, children, {
      chains,
      now: () => clock,
    });
    const first = await transcript(input({ zoom: "everything" }), ctx());
    const cursor = decodeTranscriptCursor(first.cursor as string);
    expect(cursor?.received).toEqual({
      after: NOW - RECEIPT_SETTLE_MS,
      sent: 0,
    });
    // Received 3 seconds before the first read, and readable only after it.
    children.push(
      onA(1, {
        kind: "llm_call",
        ...bare,
        costUsdMicros: 300,
        receivedAt: receipt(NOW - 3_000),
      }),
    );
    clock = NOW + 1_000;
    const second = await transcript(
      input({ zoom: "everything", after: first.cursor as string }),
      ctx(),
    );
    expect(second.entries.map((e) => [e.seq, e.subagent?.sessionUuid])).toEqual(
      [["1", A]],
    );
    // Negative control: a receipt at the first read's own time, with no
    // margin, never sends the frame.
    const unsettled = encodeTranscriptCursor({
      through: `${B}:1`,
      high: `${B}:1`,
      received: { after: NOW, sent: 0 },
      from: cursor?.from ?? null,
    });
    const missed = await transcript(
      input({ zoom: "everything", after: unsettled }),
      ctx(),
    );
    expect(missed.entries).toEqual([]);
  });

  it("sends a frame that became readable 30 seconds after its receipt time (#4384)", async () => {
    // Ingest stamps a batch's receipt time before it awaits the ClickHouse
    // insert, and the insert can take the client's 30-second default
    // timeout. The margin this batch first shipped with was 10 seconds, so
    // an idle read after such an insert never sent the frame.
    const { root, children, chains } = twoSubagents();
    let clock = NOW;
    const { transcript } = harness(root, live, children, {
      chains,
      now: () => clock,
    });
    const first = await transcript(input({ zoom: "everything" }), ctx());
    const cursor = decodeTranscriptCursor(first.cursor as string);
    // Stamped 30 seconds before the first read, and readable only after it.
    children.push(
      onA(1, {
        kind: "llm_call",
        ...bare,
        costUsdMicros: 300,
        receivedAt: receipt(NOW - 30_000),
      }),
    );
    clock = NOW + 5_000;
    const second = await transcript(
      input({ zoom: "everything", after: first.cursor as string }),
      ctx(),
    );
    expect(second.entries.map((e) => [e.seq, e.subagent?.sessionUuid])).toEqual(
      [["1", A]],
    );
    // Negative control: the receipt a 10-second margin wrote lies past the
    // frame, and the read from it never sends it.
    const tenSeconds = encodeTranscriptCursor({
      through: `${B}:1`,
      high: `${B}:1`,
      received: { after: NOW - 10_000, sent: 0 },
      from: cursor?.from ?? null,
    });
    const missed = await transcript(
      input({ zoom: "everything", after: tenSeconds }),
      ctx(),
    );
    expect(missed.entries).toEqual([]);
  });

  it("reads a cursor written before the receipt, and answers one that carries it", async () => {
    const { root, children } = twoSubagents();
    let clock = NOW;
    const { transcript } = harness(root, live, children, { now: () => clock });
    const first = await transcript(input({ zoom: "everything" }), ctx());
    const decoded = decodeTranscriptCursor(first.cursor as string);
    const legacy = encodeTranscriptCursor({
      through: decoded?.through as string,
      high: decoded?.high as string,
    });
    children.push(
      onA(1, {
        kind: "llm_call",
        ...bare,
        costUsdMicros: 300,
        receivedAt: receipt(NOW + 1_000),
      }),
    );
    clock = NOW + 5_000;
    const second = await transcript(
      input({ zoom: "everything", after: legacy }),
      ctx(),
    );
    // With no receipt, the read sends what the positions say, and the
    // cursor it answers carries the receipt from then on.
    expect(second.entries).toEqual([]);
    expect(decodeTranscriptCursor(second.cursor as string)?.received).toEqual(
      { after: NOW + 5_000 - RECEIPT_SETTLE_MS, sent: 0 },
    );
  });

  it("reads the whole run when a subagent that began before the window records a frame", async () => {
    // Subagent A was spawned in the first turn and runs in the background
    // after that turn ended. The cursor's window opens at the second turn.
    const root = [
      tachoRow(0, { kind: "turn_start", ...bare, turnSeq: 1 }),
      tachoRow(1, {
        kind: "tool_requested",
        toolName: "Task",
        toolUseId: "toolu_A",
        turnSeq: 1,
      }),
      tachoRow(2, {
        kind: "subagent_start",
        ...bare,
        toolUseId: "toolu_A",
        turnSeq: 1,
      }),
      tachoRow(3, {
        kind: "tool_call",
        toolName: "Task",
        toolUseId: "toolu_A",
        turnSeq: 1,
      }),
      tachoRow(4, { kind: "turn_end", ...bare, turnSeq: 1 }),
      tachoRow(5, { kind: "turn_start", ...bare, turnSeq: 2 }),
      tachoRow(6, {
        kind: "llm_call",
        ...bare,
        model: "haiku",
        provider: "anthropic",
        costUsdMicros: 20,
        turnSeq: 2,
      }),
      tachoRow(7, { kind: "turn_end", ...bare, turnSeq: 2 }),
    ].map((row) => ({ ...row, receivedAt: early }));
    const children = [
      onA(0, { kind: "turn_start", ...bare }),
      onA(1, { kind: "tool_call", toolName: "Grep", toolUseId: "toolu_g" }),
    ];
    const chain = subagentChain({
      sessionUuid: A,
      rootSessionUuid: SESSION_UUID,
      spawnToolUseId: "toolu_A",
      seqCount: 2,
      startedAt: new Date("2026-09-11T09:00:02.000Z"),
      lastEventAt: new Date(NOW - 2 * RECEIPT_SETTLE_MS),
    });
    let clock = NOW;
    const { transcript, tachoFrames } = harness(root, live, children, {
      chains: [chain],
      now: () => clock,
    });
    const first = await transcript(input({ zoom: "everything" }), ctx());
    expect(decodeTranscriptCursor(first.cursor as string)?.from).toEqual({
      seq: "5",
      turn: 2,
      cost: null,
      observed: false,
    });
    tachoFrames.mockClear();
    clock = NOW + 5_000;
    const idle = await transcript(
      input({ zoom: "everything", after: first.cursor as string }),
      ctx(),
    );
    expect(idle.entries).toEqual([]);
    // The chain has not moved, so the window from the second turn answers.
    expect(tachoFrames.mock.calls.map(([args]) => args.afterSeq)).toEqual([4]);

    children.push(
      onA(2, {
        kind: "tool_call",
        toolName: "Read",
        toolUseId: "toolu_r",
        receivedAt: receipt(NOW + 1_000),
      }),
    );
    chain.lastEventAt = new Date(NOW + 1_000);
    chain.seqCount = 3;
    tachoFrames.mockClear();
    clock = NOW + 6_000;
    const moved = await transcript(
      input({ zoom: "everything", after: idle.cursor as string }),
      ctx(),
    );
    // The window cannot place the chain's new frame, so the read tries the
    // window and then reads the whole run.
    expect(tachoFrames.mock.calls.map(([args]) => args.afterSeq)).toEqual([
      4, -1,
    ]);
    expect(moved.entries.map((e) => [e.seq, e.subagent?.sessionUuid])).toEqual(
      [["2", A]],
    );
  });
});

describe("get_run_transcript reads a window from the cursor (#3823, D6)", () => {
  const bare = { toolName: "", toolStatus: "" };
  type Transcript = ReturnType<typeof harness>["transcript"];
  type Entries = Awaited<ReturnType<Transcript>>["entries"];

  /** Every entry a reader is sent, `limit` at a time, from the first page on. */
  async function everyPage(
    transcript: Transcript,
    zoom: "everything" | "steps" | "turns",
    limit: number,
  ): Promise<Entries> {
    const entries: Entries = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const out = await transcript(
        input({ zoom, limit, ...(after === undefined ? {} : { after }) }),
        ctx(),
      );
      entries.push(...out.entries);
      if (out.cursor === null) break;
      after = out.cursor;
    }
    return entries;
  }

  it.each([
    ["everything", 1],
    ["everything", 2],
    ["everything", 3],
    ["steps", 1],
    ["steps", 2],
    ["steps", 3],
    ["turns", 1],
    ["turns", 2],
  ] as const)(
    "pages %s %i at a time to the same entries as reads of the whole run",
    async (zoom, limit) => {
      const windowed = harness(rows, undefined, [], { chains: [] });
      const whole = harness(rows);
      expect(await everyPage(windowed.transcript, zoom, limit)).toEqual(
        await everyPage(whole.transcript, zoom, limit),
      );
      // Some page read the run from a frame past its first.
      expect(
        windowed.tachoFrames.mock.calls.some(([args]) => args.afterSeq > -1),
      ).toBe(true);
    },
  );

  it("searches the whole run from a cursor that names a window", async () => {
    const { transcript, tachoFrames } = harness(rows, undefined, [], {
      chains: [],
    });
    const first = await transcript(
      input({ zoom: "everything", limit: 3 }),
      ctx(),
    );
    expect(decodeTranscriptCursor(first.cursor as string)?.from).toEqual({
      seq: "1",
      turn: 1,
      cost: null,
      observed: false,
    });
    tachoFrames.mockClear();
    await transcript(
      input({
        zoom: "everything",
        limit: 3,
        query: "README",
        after: first.cursor as string,
      }),
      ctx(),
    );
    expect(tachoFrames.mock.calls.map(([args]) => args.afterSeq)).toEqual([-1]);
    // Negative control: the same page without a query reads the window.
    tachoFrames.mockClear();
    await transcript(
      input({ zoom: "everything", limit: 3, after: first.cursor as string }),
      ctx(),
    );
    expect(tachoFrames.mock.calls.map(([args]) => args.afterSeq)).toEqual([0]);
  });

  it("pages past frame 10,000 of a long run", async () => {
    // 120 turns of 100 frames: a model call and 98 tool calls after each
    // turn's start, 12,000 frames in all. The first read holds the first
    // 10,000, and a read that began at seq 0 every page never got past them.
    const long = Array.from({ length: 120 }, (_, k) => [
      tachoRow(k * 100, { kind: "turn_start", ...bare, turnSeq: k + 1 }),
      tachoRow(k * 100 + 1, {
        kind: "llm_call",
        ...bare,
        model: "haiku",
        provider: "anthropic",
        costUsdMicros: 1,
        turnSeq: k + 1,
      }),
      ...Array.from({ length: 98 }, (_, t) =>
        tachoRow(k * 100 + 2 + t, { turnSeq: k + 1 }),
      ),
    ]).flat();
    const { transcript, tachoFrames } = harness(
      long,
      { seqCount: long.length },
      [],
      { chains: [] },
    );
    const first = await transcript(input({ zoom: "turns" }), ctx());
    expect(first.entries).toHaveLength(100);
    expect(first.complete).toBe(false);
    expect(first.counts).toBeDefined();
    expect(decodeTranscriptCursor(first.cursor as string)).toEqual({
      through: "9900",
      high: "9999",
      received: { after: NOW - RECEIPT_SETTLE_MS, sent: 0 },
      from: { seq: "9900", turn: 100, cost: 99, observed: false },
    });

    tachoFrames.mockClear();
    const second = await transcript(
      input({ zoom: "turns", after: first.cursor as string }),
      ctx(),
    );
    expect(tachoFrames.mock.calls[0]?.[0].afterSeq).toBe(9899);
    expect(second.entries.map((e) => e.seq)).toEqual(
      Array.from({ length: 20 }, (_, k) => String((100 + k) * 100)),
    );
    // Turns and cost carry on from the run's count, not the window's.
    expect(second.entries[0]?.turn).toBe(101);
    expect(second.entries[0]?.cumulativeCost?.micros).toBe("101");
    expect(second.entries.at(-1)?.turn).toBe(120);
    expect(second.complete).toBe(true);
    expect(second.cursor).toBeNull();
    // Counts ride only the first read.
    expect(second.counts).toBeUndefined();
  }, 30_000);
});


describe("unsentFolds", () => {
  it("keeps a fold at or before the cursor that holds a frame received after the receipt (#4083)", () => {
    const fold = (open: number, received: number | null) => ({
      span: { open, end: open },
      received,
    });
    const folds = [fold(0, 100), fold(1, 500), fold(2, null), fold(3, 100)];
    const cursor = { throughAt: 2, highAt: 2 };
    const opens = (kept: readonly { span: { open: number } }[]) =>
      kept.map((f) => f.span.open);
    expect(opens(unsentFolds(folds, cursor))).toEqual([3]);
    expect(
      opens(
        unsentFolds(folds, { ...cursor, receivedAfter: 200 }, (f) => f.received),
      ),
    ).toEqual([1, 3]);
    // Negative: without a receipt on the cursor, a receipt time alone sends
    // nothing again.
    expect(opens(unsentFolds(folds, cursor, (f) => f.received))).toEqual([3]);
    expect(unsentFolds(folds, null)).toBe(folds);
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
      // The prompt's copy repeats the operator's words: nothing new to show.
      ["4", "reply", true, null, "0"],
      ["5", "control", true, null, null],
    ]);
    const call = out.entries[1];
    expect(call).toMatchObject({
      subject: "Bash",
      tool: "Bash",
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
    // The prompt's copy draws no row, so no count holds it.
    expect(all.counts).toMatchObject({ entries: 2, errors: 0, policy: 1 });
    expect(all.counts?.kinds).toMatchObject({
      prompt: 1,
      tools: 1,
      policy: 1,
      responses: 0,
    });
    // The first page counts the whole run. A later page carries no counts,
    // and the reader keeps the first read's (#3823, D6).
    const first = await transcript(input({ zoom: "steps", limit: 2 }), ctx());
    expect(first.counts).toEqual(all.counts);
    const later = await transcript(
      input({ zoom: "steps", limit: 2, after: first.cursor ?? undefined }),
      ctx(),
    );
    expect(later.entries.map((e) => e.key)).toEqual(["4", "5"]);
    expect(later.counts).toBeUndefined();
    expect(later.figures).toBeUndefined();
  });

  it("carries the frames' policy and recall counts at every zoom, as everything counts them", async () => {
    const { transcript } = harness(governed);
    const everything = await transcript(input({ zoom: "everything" }), ctx());
    const atEverything = everything.counts;
    const frames = {
      kinds: {
        policy: atEverything?.kinds.policy,
        recall: atEverything?.kinds.recall,
      },
      policy: atEverything?.policy,
    };
    expect(frames).toEqual({ kinds: { policy: 1, recall: 0 }, policy: 1 });
    expect(atEverything?.frames).toEqual(frames);
    for (const zoom of ["steps", "turns"] as const) {
      const out = await transcript(
        input({ zoom, kinds: ["tools"], limit: 1 }),
        ctx(),
      );
      expect(out.counts?.frames).toEqual(frames);
    }
  });

  it("reads a turn's closing message that repeats the model's streamed reply as an echo, and counts it nowhere", async () => {
    // The model's reply is kept as the stream it arrived in and the turn's
    // closing message as plain words: two digests, the same words.
    const rows = [
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("Ship it."),
      }),
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        turnSeq: 1,
        ...stored(modelStream(["Shipped ", "it."]), "text/event-stream"),
      }),
      tachoRow(2, {
        kind: "turn_end",
        ...blank,
        turnSeq: 1,
        ...stored("Shipped it.\n"),
      }),
    ];
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries.map((e) => [e.key, e.node, e.quiet, e.echoOf])).toEqual([
      ["0", "prompt", false, null],
      ["1", "model", false, null],
      ["2", "reply", true, "1"],
    ]);
    expect(out.counts).toMatchObject({ entries: 2 });
    expect(out.counts?.kinds).toMatchObject({ prompt: 1, responses: 1 });
  });

  it("reads no words at everything, so an echo there is left as the fold said (negative)", async () => {
    // `everything` lists frames for the Actions, Policy and Context tabs,
    // none of which a word turns quiet. Reading every prompt and reply of the
    // run there would cost the bodies and settle nothing any of them draws.
    // Only the prompts' words are read, for `figures.prompts`.
    const rows = [
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("Ship it."),
      }),
      tachoRow(1, {
        kind: "turn_end",
        ...blank,
        turnSeq: 1,
        ...stored("Ship it."),
      }),
    ];
    const { transcript, getBody } = harness(rows);
    const out = await transcript(
      input({ zoom: "everything", limit: 1 }),
      ctx(),
    );
    // Only the prompt's body is read, once: for its words, for the figures,
    // and for the page's one half from that same read. The reply is never
    // read.
    expect(getBody.mock.calls.map(([, ref]) => ref)).toEqual([
      stored("Ship it.").bytesRef,
    ]);
    const next = await transcript(
      input({ zoom: "everything", after: out.cursor ?? undefined }),
      ctx(),
    );
    expect(next.entries.map((e) => [e.key, e.quiet, e.echoOf])).toEqual([
      ["1", false, null],
    ]);
    expect(out.counts?.kinds).toMatchObject({ prompt: 1, responses: 1 });
    expect(out.counts?.entries).toBe(2);
  });

  it("keeps a closing message that says something new, and reads a blank prompt as showing nothing (negative)", async () => {
    const { transcript } = harness([
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("  \n"),
      }),
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        turnSeq: 1,
        ...stored(modelStream(["Shipped it."]), "text/event-stream"),
      }),
      tachoRow(2, {
        kind: "turn_end",
        ...blank,
        turnSeq: 1,
        ...stored("Shipped it, and tagged v2."),
      }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries.map((e) => [e.key, e.quiet, e.echoOf])).toEqual([
      ["0", true, null],
      ["1", false, null],
      ["2", false, null],
    ]);
    expect(out.counts).toMatchObject({ entries: 2 });
    expect(out.counts?.kinds).toMatchObject({ prompt: 0, responses: 2 });
  });

  it("reads each entry's words from the half a reader is shown, within its bound", async () => {
    const { deps, getBody } = harness([]);
    const frames = [
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("Ship it."),
      }),
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        turnSeq: 1,
        ...stored(modelStream(["Shipped."]), "text/event-stream"),
      }),
      tachoRow(2, { kind: "turn_end", ...blank, turnSeq: 1 }),
      // A closing message kept as a model stream shows no words.
      tachoRow(3, {
        kind: "turn_end",
        ...blank,
        turnSeq: 1,
        ...stored(modelStream(["Also streamed."]), "text/event-stream"),
      }),
    ].map((row) => tachoFrameOf(row));
    const folds = stepFolds(frames);
    const words = await readWords(deps.bodies, SCOPE, folds);
    expect(folds.map((fold) => words.get(fold))).toEqual([
      wordsDigest("Ship it."),
      wordsDigest("Shipped."),
      null,
      null,
    ]);
    // The turn end that kept no body cost no read.
    expect(getBody).toHaveBeenCalledTimes(3);

    getBody.mockClear();
    const bounded = await readWords(deps.bodies, SCOPE, folds, { halfMax: 1 });
    expect(getBody).toHaveBeenCalledTimes(1);
    expect(folds.map((fold) => bounded.has(fold))).toEqual([
      true,
      false,
      true,
      false,
    ]);
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
        {
          id: "rec_2",
          kind: "fact",
          force: "may",
          tokens: 900,
          outcome: "cut",
          reason: "budget",
        },
      ],
      bundle_version: 41,
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
    // Every item comes with its outcome, so no reader parses the manifest
    // again to find what was cut (ADR-182).
    expect(out.entries[0]?.recall).toEqual({
      unit: "items",
      count: 1,
      tokens: 120,
      cut: 1,
      items: [
        {
          kind: "rule",
          label: "rec_1",
          tokens: 120,
          outcome: "included",
          reason: null,
          supersededBy: null,
          force: null,
        },
        {
          kind: "fact",
          label: "rec_2",
          tokens: 900,
          outcome: "cut",
          reason: "budget",
          supersededBy: null,
          force: "may",
        },
      ],
      bundleVersion: 41,
      body: "listed",
    });
    expect(out.entries[1]?.recall).toEqual({
      unit: "frames",
      count: null,
      tokens: null,
      cut: null,
      items: [],
      bundleVersion: null,
      body: "unreadable",
    });
  });

  it("says a recall frame that kept no body is unretained, and reads nothing for it (negative)", async () => {
    const { transcript, getBody } = harness([
      tachoRow(0, { kind: "steering.manifest", ...blank }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries[0]?.recall?.body).toBe("unretained");
    expect(out.entries[0]?.recall?.items).toEqual([]);
    expect(getBody).not.toHaveBeenCalled();
  });

  it("reads a recall's body once per read, for its recall and never as a half", async () => {
    const manifest = stored(
      JSON.stringify({ included: 1, items: [{ id: "rec_1", tokens: 3 }] }),
    );
    const { transcript, getBody } = harness([
      tachoRow(0, { kind: "steering.manifest", ...blank, ...manifest }),
    ]);
    for (const zoom of ["steps", "everything"] as const) {
      getBody.mockClear();
      const out = await transcript(input({ zoom }), ctx());
      expect(out.entries[0]?.recall?.count).toBe(1);
      // A recall is no call and no turn boundary, so it has no half to read.
      expect(out.entries[0]?.request).toBeNull();
      expect(out.entries[0]?.response).toBeNull();
      expect(
        getBody.mock.calls.filter(([, ref]) => ref === manifest.bytesRef),
      ).toHaveLength(1);
    }
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
    expect(out.entries[0]?.recall?.body).toBe("unreadable");
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
      family: "create",
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

  it("claims a call by name at every zoom and on every page alike, even where the step kept no key", async () => {
    const rows = [
      tachoRow(0, { kind: "turn_start", ...blank, turnSeq: 1 }),
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        turnSeq: 1,
        model: "claude-opus-5",
        provider: "anthropic",
        ...stored(modelStream(["Writing it."]), "text/event-stream"),
      }),
      // The harness sealed the call without its id, so only its name joins it.
      tachoRow(2, {
        kind: "tool_call",
        toolName: "Write",
        toolUseId: "",
        turnSeq: 1,
      }),
    ];
    const stepKeys = async (zoom: "steps" | "turns" | "everything") => {
      const out = await harness(rows).transcript(input({ zoom }), ctx());
      return out.entries.flatMap((entry) =>
        [entry.request, entry.response].flatMap(
          (half) =>
            half?.assembly?.blocks.flatMap((block) =>
              block.kind === "tool_use" ? [block.stepKey] : [],
            ) ?? [],
        ),
      );
    };
    expect(await stepKeys("steps")).toEqual(["2"]);
    // A turn's span holds its calls, so the turn's reply is claimed from the
    // model step that made it, not from the turn.
    expect(await stepKeys("turns")).toEqual(["2"]);
    expect(await stepKeys("everything")).toEqual(["2"]);
    // A page that holds only the reply claims what a whole read claims.
    const page = await harness(rows).transcript(
      input({ zoom: "steps", limit: 2 }),
      ctx(),
    );
    const block = page.entries[1]?.response?.assembly?.blocks[1];
    expect(block).toMatchObject({ kind: "tool_use", stepKey: "2" });
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
        family: "read",
        tool: "Read",
      },
      {
        ...use(null),
        stepKey: null,
        result: null,
        family: "read",
        tool: "Read",
      },
      { ...base, kind: "text", text: "x", truncated: false },
    ]);
  });

  it("names a called tool as its harness knows it, without the gateway's prefix or a version", () => {
    const out = withToolUseFacts(
      half([
        { ...use(null), name: "claude_code__Bash" },
        { ...use(null), name: "Read@2.1.4" },
        { ...use(null), name: "mcp__github__create_release" },
      ]),
      (uses) => uses.map(() => null),
      new Map(),
    );
    expect(
      out?.assembly?.blocks.map((block) =>
        block.kind === "tool_use" ? [block.name, block.tool] : null,
      ),
    ).toEqual([
      ["claude_code__Bash", "Bash"],
      ["Read@2.1.4", "Read"],
      ["mcp__github__create_release", "mcp__github__create_release"],
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
    // A prompt of only whitespace shows no words, so it is quiet
    // (`markWords`), draws no row, and the search skips it: it is neither
    // matched nor counted as unsearched.
    tachoRow(6, {
      kind: "turn_start",
      ...blank,
      turnSeq: 2,
      ...stored("  \n\t"),
    }),
  ];

  it("finds the query in any half, ignoring case, and says where it matched", async () => {
    const { transcript } = harness(run);
    const out = await transcript(
      input({ zoom: "steps", query: "  RETRY " }),
      ctx(),
    );
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    // The Grep call matched on its target, so its halves were not read.
    expect(out.entries.map((e) => [e.key, e.matches])).toEqual([
      ["1", ["target"]],
      ["3", ["response"]],
      ["5", ["response"]],
    ]);
    // The Read call's digest-only request. The prompt that no longer hashes
    // is quiet, so it is not searched and not counted.
    expect(out.search).toEqual({ query: "retry", matched: 3, unsearched: 1 });
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
    // The Read call's two halves were digests only. The Grep call matched
    // on the entry, so its halves were not needed and are not counted. A
    // prompt or reply kept as a digest is no half of its entry, so it is
    // not counted either.
    expect(out.search).toMatchObject({ matched: 1, unsearched: 2 });
  });

  it("narrows by the chips first, then the query, and pages the matches on the cursor", async () => {
    const { transcript, getBody } = harness(run);
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
    getBody.mockClear();
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
    // A later page searches only what it can still send: the reply. The
    // second prompt, whose body no longer hashes, is quiet and not searched.
    expect(later.search).toEqual({ query: "retry", matched: 1, unsearched: 0 });
    // The words of the whole run were settled by the first page's word read,
    // so this read reads one body for its words: the first it holds, to learn
    // that its key still opens bodies. The reply is read once, by the
    // search, and the page's half is answered from that read.
    const reply = run[5]?.bytesRef;
    expect(getBody.mock.calls.map(([, ref]) => ref)).toEqual([
      run[0]?.bytesRef,
      reply,
    ]);
  });

  it("sends a match that grew behind the cursor once, and never moves the cursor back to it", async () => {
    const live = { outcome: "running", sealedAt: null };
    const grep = (over: Record<string, unknown>) => ({
      toolName: "Grep",
      toolStatus: "",
      toolUseId: "tu_g",
      turnSeq: 1,
      ...over,
    });
    const before = [
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("Find it."),
      }),
      tachoRow(1, {
        kind: "tool_requested",
        ...grep({}),
        ...stored('{"pattern":"x"}'),
      }),
      tachoRow(2, {
        kind: "tool_requested",
        toolName: "Read",
        toolStatus: "",
        toolUseId: "tu_r",
        turnSeq: 1,
        ...stored('{"path":"retry.ts"}'),
      }),
    ];
    const first = await harness(before, live).transcript(
      input({ zoom: "steps", query: "retry" }),
      ctx(),
    );
    expect(first.entries.map((e) => e.key)).toEqual(["2"]);
    // The Grep call, before the cursor, gets its result, which holds the query.
    const grown = [
      ...before,
      tachoRow(3, { kind: "tool_call", ...grep({}), ...stored("retry.ts:1") }),
    ];
    const { transcript } = harness(grown, live);
    const second = await transcript(
      input({
        zoom: "steps",
        query: "retry",
        after: first.cursor ?? undefined,
      }),
      ctx(),
    );
    expect(second.entries.map((e) => e.key)).toEqual(["1"]);
    // Nothing new landed, so nothing is sent again, the Read call included.
    const third = await transcript(
      input({
        zoom: "steps",
        query: "retry",
        after: second.cursor ?? undefined,
      }),
      ctx(),
    );
    expect(third.entries).toEqual([]);
  });

  it("answers an empty page for a query nothing holds, with the search and figures (negative)", async () => {
    const { transcript } = harness(run);
    const out = await transcript(
      input({ zoom: "steps", query: "nowhere" }),
      ctx(),
    );
    expect(out.entries).toEqual([]);
    expect(out.search).toEqual({ query: "nowhere", matched: 0, unsearched: 1 });
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
    // The second prompt no longer hashes to its digest, so it shows no
    // words and the prompt chip leaves it out; so does the figure, at every
    // zoom (P3-4 of the ADR-182 re-review).
    expect(steps.counts?.kinds.prompt).toBe(1);
    expect(steps.figures).toEqual({
      steps: { model: 0, tool: 2 },
      prompts: 1,
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

describe("get_run_transcript reads each body once per process (ADR-182)", () => {
  const blank = { toolName: "", toolStatus: "", toolUseId: "" };
  /** One turn: the operator's prompt, a streamed model reply, a closing message. */
  const turn = (n: number) => [
    tachoRow(n * 3, {
      kind: "turn_start",
      ...blank,
      turnSeq: n + 1,
      ...stored(`Prompt ${n}.`),
    }),
    tachoRow(n * 3 + 1, {
      kind: "llm_call",
      ...blank,
      model: "claude-opus-5",
      provider: "anthropic",
      turnSeq: n + 1,
      ...stored(modelStream([`Streamed ${n}.`]), "text/event-stream"),
    }),
    tachoRow(n * 3 + 2, {
      kind: "turn_end",
      ...blank,
      turnSeq: n + 1,
      ...stored(`Closing ${n}.`),
    }),
  ];
  /** Every body reference the entries' halves name. */
  const pageRefs = (page: { entries: TranscriptEntryRefs[] }) =>
    new Set(
      page.entries.flatMap((entry) =>
        [entry.request?.bytesRef, entry.response?.bytesRef].filter(
          (ref): ref is string => typeof ref === "string",
        ),
      ),
    );
  type TranscriptEntryRefs = {
    request: { bytesRef: string | null } | null;
    response: { bytesRef: string | null } | null;
  };

  it("reads no body outside its page on a second cursor read of a sealed run", async () => {
    const rows = [0, 1, 2, 3].flatMap(turn);
    const { transcript, getBody } = harness(rows);
    const first = await transcript(input({ zoom: "steps", limit: 3 }), ctx());
    // The first read reads the whole run's words and its page's halves, and
    // no body twice: a half it read for words is not read again for the page.
    const firstRefs = getBody.mock.calls.map(([, ref]) => ref);
    const twice = firstRefs.filter((ref, i) => firstRefs.indexOf(ref) !== i);
    expect(twice).toEqual([]);
    for (const ref of pageRefs(first)) expect(firstRefs).toContain(ref);

    getBody.mockClear();
    const second = await transcript(
      input({ zoom: "steps", limit: 3, after: first.cursor ?? undefined }),
      ctx(),
    );
    expect(second.entries.map((e) => e.key)).toEqual(["3", "4", "5"]);
    const read = getBody.mock.calls.map(([, ref]) => ref);
    const onPage = pageRefs(second);
    // One body is read for words: the first the cache holds, to learn that
    // its key still opens bodies.
    const probe = stored("Prompt 0.").bytesRef;
    expect(read.filter((ref) => !onPage.has(ref))).toEqual([probe]);
    // Each half on the page is read once.
    expect(read).toHaveLength(onPage.size + 1);
    expect(new Set(read)).toEqual(new Set([probe, ...onPage]));
    // What the read settled is what a read with no cache settles.
    const fresh = await harness(rows).transcript(
      input({ zoom: "steps", limit: 3, after: first.cursor ?? undefined }),
      ctx(),
    );
    expect(second).toEqual(fresh);
  });

  it("reads only the new bodies on a live run's tail read", async () => {
    const rows = [0, 1].flatMap(turn);
    const { transcript, getBody } = harness(rows, {
      outcome: "running",
      sealedAt: null,
    });
    const head = await transcript(input({ zoom: "steps" }), ctx());
    rows.push(...turn(2));
    getBody.mockClear();
    const tail = await transcript(
      input({ zoom: "steps", after: head.cursor ?? undefined }),
      ctx(),
    );
    expect(tail.entries.map((e) => e.key)).toEqual(["6", "7", "8"]);
    const read = new Set(getBody.mock.calls.map(([, ref]) => ref));
    const landed = new Set(turn(2).map((row) => row.bytesRef as string));
    expect([...read].filter((ref) => !landed.has(ref))).toEqual([]);
  });

  // Finding P2-1 of the ADR-182 third review: the cache held whole texts, and
  // every half a page or a search read went into it, so a page of large tool
  // bodies pushed out the words `markWords` needs.
  it("keeps the words through a page of large tool bodies, a whole-run read and a search", async () => {
    const big = (n: number) => `${String(n)}:${"output ".repeat(30_000)}`;
    const withTools = (n: number) => {
      const [prompt, model, closing] = turn(n);
      const tools = [0, 1, 2].map((t) =>
        tachoRow(100 + n * 10 + t, {
          kind: "tool_call",
          toolName: "Read",
          toolUseId: `tu_${String(n)}_${String(t)}`,
          turnSeq: n + 1,
          ...stored(big(n * 10 + t)),
        }),
      );
      return [prompt, model, ...tools, closing].map((row, i) => ({
        ...(row as TachoFrameRow),
        seq: n * 10 + i,
      }));
    };
    const rows = [0, 1].flatMap(withTools);
    const { deps, getBody } = harness(rows);
    // Room for exactly the run's word halves: a prompt, the model step
    // before the reply, and the reply, for each of the two turns.
    const cache = createWordsCache({ maxEntries: 6, failureTtlMs: 60_000 });
    const transcript = createRunTranscriptGetHandler({ ...deps, words: cache });
    await transcript(input({ zoom: "steps" }), ctx());
    expect(cache.size()).toBe(6);
    await transcript(input({ zoom: "everything" }), ctx());
    await transcript(input({ zoom: "steps", query: "absent" }), ctx());
    expect(cache.size()).toBe(6);

    // A later read reads one body for its words, the first the cache holds,
    // to learn that its key still opens bodies. That body is also the page's
    // one half, and a read reads each body once (finding P3-2 of the ADR-182
    // fifth review).
    getBody.mockClear();
    const page = await transcript(input({ zoom: "steps", limit: 1 }), ctx());
    expect(page.entries.map((e) => e.key)).toEqual(["0"]);
    expect(getBody.mock.calls.map(([, ref]) => ref)).toEqual([
      stored("Prompt 0.").bytesRef,
    ]);
  });

  // Finding P2-2 of the ADR-182 third review: a half was answered from the
  // cache without asking the store, so a body erasure crypto-shredded kept
  // showing its text for as long as the process lived.
  it("shows no text of a body once the store stops returning it (negative)", async () => {
    const rows = [0].flatMap(turn);
    const { transcript } = harness(rows);
    await transcript(input({ zoom: "steps" }), ctx());
    await transcript(input({ zoom: "everything" }), ctx());
    const erased = stored("Prompt 0.").bytesRef;
    const kept = objects.get(erased);
    objects.delete(erased);
    try {
      for (const zoom of ["steps", "everything", "turns"] as const) {
        const out = await transcript(input({ zoom, text: "full" }), ctx());
        const texts = out.entries.flatMap((e) => [
          e.request?.text ?? null,
          e.response?.text ?? null,
        ]);
        expect(texts.filter((t) => t?.includes("Prompt 0.") === true)).toEqual(
          [],
        );
      }
      const found = await transcript(
        input({ zoom: "steps", query: "Prompt 0" }),
        ctx(),
      );
      expect(found.entries).toEqual([]);
    } finally {
      if (kept !== undefined) objects.set(erased, kept);
    }
  });

  // Finding P3-2 of the ADR-182 third review: a cached half did not count
  // against the bound, so each page of a long run settled more entries than
  // the one before, and its counts moved from page to page.
  it("the first page counts the whole run, and later pages carry no counts", async () => {
    // 1,001 turns of a prompt and a reply: 2,002 word halves. The last
    // prompt is blank, and falls past the 2,000 a read settles.
    const turns = 1_001;
    const rows = Array.from({ length: turns }, (_, n) => [
      tachoRow(n * 2, {
        kind: "turn_start",
        ...blank,
        turnSeq: n + 1,
        ...stored(n === turns - 1 ? "  \n" : `Ask ${String(n)}.`),
      }),
      tachoRow(n * 2 + 1, {
        kind: "turn_end",
        ...blank,
        turnSeq: n + 1,
        ...stored(`Answer ${String(n)}.`),
      }),
    ]).flat();
    const { transcript } = harness(rows);
    const pages: Awaited<ReturnType<typeof transcript>>[] = [];
    let after: string | undefined;
    do {
      const page = await transcript(input({ zoom: "steps", after }), ctx());
      pages.push(page);
      after = page.cursor ?? undefined;
    } while (after !== undefined);
    expect(pages.length).toBeGreaterThan(2);
    const first = pages[0];
    // Counts and figures ride only the read from the run's first frame
    // (#3823, D6). The reader keeps them across every later page.
    expect(first?.counts).toBeDefined();
    expect(first?.figures).toBeDefined();
    for (const page of pages.slice(1)) {
      expect(page.counts).toBeUndefined();
      expect(page.figures).toBeUndefined();
    }
    // The blank prompt past the bound keeps what the fold said, so the chip
    // counts it.
    expect(first?.counts?.kinds?.prompt).toBe(turns);
    const last = pages
      .flatMap((p) => p.entries)
      .find((e) => e.key === String((turns - 1) * 2));
    expect(last?.quiet).toBe(false);
    // What a read settles is what a read with no cache settles.
    const fresh = await harness(rows).transcript(
      input({ zoom: "steps", after: pages[0]?.cursor ?? undefined }),
      ctx(),
    );
    expect(fresh.entries).toEqual(pages[1]?.entries);
  });

  // #4334: the bound was counted over the run's frames in the order read,
  // and a subagent chain is spliced in where it was spawned. A chain that
  // landed after an earlier read took the slots of the run's own last
  // settled halves, and those entries turned back to what the fold said.
  it("keeps what a read settled when a subagent chain lands late, ahead of the bound (negative)", async () => {
    // 1,001 turns of a prompt and a reply on the run's own chain: 2,002 word
    // halves, two past the 2,000 a chain settles. Turn 999's prompt is
    // blank, and its halves are the last two inside the bound.
    const turns = 1_001;
    const task = "toolu_late_task";
    const rows: TachoFrameRow[] = [];
    let seq = 0;
    for (let n = 0; n < turns; n += 1) {
      rows.push(
        tachoRow(seq++, {
          kind: "turn_start",
          ...blank,
          turnSeq: n + 1,
          ...stored(n === 999 ? "  \n" : `Late ask ${String(n)}.`),
        }),
      );
      if (n === 0) {
        // The first turn spawns a subagent.
        rows.push(
          tachoRow(seq++, {
            kind: "tool_requested",
            toolName: "Task",
            toolUseId: task,
            turnSeq: 1,
          }),
          tachoRow(seq++, {
            kind: "subagent_start",
            ...blank,
            toolUseId: task,
            turnSeq: 1,
          }),
          tachoRow(seq++, {
            kind: "tool_call",
            toolName: "Task",
            toolUseId: task,
            turnSeq: 1,
          }),
        );
      }
      rows.push(
        tachoRow(seq++, {
          kind: "turn_end",
          ...blank,
          turnSeq: n + 1,
          ...stored(`Late answer ${String(n)}.`),
        }),
      );
    }
    // The subagent's chain, which arrives after the first read. Its two
    // replies are blank, so they draw no row and count nowhere once read.
    const child = (n: number, text: string): TachoFrameRow =>
      tachoRow(n, {
        kind: "turn_end",
        ...blank,
        sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d1",
        rootSessionUuid: SESSION_UUID,
        parentSessionUuid: SESSION_UUID,
        subagentId: "agent-late",
        subagentType: "Explore",
        spawnToolUseId: task,
        ...stored(text),
      });
    const early = await harness(rows).transcript(
      input({ zoom: "steps" }),
      ctx(),
    );
    const late = await harness(rows, undefined, [
      child(0, " \t"),
      child(1, "\n\n"),
    ]).transcript(input({ zoom: "steps" }), ctx());
    // The chain landed: its entries are in the run.
    expect(late.entries.some((e) => e.subagent !== undefined)).toBe(true);
    // Turn 999's blank prompt is settled both times, so no count moves.
    expect(early.counts?.kinds?.prompt).toBe(turns - 1);
    expect(late.counts).toEqual(early.counts);
    expect(early.figures?.prompts).toBe(turns - 1);
    expect(late.figures?.prompts).toBe(early.figures?.prompts);
  });

  // #4334: at `turns` and `everything` only the prompts were read, so the
  // bound reached 2,000 prompts there and fewer at `steps`.
  it("counts the operator's prompts the same at every zoom on a run past the bound (negative)", async () => {
    // 1,001 turns of a prompt and a reply. The last prompt is blank, and at
    // `steps` it falls past the 2,000 halves a chain settles, so it counts.
    const turns = 1_001;
    const rows = Array.from({ length: turns }, (_, n) => [
      tachoRow(n * 2, {
        kind: "turn_start",
        ...blank,
        turnSeq: n + 1,
        ...stored(n === turns - 1 ? "  \n" : `Ask ${String(n)}.`),
      }),
      tachoRow(n * 2 + 1, {
        kind: "turn_end",
        ...blank,
        turnSeq: n + 1,
        ...stored(`Answer ${String(n)}.`),
      }),
    ]).flat();
    for (const zoom of ["steps", "turns", "everything"] as const) {
      // A process that has read nothing, so no zoom leans on another's read.
      const out = await harness(rows).transcript(input({ zoom }), ctx());
      expect({ zoom, prompts: out.figures?.prompts }).toEqual({
        zoom,
        prompts: turns,
      });
    }
  });
});

// Finding P3-1 of the ADR-182 third review: a body that could not be read
// was read again on every read, up to 2,000 a read, so every body of an
// erased run was read again each time the Run page polled.
describe("readWords remembers a body it cannot read for good", () => {
  const prompt = (text: string, seq = 0) =>
    tachoFrameOf(
      tachoRow(seq, {
        kind: "turn_start",
        toolName: "",
        toolStatus: "",
        toolUseId: "",
        turnSeq: 1,
        ...stored(text),
      }),
    );
  const bodiesThat = (fail: () => Error) => {
    const getBody = vi.fn(() => Promise.reject(fail()));
    return {
      getBody,
      bodies: { getBody, getAssembly: () => Promise.resolve(null) },
    };
  };

  it("reads a body the store says is gone once, until the failure expires", async () => {
    let at = 0;
    const cache = createWordsCache(
      { maxEntries: 10, failureTtlMs: 1_000 },
      () => at,
    );
    const folds = stepFolds([prompt("Gone.")]);
    const { bodies, getBody } = bodiesThat(
      () => new StorageNotFoundError("gone"),
    );
    const once = await readWords(bodies, SCOPE, folds, { cache });
    const again = await readWords(bodies, SCOPE, folds, { cache });
    expect(getBody).toHaveBeenCalledTimes(1);
    // A body that could not be read answers nothing, so the prompt keeps
    // what the fold said rather than reading as blank.
    expect(once.size).toBe(0);
    expect(again.size).toBe(0);
    at = 1_000;
    await readWords(bodies, SCOPE, folds, { cache });
    expect(getBody).toHaveBeenCalledTimes(2);
  });

  it("remembers a body that no longer hashes to its digest", async () => {
    const cache = createWordsCache();
    const { deps, getBody } = harness([]);
    const forged = stepFolds([
      tachoFrameOf(
        tachoRow(0, {
          kind: "turn_start",
          toolName: "",
          toolStatus: "",
          toolUseId: "",
          turnSeq: 1,
          contentDigest: `sha256:${"7".repeat(64)}`,
          bytesRef: stored("Forged.").bytesRef,
        }),
      ),
    ]);
    await readWords(deps.bodies, SCOPE, forged, { cache });
    await readWords(deps.bodies, SCOPE, forged, { cache });
    expect(getBody).toHaveBeenCalledTimes(1);
  });

  it("reads no body under a key the read already found gone, and remembers each as unreadable", async () => {
    const cache = createWordsCache();
    const folds = stepFolds([prompt("Erased.")]);
    const { bodies, getBody } = bodiesThat(() => new Error("not asked"));
    const keys = { opened: new Set<string>(), gone: new Set(["k"]) };
    const words = await readWords(bodies, SCOPE, folds, { cache, keys });
    expect(getBody).not.toHaveBeenCalled();
    expect(words.size).toBe(0);
    const [fold] = folds;
    const frame = fold === undefined ? null : fold.request;
    expect(frame === null ? null : cache.get(SCOPE, frame)).toBe("unreadable");
  });

  // Finding P2-A of the ADR-182 fifth review: the body read again to learn
  // its key is itself one this read finds does not open. Its kept digest no
  // longer answers, as a read with no cache would not settle it.
  it("answers no kept digest of a body this read found does not open", async () => {
    const cache = createWordsCache();
    const folds = stepFolds([prompt(" \n ")]);
    const [fold] = folds;
    const frame = fold === undefined ? null : fold.request;
    if (frame === null) throw new Error("no prompt half");
    cache.set(SCOPE, frame, { stream: false, words: null });
    const { bodies, getBody } = bodiesThat(
      () => new BodyUnopenableError("k", { cause: new Error("tag") }),
    );
    const words = await readWords(bodies, SCOPE, folds, { cache });
    expect(getBody).toHaveBeenCalledTimes(1);
    expect(words.size).toBe(0);
    expect(cache.get(SCOPE, frame)).toBe("unreadable");
  });

  it("reads a body again after a failure that may pass (negative)", async () => {
    const cache = createWordsCache();
    const folds = stepFolds([prompt("Flaky.")]);
    const { bodies, getBody } = bodiesThat(() => new Error("timeout"));
    await readWords(bodies, SCOPE, folds, { cache });
    await readWords(bodies, SCOPE, folds, { cache });
    expect(getBody).toHaveBeenCalledTimes(2);
  });
});

// #4334: the Run page reads `steps` and `everything` at once. On a cold words
// cache, both reads opened every body they shared.
describe("readWords beside another read of the same run", () => {
  const blank = { toolName: "", toolStatus: "", toolUseId: "" };
  /** `turns` turns of a prompt and a streamed model step, each body its own. */
  const frames = (turns: number, tag: string): RunFrame[] =>
    Array.from({ length: turns }, (_, n) => [
      tachoRow(n * 2, {
        kind: "turn_start",
        ...blank,
        turnSeq: n + 1,
        ...stored(`${tag} ask ${String(n)}.`),
      }),
      tachoRow(n * 2 + 1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        turnSeq: n + 1,
        ...stored(
          modelStream([`${tag} said ${String(n)}.`]),
          "text/event-stream",
        ),
      }),
    ])
      .flat()
      .map((row) => tachoFrameOf(row));
  const refsOf = (folds: readonly TranscriptFold[]) =>
    folds.map((fold) =>
      fold.node === "prompt"
        ? fold.request?.body.bodyRef
        : fold.response?.body.bodyRef,
    );

  it("opens each body once when two reads of the same halves meet a cold cache (negative)", async () => {
    const { deps, getBody } = harness([]);
    const folds = stepFolds(frames(12, "Same"));
    const cache = createWordsCache();
    const [one, two] = await Promise.all([
      readWords(deps.bodies, SCOPE, folds, { cache }),
      readWords(deps.bodies, SCOPE, folds, { cache }),
    ]);
    expect([...two.entries()]).toEqual([...one.entries()]);
    expect(one.size).toBe(24);
    const opened = getBody.mock.calls.map(([, ref]) => ref);
    expect(opened.sort()).toEqual(refsOf(folds).sort());
  });

  it("opens each body once when a prompts-only read runs beside a read of every half (negative)", async () => {
    // The prompts-only read runs ahead, and has read a prompt by the time
    // the other reaches it. The other finds its words in the cache rather
    // than opening the body again.
    const { deps, getBody } = harness([]);
    const folds = stepFolds(frames(12, "Beside"));
    const cache = createWordsCache();
    const [prompts, every] = await Promise.all([
      readWords(deps.bodies, SCOPE, folds, {
        cache,
        only: (fold) => fold.node === "prompt",
      }),
      readWords(deps.bodies, SCOPE, folds, { cache }),
    ]);
    expect(prompts.size).toBe(12);
    expect(every.size).toBe(24);
    for (const [fold, words] of prompts) expect(every.get(fold)).toBe(words);
    const opened = getBody.mock.calls.map(([, ref]) => ref);
    expect(opened.sort()).toEqual(refsOf(folds).sort());
  });

  it("reads the halves the bound holds when asked for fewer, and counts the rest in their places", async () => {
    const { deps, getBody } = harness([]);
    // A prompt, its model step, then a second prompt: with room for two,
    // the second prompt is past the bound whatever `only` asks for.
    const folds = stepFolds(frames(2, "Only")).slice(0, 3);
    const answer = await readWords(deps.bodies, SCOPE, folds, {
      halfMax: 2,
      only: (fold) => fold.node === "prompt",
    });
    expect(folds.map((fold) => answer.has(fold))).toEqual([
      true,
      false,
      false,
    ]);
    expect(getBody).toHaveBeenCalledTimes(1);
  });

  it("gives each chain its own bound, so a subagent chain spliced in ahead takes no slot from the run's own chain (negative)", async () => {
    const { deps } = harness([]);
    const root = [
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("Find the flaky test."),
      }),
      tachoRow(1, {
        kind: "tool_requested",
        toolName: "Task",
        toolUseId: "toolu_bound",
        turnSeq: 1,
      }),
      tachoRow(2, {
        kind: "subagent_start",
        ...blank,
        toolUseId: "toolu_bound",
        turnSeq: 1,
      }),
      tachoRow(3, {
        kind: "tool_call",
        toolName: "Task",
        toolUseId: "toolu_bound",
        turnSeq: 1,
      }),
      tachoRow(4, {
        kind: "turn_end",
        ...blank,
        turnSeq: 1,
        ...stored("It was the clock."),
      }),
    ].map((row) => tachoFrameOf(row));
    const child = tachoFrameOf(
      tachoRow(0, {
        kind: "turn_end",
        ...blank,
        sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c1d2",
        rootSessionUuid: SESSION_UUID,
        parentSessionUuid: SESSION_UUID,
        subagentId: "agent-bound",
        subagentType: "Explore",
        spawnToolUseId: "toolu_bound",
        ...stored("The test reads the wall clock."),
      }),
    );
    // The keys of the prompts and replies a read with room for two halves a
    // chain settles.
    const settled = async (frames: RunFrame[]) => {
      const folds = stepFolds(frames).filter(
        (fold) => fold.node === "prompt" || fold.node === "reply",
      );
      const words = await readWords(deps.bodies, SCOPE, folds, {
        halfMax: 2,
      });
      return folds
        .filter((fold) => words.has(fold))
        .map((fold) => fold.key);
    };
    const before = await settled(root);
    expect(before).toEqual(["0", "4"]);
    // The child's reply is spliced in after the spawn, ahead of the run's
    // reply, and settles within its own chain's bound.
    const after = await settled(spliceSubagentChains(root, [child]));
    expect(after).toEqual([
      "0",
      "0192d4a8-7c1e-7a00-8000-00000000c1d2:0",
      "4",
    ]);
  });

  // `markWords` asks for the model step before a reply after the reply
  // itself. The bound takes halves in the run's order, so where it falls
  // between the two, the earlier model step keeps its place (#4334).
  it("takes the halves in the run's order when the bound falls between a model step and its reply", async () => {
    const { deps, getBody } = harness([]);
    const frames = [
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("Ship it."),
      }),
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        turnSeq: 1,
        ...stored(modelStream(["Shipped it."]), "text/event-stream"),
      }),
      tachoRow(2, {
        kind: "turn_end",
        ...blank,
        turnSeq: 1,
        ...stored("Shipped it, and tagged v2."),
      }),
    ].map((row) => tachoFrameOf(row));
    const [prompt, model, reply] = stepFolds(frames);
    if (!prompt || !model || !reply) throw new Error("no folds");
    expect([prompt.node, model.node, reply.node]).toEqual([
      "prompt",
      "model",
      "reply",
    ]);
    const asked = [prompt, reply, model];
    const answer = await readWords(deps.bodies, SCOPE, asked, { halfMax: 2 });
    expect([prompt, model, reply].map((fold) => answer.has(fold))).toEqual([
      true,
      true,
      false,
    ]);
    expect(getBody).toHaveBeenCalledTimes(2);
  });

  // `only` narrows the answer as well as the reads. A half with no kept body
  // that `only` leaves out is not answered as showing no words, so a
  // prompts-only read leaves the fold's own word on every other entry.
  it("leaves a half with no kept body out of the answer when `only` leaves it out (negative)", async () => {
    const { deps, getBody } = harness([]);
    const frames = [
      tachoRow(0, {
        kind: "turn_start",
        ...blank,
        turnSeq: 1,
        ...stored("Ship it."),
      }),
      // A model step the recorder kept no body for.
      tachoRow(1, {
        kind: "llm_call",
        ...blank,
        model: "claude-opus-5",
        provider: "anthropic",
        turnSeq: 1,
      }),
    ].map((row) => tachoFrameOf(row));
    const [prompt, model] = stepFolds(frames);
    if (!prompt || !model) throw new Error("no folds");
    expect([prompt.node, model.node]).toEqual(["prompt", "model"]);
    expect(model.response?.body.bodyRef ?? null).toBeNull();
    const prompts = await readWords(deps.bodies, SCOPE, [prompt, model], {
      only: (fold) => fold.node === "prompt",
    });
    expect(prompts.has(prompt)).toBe(true);
    expect(prompts.has(model)).toBe(false);
    // Asked for every half, the same half answers as showing no words.
    const every = await readWords(deps.bodies, SCOPE, [prompt, model]);
    expect(every.has(model)).toBe(true);
    expect(every.get(model)).toBeNull();
    // The prompt's body, once for each read. The model step has none to open.
    expect(getBody).toHaveBeenCalledTimes(2);
  });

  // A read that tests a key learns the key's state for itself. Were the test
  // shared, the read that waited on it would learn nothing, and would answer
  // its kept digests after erasure.
  it("tests the key in each of two reads at once, so neither answers a kept digest after erasure (negative)", async () => {
    const { deps, getBody } = harness([]);
    const folds = stepFolds(frames(2, "Erased"));
    const cache = createWordsCache();
    const warm = await readWords(deps.bodies, SCOPE, folds, { cache });
    expect(warm.size).toBe(4);
    getBody.mockClear();
    getBody.mockImplementation(() =>
      Promise.reject(
        new BodyKeyGoneError("k", {
          cause: Object.assign(new Error("pending deletion"), {
            name: "KMSInvalidStateException",
          }),
        }),
      ),
    );
    const [one, two] = await Promise.all([
      readWords(deps.bodies, SCOPE, folds, { cache }),
      readWords(deps.bodies, SCOPE, folds, { cache }),
    ]);
    expect(one.size).toBe(0);
    expect(two.size).toBe(0);
    // One body for each read: its own test of the key.
    expect(getBody).toHaveBeenCalledTimes(2);
  });

  /** A store whose KEK erasure has destroyed: KMS refuses the key itself. */
  const erasedKey = () =>
    Promise.reject(
      new BodyKeyGoneError("k", {
        cause: Object.assign(new Error("pending deletion"), {
          name: "KMSInvalidStateException",
        }),
      }),
    );

  // Review round 1 on #4382: a read that waited on another's read of a body
  // learned nothing about the body's key, since the shared read wrote what
  // it learned into the other read's keys. So after erasure the read that
  // waited answered the digests it kept under that key.
  it("learns an erased key from the read it waits on, so neither of two reads at once answers a kept digest (negative)", async () => {
    const { deps, getBody } = harness([]);
    const folds = stepFolds(frames(2, "Joined"));
    const prompts = folds.filter((fold) => fold.node === "prompt");
    const cache = createWordsCache();
    // Only the prompts are kept. Each full read below then holds the prompts
    // as kept digests and misses the model steps, all under one key.
    const warm = await readWords(deps.bodies, SCOPE, folds, {
      cache,
      only: (fold) => fold.node === "prompt",
    });
    expect(warm.size).toBe(2);
    getBody.mockClear();
    getBody.mockImplementation(erasedKey);
    const [one, two] = await Promise.all([
      readWords(deps.bodies, SCOPE, folds, { cache }),
      readWords(deps.bodies, SCOPE, folds, { cache }),
    ]);
    for (const answer of [one, two]) {
      expect(prompts.filter((fold) => answer.has(fold))).toEqual([]);
      expect(answer.size).toBe(0);
    }
    // Each model step's body is opened once, by the read that got there
    // first. The other read waits on those reads and learns the key there.
    expect(getBody).toHaveBeenCalledTimes(2);
  });

  // Review round 1 on #4382: a read that found a body it missed already
  // failed by another read took that as the key's test, and learned nothing
  // about the key from it.
  it("tests the key itself when a body it missed was failed by another read meanwhile (negative)", async () => {
    const { deps, getBody } = harness([]);
    const [prompt, model] = stepFolds(frames(1, "Beaten"));
    if (!prompt || !model) throw new Error("no folds");
    const modelRef = model.response?.body.bodyRef;
    const kept = createWordsCache();
    await readWords(deps.bodies, SCOPE, [prompt], { cache: kept });
    // The model step's body misses when the read looks first, and reads as
    // failed by the time the read would open it.
    let asked = 0;
    const cache: WordsCache = {
      ...kept,
      get: (scope, frame) => {
        if (frame.body.bodyRef !== modelRef) return kept.get(scope, frame);
        asked += 1;
        return asked === 1 ? undefined : UNREADABLE;
      },
    };
    getBody.mockClear();
    getBody.mockImplementation(erasedKey);
    const words = await readWords(deps.bodies, SCOPE, [prompt, model], {
      cache,
    });
    expect(words.has(prompt)).toBe(false);
    expect(words.has(model)).toBe(false);
    // The prompt's body, read again to learn the key.
    expect(getBody.mock.calls.map(([, ref]) => ref)).toEqual([
      prompt.request?.body.bodyRef,
    ]);
  });

  // Review round 2 on #4382: no test covered the case where the only body a
  // read opens under a key fails before KMS answers. That read learns
  // nothing about the key, and a kept digest leans on it, so the test of the
  // key must still run once the reads are done.
  it("tests the key after the reads when the only body it read under the key failed before KMS answered (negative)", async () => {
    const { deps, getBody } = harness([]);
    const [prompt, model] = stepFolds(frames(1, "Unanswered"));
    if (!prompt || !model) throw new Error("no folds");
    const promptRef = prompt.request?.body.bodyRef;
    const modelRef = model.response?.body.bodyRef;
    const cache = createWordsCache();
    // Only the prompt is kept. The read below then holds the prompt as a
    // kept digest and opens the model step's body, the one body it reads
    // under the key.
    await readWords(deps.bodies, SCOPE, [prompt], { cache });
    getBody.mockClear();
    // The store drops the model step's read before KMS is asked, and KMS
    // refuses the key for any body that reaches it.
    getBody.mockImplementation((_scope: unknown, ref: string) =>
      ref === modelRef
        ? Promise.reject(new Error("socket hang up"))
        : erasedKey(),
    );
    const words = await readWords(deps.bodies, SCOPE, [prompt, model], {
      cache,
    });
    expect(words.has(model)).toBe(false);
    // The retest found the key gone, so the kept digest does not answer.
    expect(words.has(prompt)).toBe(false);
    // The model step's body, then the prompt's, read again once the reads
    // were done to learn the key.
    expect(getBody.mock.calls.map(([, ref]) => ref)).toEqual([
      modelRef,
      promptRef,
    ]);
  });
});

// Findings P2-1 and P3-1 of the ADR-182 fourth review. A read that failed set
// `quiet`, so an entry vanished from its chip on a live run while the rows
// the page held stayed; and erasure, which destroys the key and leaves the
// object, was modelled as a deleted object, so a process that had kept a
// digest before erasure answered differently from one that had not.
describe("get_run_transcript and a body that cannot be read", () => {
  const blank = { toolName: "", toolStatus: "", toolUseId: "" };
  /**
   * Two turns: a prompt, a model step that says "Done.", and a closing
   * message that repeats it, which is an echo and so quiet; then a prompt of
   * only whitespace, which is quiet too.
   */
  const run = [
    tachoRow(0, {
      kind: "turn_start",
      ...blank,
      turnSeq: 1,
      ...stored("Ship the fix."),
    }),
    tachoRow(1, {
      kind: "llm_call",
      ...blank,
      model: "claude-opus-5",
      provider: "anthropic",
      turnSeq: 1,
      ...stored(modelStream(["Done."]), "text/event-stream"),
    }),
    tachoRow(2, {
      kind: "turn_end",
      ...blank,
      turnSeq: 1,
      ...stored("Done."),
    }),
    tachoRow(3, {
      kind: "turn_start",
      ...blank,
      turnSeq: 2,
      ...stored(" \n "),
    }),
  ];
  const marks = (out: { entries: { key?: string; quiet?: boolean }[] }) =>
    out.entries.map((e) => [e.key, e.quiet]);

  it("keeps a prompt whose read timed out shown, with the same count on every read", async () => {
    const { transcript, getBody } = harness(run);
    const prompt = run[0]?.bytesRef;
    const read = getBody.getMockImplementation();
    getBody.mockImplementation((scope, ref) =>
      ref === prompt
        ? Promise.reject(new Error("timeout"))
        : (read?.(scope, ref) ?? Promise.reject(new Error("no body"))),
    );
    const first = await transcript(input({ zoom: "steps" }), ctx());
    const second = await transcript(input({ zoom: "steps" }), ctx());
    expect(first.entries.find((e) => e.key === "0")?.quiet).toBe(false);
    expect(second.entries.find((e) => e.key === "0")?.quiet).toBe(false);
    expect(first.counts?.kinds?.prompt).toBe(1);
    expect(second.counts).toEqual(first.counts);
    // The read that failed is tried again on the next read, since a timeout
    // may pass. Within one read it is asked for once, for its words and its
    // half alike.
    expect(getBody.mock.calls.filter(([, ref]) => ref === prompt)).toHaveLength(
      2,
    );
  });

  it("settles blank words and an echo only from a body read whole (negative)", async () => {
    const { transcript } = harness(run);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(marks(out)).toEqual([
      ["0", false],
      ["1", false],
      ["2", true],
      ["3", true],
    ]);
    expect(out.entries.find((e) => e.key === "2")?.echoOf).toBe("1");
  });

  it("answers the same after erasure whether the process read the run before or not", async () => {
    const erased = () =>
      Promise.reject(
        new BodyKeyGoneError("k", {
          cause: Object.assign(new Error("pending deletion"), {
            name: "KMSInvalidStateException",
          }),
        }),
      );
    const warm = harness(run);
    const before = await warm.transcript(input({ zoom: "steps" }), ctx());
    expect(marks(before)).toEqual([
      ["0", false],
      ["1", false],
      ["2", true],
      ["3", true],
    ]);

    warm.getBody.mockImplementation(erased);
    const cold = harness(run);
    cold.getBody.mockImplementation(erased);
    const warmAfter = await warm.transcript(input({ zoom: "steps" }), ctx());
    const coldAfter = await cold.transcript(input({ zoom: "steps" }), ctx());
    expect(warmAfter).toEqual(coldAfter);
    // No body can be read, so no entry is settled by its words: each keeps
    // what the fold said, and no reply is read as an echo.
    expect(marks(warmAfter)).toEqual([
      ["0", false],
      ["1", false],
      ["2", false],
      ["3", false],
    ]);
    expect(warmAfter.entries.every((e) => e.echoOf === null)).toBe(true);
    expect(warmAfter.entries.every((e) => e.request?.text == null)).toBe(true);

    // Each erased body is remembered for the failure TTL, so a later read
    // reads no body for its words, only its page's halves.
    warm.getBody.mockClear();
    const again = await warm.transcript(input({ zoom: "steps" }), ctx());
    expect(again).toEqual(warmAfter);
    const halves = again.entries.flatMap((e) =>
      [e.request?.bytesRef, e.response?.bytesRef].filter(
        (ref): ref is string => typeof ref === "string",
      ),
    );
    expect(warm.getBody).toHaveBeenCalledTimes(halves.length);
  });

  // Finding P2-A of the ADR-182 fifth review: a reference names the
  // deployment KEK, so one body that did not open marked the key gone, and
  // every other body under it lost its words for a minute.
  it("fails only the body that does not open, and settles the rest under its key", async () => {
    const tampered = run[0]?.bytesRef;
    const unopenable = (read: ReturnType<typeof harness>) => {
      const real = read.getBody.getMockImplementation();
      read.getBody.mockImplementation((scope, ref) =>
        ref === tampered
          ? Promise.reject(
              new BodyUnopenableError("k", {
                cause: new Error(
                  "Unsupported state or unable to authenticate data",
                ),
              }),
            )
          : (real?.(scope, ref) ?? Promise.reject(new Error("no body"))),
      );
    };
    const settled = [
      ["0", false],
      ["1", false],
      ["2", true],
      ["3", true],
    ];
    const warm = harness(run);
    const before = await warm.transcript(input({ zoom: "steps" }), ctx());
    expect(marks(before)).toEqual(settled);

    unopenable(warm);
    const cold = harness(run);
    unopenable(cold);
    const warmAfter = await warm.transcript(input({ zoom: "steps" }), ctx());
    const coldAfter = await cold.transcript(input({ zoom: "steps" }), ctx());
    expect(warmAfter).toEqual(coldAfter);
    // The blank prompt and the echo under the same key still settle, so
    // nothing the tampered prompt did not decide moves.
    expect(marks(warmAfter)).toEqual(settled);
    expect(warmAfter.counts).toEqual(before.counts);
    expect(warmAfter.entries.find((e) => e.key === "2")?.echoOf).toBe("1");
    expect(warmAfter.entries.find((e) => e.key === "0")?.request?.text).toBe(
      null,
    );
    // The key was not marked gone: the other bodies' texts are shown.
    expect(warmAfter.entries.find((e) => e.key === "2")?.response?.text).toBe(
      "Done.",
    );
  });
});

// #3942: the thinking and seal chips select the right entries through the
// handler, and every chip's count is the whole run's. Each read here starts
// at the run's first frame, the only read that carries counts (D6 of the live
// Run page batch), so none of these asserts a count on a cursor page.
describe("get_run_transcript thinking and seal chips (#3942)", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c2d0";
  const blank = { toolName: "", toolStatus: "", toolUseId: "" };
  const at = (second: number) =>
    `2026-09-11 09:00:${String(second).padStart(2, "0")}.000`;
  const model = {
    kind: "llm_call",
    ...blank,
    model: "claude-opus-5",
    provider: "anthropic",
  };
  const root = [
    tachoRow(0, {
      kind: "turn_start",
      ...blank,
      turnSeq: 1,
      ...stored("Tighten the retry test."),
    }),
    tachoRow(1, {
      kind: "tool_requested",
      toolName: "Task",
      toolStatus: "",
      toolUseId: "toolu_think",
      turnSeq: 1,
    }),
    tachoRow(2, {
      kind: "subagent_start",
      ...blank,
      toolUseId: "toolu_think",
      turnSeq: 1,
    }),
    tachoRow(3, {
      kind: "tool_call",
      toolName: "Task",
      toolUseId: "toolu_think",
      turnSeq: 1,
      ts: at(30),
    }),
    // Claude Code's transcript reports the tokens a call spent reasoning.
    tachoRow(4, {
      ...model,
      source: "transcript",
      turnSeq: 1,
      ts: at(41),
      body: JSON.stringify({ thinking_tokens: 12, output_tokens: 40 }),
      ...stored("Thought it through, then tightened the test."),
    }),
    // A call that answered without reasoning (negative).
    tachoRow(5, {
      ...model,
      source: "transcript",
      turnSeq: 1,
      ts: at(42),
      body: JSON.stringify({ thinking_tokens: 0, output_tokens: 8 }),
      ...stored("Done."),
    }),
    // OTel's record carries thinking tokens too, but only the transcript's
    // split counts (`countsLlmCallSplit`), so this call answers usage and
    // not thinking (negative).
    tachoRow(6, {
      ...model,
      source: "otel_log",
      turnSeq: 1,
      ts: at(43),
      body: JSON.stringify({ thinking_tokens: 12, output_tokens: 40 }),
    }),
    // The chain's own integrity frames, read on the Chain tab (negative).
    tachoRow(7, { kind: "checkpoint", ...blank, ts: at(44) }),
    tachoRow(8, { kind: "telemetry_gap", ...blank, ts: at(45) }),
    // The run's own stop.
    tachoRow(9, { kind: "agent_stop", ...blank, ts: at(46) }),
  ];
  const child = (seq: number, over: Partial<TachoFrameRow>): TachoFrameRow =>
    tachoRow(seq, {
      sessionUuid: CHILD,
      rootSessionUuid: SESSION_UUID,
      parentSessionUuid: SESSION_UUID,
      subagentId: "agent-2",
      subagentType: "Explore",
      spawnToolUseId: "toolu_think",
      ts: at(10 + seq),
      ...over,
    });
  const children = [
    child(0, { kind: "turn_start", ...blank, turnSeq: 1 }),
    // A subagent that reasoned is thinking of the run's too.
    child(1, {
      ...model,
      source: "transcript",
      body: JSON.stringify({ thinking_tokens: 5, output_tokens: 20 }),
      ...stored("Found the flaky test."),
    }),
    // A subagent stopping is the subagent's, not the run's (negative).
    child(2, { kind: "agent_stop", ...blank }),
  ];
  const keysOf = (out: { entries: readonly { key?: string }[] }) =>
    out.entries.map((e) => e.key ?? "").sort();

  it("steps: thinking keeps the model calls that reasoned, on any chain, and nothing else", async () => {
    const { transcript } = harness(root, undefined, children);
    const out = await transcript(
      input({ zoom: "steps", kinds: ["thinking"] }),
      ctx(),
    );
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(keysOf(out)).toEqual(["4", `${CHILD}:1`].sort());
    for (const entry of out.entries) {
      expect(entry.kinds).toContain("thinking");
      expect(entry.node).toBe("model");
    }
    // The call that reasoned carries its reply, so the chip draws its words.
    expect(out.entries.find((e) => e.key === "4")?.response?.text).toBe(
      "Thought it through, then tightened the test.",
    );
    // Negative: the call that did not reason, and the OTel record whose
    // thinking tokens are not counted, answer other chips.
    const all = await transcript(input({ zoom: "steps" }), ctx());
    const kindsOf = (key: string) =>
      all.entries.find((e) => e.key === key)?.kinds ?? [];
    expect(kindsOf("5")).toEqual(expect.arrayContaining(["responses"]));
    expect(kindsOf("5")).not.toContain("thinking");
    expect(kindsOf("6")).toContain("usage");
    expect(kindsOf("6")).not.toContain("thinking");
  });

  it("steps: seal keeps the run's own stop and nothing else", async () => {
    const { transcript } = harness(root, undefined, children);
    const out = await transcript(
      input({ zoom: "steps", kinds: ["seal"] }),
      ctx(),
    );
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.entries.map((e) => [e.key, e.node, e.quiet])).toEqual([
      ["9", "seal", false],
    ]);
    expect(out.entries[0]?.subagent).toBeUndefined();
    // Negative: the subagent's stop, the checkpoint and the gap answer no
    // seal on the unfiltered read either.
    const all = await transcript(input({ zoom: "steps" }), ctx());
    expect(
      all.entries.filter((e) => e.kinds.includes("seal")).map((e) => e.key),
    ).toEqual(["9"]);
  });

  it("everything: the two chips select the same frames, and the chain's own frames answer no chip", async () => {
    const { transcript } = harness(root, undefined, children);
    const thinking = await transcript(
      input({ zoom: "everything", kinds: ["thinking"] }),
      ctx(),
    );
    expect(keysOf(thinking)).toEqual(["4", `${CHILD}:1`].sort());
    const seal = await transcript(
      input({ zoom: "everything", kinds: ["seal"] }),
      ctx(),
    );
    expect(seal.entries.map((e) => [e.key, e.type])).toEqual([
      ["9", "agent_stop"],
    ]);
    const all = await transcript(input({ zoom: "everything" }), ctx());
    for (const type of ["checkpoint", "telemetry_gap"]) {
      expect(all.entries.find((e) => e.type === type)?.kinds).toEqual([]);
    }
    expect(all.counts?.kinds).toMatchObject({ thinking: 2, seal: 1 });
  });

  it("counts both chips over the whole run, whatever the chips, the query or the page size", async () => {
    const { transcript } = harness(root, undefined, children);
    const all = await transcript(input({ zoom: "steps" }), ctx());
    expect(all.counts?.kinds.thinking).toBe(2);
    expect(all.counts?.kinds.seal).toBe(1);
    // Every read below starts at the run's first frame, so each carries the
    // whole run's counts, however little of it the page holds.
    for (const over of [
      { kinds: ["thinking"] },
      { kinds: ["seal"] },
      { kinds: ["tools"] },
      { query: "tightened" },
      { limit: 1 },
    ]) {
      const out = await transcript(input({ zoom: "steps", ...over }), ctx());
      expect(out.counts).toEqual(all.counts);
    }
  });

  it("ledger run: seal keeps the event that closes the attempt and nothing else", async () => {
    const events = [
      event(1),
      event(2, {
        eventType: "terminal.attempt_terminated",
        stage: "terminal",
        payload: { terminal_status: "completed" },
      }),
    ];
    const stores = memoryStores(
      [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
      [],
    );
    const transcript = createRunTranscriptGetHandler({
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
    });
    const out = await transcript(
      runTranscriptGet.input.parse({
        runId: LEDGER_ID,
        zoom: "steps",
        kinds: ["seal"],
      }),
      ctx(),
    );
    expect(out.entries.map((e) => [e.key, e.node])).toEqual([["2", "seal"]]);
    expect(out.counts?.kinds.seal).toBe(1);
    // Negative: the tool call answers tools, not seal.
    expect(out.counts?.kinds.tools).toBe(1);
  });
});

describe("get_run_transcript follows a live run from inside its turn (#4340)", () => {
  const bare = { toolName: "", toolStatus: "" };
  const live = { outcome: "running", sealedAt: null };
  const A = "0192d4a8-7c1e-7a00-8000-00000000a0a0";
  /** When frame `seq` was recorded: one second after the one before it. */
  const BASE = Date.parse("2026-09-26T09:00:00.000Z");
  const ts = (seq: number) => receipt(BASE + seq * 1_000);
  /** Received two settle margins before the first read: settled for every read. */
  const settled = receipt(NOW - 2 * RECEIPT_SETTLE_MS);

  type Harness = ReturnType<typeof harness>;

  /** A model call that kept a body, and the two tool calls it asked for, from `seq` on. */
  const cycle = (seq: number, receivedAt: string): TachoFrameRow[] =>
    [
      tachoRow(seq, {
        kind: "llm_call",
        ...bare,
        model: "haiku",
        provider: "anthropic",
        costUsdMicros: 5,
        turnSeq: 2,
        ...stored(`Step ${seq}: reading the next file.`),
      }),
      tachoRow(seq + 1, { turnSeq: 2 }),
      tachoRow(seq + 2, { turnSeq: 2 }),
    ].map((row) => ({ ...row, ts: ts(row.seq), receivedAt }));

  /**
   * A live run in its second turn: turn 1 is a prompt and its answer, and
   * turn 2 is `cycles` cycles of a model call and its tool calls, the shape
   * of a coding agent's one long turn. Turn 2 opens at seq 3.
   */
  function longTurn(cycles: number): TachoFrameRow[] {
    const rows: TachoFrameRow[] = [
      tachoRow(0, { kind: "turn_start", ...bare, turnSeq: 1 }),
      tachoRow(1, {
        kind: "llm_call",
        ...bare,
        model: "haiku",
        provider: "anthropic",
        costUsdMicros: 10,
        turnSeq: 1,
      }),
      tachoRow(2, { kind: "turn_end", ...bare, turnSeq: 1 }),
      tachoRow(3, { kind: "turn_start", ...bare, turnSeq: 2 }),
    ].map((row) => ({ ...row, ts: ts(row.seq), receivedAt: settled }));
    for (let k = 0; k < cycles; k += 1)
      rows.push(...cycle(rows.length, settled));
    return rows;
  }

  /** The read a live Run page makes: `steps`, whole bodies, a full page. */
  const follow = (h: Harness, after?: string | null) =>
    h.transcript(
      input({
        zoom: "steps",
        text: "full",
        limit: 500,
        ...(after === undefined || after === null ? {} : { after }),
      }),
      ctx(),
    );

  /** Where each read of the run's own chain since the last clear began. */
  const afterSeqs = (h: Harness) =>
    h.tachoFrames.mock.calls.map(([args]) => args.afterSeq);

  /** How many frames of the run's own chain those reads answered. */
  async function rowsRead(h: Harness): Promise<number> {
    const answered = await Promise.all(
      h.tachoFrames.mock.results.map(
        (result) => result.value as Promise<TachoFrameRow[]>,
      ),
    );
    return answered.reduce((sum, rows) => sum + rows.length, 0);
  }

  it("reads only the frames past the reader's place, and sends what a reader of the whole run is sent", async () => {
    let clock = NOW;
    const rows = longTurn(10);
    // Postgres lists the subagent chains, so this reader can read windows.
    const tailing = harness(rows, live, [], { chains: [], now: () => clock });
    // Without that list every read reads the whole run.
    const whole = harness(rows, live, [], { now: () => clock });
    let a = await follow(tailing);
    let b = await follow(whole);
    expect(a.entries).toEqual(b.entries);
    expect(decodeTranscriptCursor(a.cursor as string)?.from?.seq).toBe("3");
    const starts: number[] = [];
    const counted: number[] = [];
    for (let poll = 0; poll < 8; poll += 1) {
      clock += 90_000;
      // A cycle the server received a second before this read.
      rows.push(...cycle(rows.length, receipt(clock - 1_000)));
      tailing.tachoFrames.mockClear();
      a = await follow(tailing, a.cursor);
      b = await follow(whole, b.cursor);
      expect(a.entries).toEqual(b.entries);
      expect(a.cursor).toBe(b.cursor);
      starts.push(afterSeqs(tailing)[0] ?? -2);
      counted.push(await rowsRead(tailing));
    }
    // Each read starts at the latest model step whose frames had settled
    // when the read before it ran, never at the turn's first frame (seq 3),
    // and it moves one cycle a read as the cycles settle.
    expect(starts).toEqual([30, 30, 33, 36, 39, 42, 45, 48]);
    // So a read holds the same few frames however long the turn has run.
    expect(counted).toEqual([6, 9, 9, 9, 9, 9, 9, 9]);
    // Turns and cost carry on from the run's count.
    expect(a.entries.at(-1)?.turn).toBe(2);
    expect(a.entries.at(-1)?.cumulativeCost?.micros).toBe(String(10 + 5 * 18));
  }, 30_000);

  it.each([
    // The proxy's sighting kept the whole reply, so it stays and the copy goes.
    { first: "collector", starts: [30, 30, 33, 36] },
    // A sighting that kept no body gives way to the transcript's copy, which
    // takes its cost. A read that started past the first sighting would show
    // the copy without the cost, so no read starts inside the turn.
    { first: "otel_log", starts: [2, 2, 2, 2] },
  ])(
    "follows a run that records each model call twice, the first from $first",
    async ({ first, starts }) => {
      let clock = NOW;
      /** A model call seen by `first` and then by the transcript, and one tool call. */
      const twice = (seq: number, receivedAt: string): TachoFrameRow[] => {
        const body = JSON.stringify({ request_id: `req_${seq}` });
        return [
          tachoRow(seq, {
            kind: "llm_call",
            ...bare,
            source: first,
            body,
            costUsdMicros: 5,
            turnSeq: 2,
            ...(first === "collector" ? stored(`Proxy ${seq}.`) : {}),
          }),
          tachoRow(seq + 1, {
            kind: "llm_call",
            ...bare,
            source: "transcript",
            body,
            attrs: { "oxagen.llm_call_duplicate_of": first },
            costUsdMicros: 5,
            turnSeq: 2,
            ...stored(`Transcript ${seq}.`),
          }),
          tachoRow(seq + 2, { turnSeq: 2 }),
        ].map((row) => ({ ...row, ts: ts(row.seq), receivedAt }));
      };
      const rows = longTurn(0);
      for (let k = 0; k < 10; k += 1) rows.push(...twice(rows.length, settled));
      const tailing = harness(rows, live, [], { chains: [], now: () => clock });
      const whole = harness(rows, live, [], { now: () => clock });
      let a = await follow(tailing);
      let b = await follow(whole);
      expect(a.entries).toEqual(b.entries);
      const read: number[] = [];
      for (let poll = 0; poll < 4; poll += 1) {
        clock += 90_000;
        rows.push(...twice(rows.length, receipt(clock - 1_000)));
        tailing.tachoFrames.mockClear();
        a = await follow(tailing, a.cursor);
        b = await follow(whole, b.cursor);
        expect(a.entries).toEqual(b.entries);
        expect(a.cursor).toBe(b.cursor);
        read.push(afterSeqs(tailing)[0] ?? -2);
      }
      expect(read).toEqual(starts);
      // Each model call is counted once, at its first sighting's cost.
      expect(a.entries.at(-1)?.cumulativeCost?.micros).toBe(
        String(10 + 5 * 14),
      );
    },
    30_000,
  );

  it("follows a run that is one turn from its first frame, whose cursor names no window", async () => {
    let clock = NOW;
    const rows: TachoFrameRow[] = [
      {
        ...tachoRow(0, { kind: "turn_start", ...bare, turnSeq: 2 }),
        ts: ts(0),
        receivedAt: settled,
      },
    ];
    for (let k = 0; k < 10; k += 1) rows.push(...cycle(rows.length, settled));
    const tailing = harness(rows, live, [], { chains: [], now: () => clock });
    const whole = harness(rows, live, [], { now: () => clock });
    let a = await follow(tailing);
    let b = await follow(whole);
    // No turn opens after the first frame, so the cursor names no window
    // and, without a tail start, every read would read the whole run.
    expect(decodeTranscriptCursor(a.cursor as string)?.from).toBeUndefined();
    const starts: number[] = [];
    for (let poll = 0; poll < 4; poll += 1) {
      clock += 90_000;
      rows.push(...cycle(rows.length, receipt(clock - 1_000)));
      tailing.tachoFrames.mockClear();
      a = await follow(tailing, a.cursor);
      b = await follow(whole, b.cursor);
      expect(a.entries).toEqual(b.entries);
      expect(a.cursor).toBe(b.cursor);
      starts.push(afterSeqs(tailing)[0] ?? -2);
    }
    expect(starts).toEqual([27, 27, 30, 33]);
    expect(a.entries.at(-1)?.turn).toBe(1);
  }, 30_000);

  it("reads as many frames on each update of a turn of 1,200 frames as of one of 30", async () => {
    const readsAt = async (cycles: number) => {
      let clock = NOW;
      const rows = longTurn(cycles);
      const tailing = harness(rows, live, [], { chains: [], now: () => clock });
      // The page reads 500 entries at a time until it holds the run.
      let page = await follow(tailing);
      while (page.entries.length >= 500) page = await follow(tailing, page.cursor);
      const counted: number[] = [];
      for (let poll = 0; poll < 4; poll += 1) {
        clock += 90_000;
        rows.push(...cycle(rows.length, receipt(clock - 1_000)));
        tailing.tachoFrames.mockClear();
        page = await follow(tailing, page.cursor);
        counted.push(await rowsRead(tailing));
      }
      return counted;
    };
    const short = await readsAt(10);
    const long = await readsAt(400);
    expect(long).toEqual(short);
    expect(long.at(-1)).toBe(9);
  }, 60_000);

  it("reads the turn's window when a frame past the tail start names a call from before it", async () => {
    let clock = NOW;
    const rows = longTurn(10);
    const tailing = harness(rows, live, [], { chains: [], now: () => clock });
    const whole = harness(rows, live, [], { now: () => clock });
    let a = await follow(tailing);
    let b = await follow(whole);
    for (let poll = 0; poll < 3; poll += 1) {
      clock += 90_000;
      rows.push(...cycle(rows.length, receipt(clock - 1_000)));
      a = await follow(tailing, a.cursor);
      b = await follow(whole, b.cursor);
    }
    // A second source's copy of tool call tu_5, from the turn's first cycle,
    // lands now. The fold joins it to that call, so the call grows.
    clock += 90_000;
    rows.push({
      ...tachoRow(rows.length, { turnSeq: 2, toolUseId: "tu_5" }),
      ts: ts(rows.length),
      receivedAt: receipt(clock - 1_000),
    });
    tailing.tachoFrames.mockClear();
    a = await follow(tailing, a.cursor);
    b = await follow(whole, b.cursor);
    expect(a.entries).toEqual(b.entries);
    expect(a.entries.map((e) => e.seq)).toContain("5");
    // The read tried the tail start, found the key, and read the turn's
    // window from its first frame instead.
    expect(afterSeqs(tailing)).toEqual([36, 2]);
    // Negative control: the same read with no copy answers from the tail.
    rows.pop();
    const again = harness(rows, live, [], { chains: [], now: () => clock });
    let c = await follow(again);
    for (let poll = 0; poll < 3; poll += 1) {
      c = await follow(again, c.cursor);
    }
    again.tachoFrames.mockClear();
    await follow(again, c.cursor);
    expect(afterSeqs(again)[0]).toBe(39);
  }, 30_000);

  it("resumes from the cursor after a gap, and reads the turn's window where no start was kept", async () => {
    let clock = NOW;
    const rows = longTurn(10);
    const tailing = harness(rows, live, [], { chains: [], now: () => clock });
    const whole = harness(rows, live, [], { now: () => clock });
    let a = await follow(tailing);
    let b = await follow(whole);
    for (let poll = 0; poll < 2; poll += 1) {
      clock += 90_000;
      rows.push(...cycle(rows.length, receipt(clock - 1_000)));
      a = await follow(tailing, a.cursor);
      b = await follow(whole, b.cursor);
    }
    // The stream drops, and the run records five cycles before the reader
    // is back. It reads once, from the cursor it held.
    for (let gap = 0; gap < 5; gap += 1) {
      clock += 90_000;
      rows.push(...cycle(rows.length, receipt(clock - 1_000)));
    }
    // Another process, which kept no tail start for the cursor, answers it
    // from the turn's window, with the same entries.
    const other = harness(rows, live, [], { chains: [], now: () => clock });
    const fresh = await follow(other, a.cursor);
    expect(afterSeqs(other)[0]).toBe(2);
    tailing.tachoFrames.mockClear();
    a = await follow(tailing, a.cursor);
    b = await follow(whole, b.cursor);
    expect(a.entries).toEqual(b.entries);
    expect(fresh.entries).toEqual(b.entries);
    // This process kept the start for that cursor: the read begins at the
    // last model step that had settled when the reader last read (seq 34),
    // not at the turn's first frame.
    expect(afterSeqs(tailing)).toEqual([33]);
    // Every cycle recorded in the gap reached the reader.
    expect(a.entries.at(-1)?.seq).toBe(String(rows.length - 1));
  }, 30_000);

  it("keeps a call that gains its result and a subagent chain that grows after the root inside the read", async () => {
    let clock = NOW;
    const rows = longTurn(10);
    const children: TachoFrameRow[] = [];
    const chains: SubagentChainFixture[] = [];
    const tailing = harness(rows, live, children, {
      chains,
      now: () => clock,
    });
    const whole = harness(rows, live, children, { now: () => clock });
    let a = await follow(tailing);
    let b = await follow(whole);
    const onA = (seq: number, over: Partial<TachoFrameRow>): TachoFrameRow =>
      tachoRow(seq, {
        sessionUuid: A,
        rootSessionUuid: SESSION_UUID,
        parentSessionUuid: SESSION_UUID,
        subagentId: "agent-1",
        subagentType: "Explore",
        spawnToolUseId: "toolu_A",
        ts: receipt(BASE + 36_500 + seq * 100),
        receivedAt: receipt(clock - 1_000),
        ...over,
      });
    const chain = subagentChain({
      sessionUuid: A,
      rootSessionUuid: SESSION_UUID,
      subagentId: "agent-1",
      spawnToolUseId: "toolu_A",
      seqCount: 0,
      // Half a second after the spawn at seq 36.
      startedAt: new Date(BASE + 36_500),
      lastEventAt: new Date(clock),
    });
    /** Subagent A records `recorded` now. */
    const record = (...recorded: TachoFrameRow[]) => {
      children.push(...recorded);
      chain.seqCount = children.length;
      chain.lastEventAt = new Date(clock - 1_000);
    };
    const step = async () => {
      a = await follow(tailing, a.cursor);
      b = await follow(whole, b.cursor);
      expect(a.entries).toEqual(b.entries);
      expect(a.cursor).toBe(b.cursor);
      return afterSeqs(tailing)[0] ?? -2;
    };
    const starts: number[] = [];

    // The model asks for a subagent: a Task call that waits on it.
    clock += 90_000;
    const spawn = rows.length;
    rows.push(
      ...[
        tachoRow(spawn, {
          kind: "llm_call",
          ...bare,
          model: "haiku",
          provider: "anthropic",
          costUsdMicros: 5,
          turnSeq: 2,
        }),
        tachoRow(spawn + 1, {
          kind: "tool_requested",
          toolName: "Task",
          toolUseId: "toolu_A",
          turnSeq: 2,
        }),
        tachoRow(spawn + 2, {
          kind: "subagent_start",
          ...bare,
          toolUseId: "toolu_A",
          turnSeq: 2,
        }),
      ].map((row) => ({
        ...row,
        ts: ts(row.seq),
        receivedAt: receipt(clock - 1_000),
      })),
    );
    chains.push(chain);
    record(
      onA(0, { kind: "turn_start", ...bare }),
      onA(1, {
        kind: "llm_call",
        ...bare,
        costUsdMicros: 300,
        receivedAt: receipt(clock - 1_000),
      }),
    );
    tailing.tachoFrames.mockClear();
    starts.push(await step());

    // The subagent works on while the call waits.
    for (const seq of [2, 3]) {
      clock += 90_000;
      record(onA(seq, { receivedAt: receipt(clock - 1_000) }));
      tailing.tachoFrames.mockClear();
      starts.push(await step());
    }

    // The subagent ends, and the Task call gains its result: it grows past
    // the cursor and is sent again with what it gained.
    clock += 90_000;
    rows.push({
      ...tachoRow(spawn + 3, { toolName: "Task", toolUseId: "toolu_A", turnSeq: 2 }),
      ts: ts(spawn + 3),
      receivedAt: receipt(clock - 1_000),
    });
    rows.push(...cycle(rows.length, receipt(clock - 1_000)));
    tailing.tachoFrames.mockClear();
    starts.push(await step());
    expect(a.entries.map((e) => e.seq)).toContain(String(spawn + 1));

    // The run moves on past the call.
    for (let poll = 0; poll < 3; poll += 1) {
      clock += 90_000;
      rows.push(...cycle(rows.length, receipt(clock - 1_000)));
      tailing.tachoFrames.mockClear();
      starts.push(await step());
    }
    // While the call waited, no read started after it, so the subagent's
    // chain was always inside the read. Once it ended, the start moved past
    // it, and the finished chain is left out of the read.
    expect(starts.slice(0, 4).every((at) => at > 2 && at < spawn + 1)).toBe(
      true,
    );
    expect(starts.at(-1)).toBeGreaterThan(spawn + 3);
  }, 30_000);
});
