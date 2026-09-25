// The Transcript tab's counts and its rows come from one rule (ADR-182).
//
// The server folds the run, settles which entries have nothing to show, and
// counts the rest (`transcriptCounts`). The tab draws each entry's rows
// (`feedOf`) and shows the server's counts beside them. If the two ever
// disagree about which entries draw, a chip says one number and shows
// another. So this test runs a recorded run through the real handler, then
// through the port's mapper and the tab's row function, and checks every
// count against the entries that drew rows under it.
//
// The unit is the entry, not the row: a model step that said two things is
// one entry under `responses`, drawn as two rows.
import { createHash } from "node:crypto";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { createRunTranscriptGetHandler } from "@oxagen/handlers/run.transcript.get";
import {
  ctx,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  tachoRow,
  tachoSession,
} from "@oxagen/handlers/run.test-support";
import { describe, expect, it } from "vitest";
import { RunTranscript } from "@/data/contracts/run";
import { toRunTranscript } from "@/data/live/mappers/run";
import { FEED_GROUPS, feedOf } from "./transcript-rows";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";

const enc = new TextEncoder();
const objects = new Map<string, Uint8Array>();

/** A body the recorder kept, stored under its digest. */
function stored(text: string) {
  const bytes = enc.encode(text);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const ref = `evb:v1:k:${digest.slice(7)}`;
  objects.set(ref, bytes);
  return { contentDigest: digest, bytesRef: ref };
}

/** A recorded model stream of `blocks`, as the gateway kept it. */
function streamOf(
  blocks: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: object }
  )[],
): string {
  const events: object[] = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        { type: "content_block_start", index, content_block: { type: "text" } },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      );
    } else {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name },
        },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      );
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  );
  return events
    .map((data) => `event: e\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const none = { toolName: "", toolStatus: "", toolUseId: "" };
const model = { model: "claude-opus-5", provider: "anthropic" };

/**
 * Two turns. The first: a prompt; a model step that only calls Read, and
 * the Read call; a model step that says something and calls Write, and the
 * Write call; a failed Bash call; a model step kept as a digest with no cost
 * or tokens; and a closing message that repeats the model's words. The
 * second: a prompt of only whitespace, a closing message that says something
 * new, a model call still waiting on its reply, and the run's stop.
 */
const rows: TachoFrameRow[] = [
  tachoRow(0, {
    kind: "turn_start",
    ...none,
    turnSeq: 1,
    ...stored("Ship it."),
  }),
  tachoRow(1, {
    kind: "llm_call",
    ...none,
    ...model,
    costUsdMicros: 12,
    turnSeq: 1,
    ...stored(
      streamOf([
        {
          type: "tool_use",
          id: "toolu_r",
          name: "Read",
          input: { file_path: "/p/plan.md" },
        },
      ]),
    ),
  }),
  tachoRow(2, {
    kind: "tool_call",
    toolName: "Read",
    toolStatus: "ok",
    toolUseId: "toolu_r",
    turnSeq: 1,
  }),
  tachoRow(3, {
    kind: "llm_call",
    ...none,
    ...model,
    costUsdMicros: 40,
    turnSeq: 1,
    ...stored(
      streamOf([
        { type: "text", text: "Writing the notes." },
        {
          type: "tool_use",
          id: "toolu_w",
          name: "Write",
          input: { file_path: "/p/notes.md" },
        },
      ]),
    ),
  }),
  tachoRow(4, {
    kind: "tool_call",
    toolName: "Write",
    toolStatus: "ok",
    toolUseId: "toolu_w",
    turnSeq: 1,
  }),
  tachoRow(5, {
    kind: "tool_call",
    toolName: "Bash",
    toolStatus: "error",
    toolUseId: "tu_b",
    turnSeq: 1,
  }),
  tachoRow(6, {
    kind: "llm_call",
    ...none,
    ...model,
    turnSeq: 1,
    contentDigest: `sha256:${"d".repeat(64)}`,
  }),
  tachoRow(7, {
    kind: "turn_end",
    ...none,
    turnSeq: 1,
    ...stored("Writing the notes.\n"),
  }),
  tachoRow(8, { kind: "turn_start", ...none, turnSeq: 2, ...stored(" \n") }),
  tachoRow(9, {
    kind: "turn_end",
    ...none,
    turnSeq: 2,
    ...stored("Nothing more to do."),
  }),
  tachoRow(10, {
    kind: "model.request",
    ...none,
    ...model,
    toolUseId: "m_live",
    turnSeq: 2,
    ...stored('{"messages":[]}'),
  }),
  tachoRow(11, { kind: "agent_stop", ...none, turnSeq: 2 }),
];

function transcript() {
  const stores = memoryStores([], [tachoSession({ publicId: TACHO_ID })]);
  return createRunTranscriptGetHandler({
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, rows),
    tachoSubagentFrames: () => Promise.resolve([]),
    bodies: {
      getBody: (_scope, ref) => {
        const bytes = objects.get(ref);
        return bytes === undefined
          ? Promise.reject(new Error(`no object for ${ref}`))
          : Promise.resolve({
              bytes,
              contentType: "text/plain",
              digestHex: ref.slice(-64),
            });
      },
      getAssembly: () => Promise.resolve(null),
    },
    priceBook: () => Promise.resolve([]),
  });
}

describe("the Transcript tab's counts and rows", () => {
  it("count exactly the entries that draw rows, chip by chip", async () => {
    const out = await transcript()(
      runTranscriptGet.input.parse({
        runId: TACHO_ID,
        zoom: "steps",
        text: "full",
      }),
      ctx(),
    );
    const read = RunTranscript.parse(toRunTranscript(out));
    const drawn = feedOf(read.entries);
    const entriesOf = (keep: (row: (typeof drawn)[number]) => boolean) =>
      new Set(drawn.filter(keep).map((row) => row.entry)).size;
    const counts = read.counts;
    if (counts === null) throw new Error("the read carried no counts");

    for (const group of FEED_GROUPS) {
      expect({ group, count: counts.kinds[group] }).toEqual({
        group,
        count: entriesOf((row) => row.group === group),
      });
    }
    expect(counts.entries).toBe(entriesOf(() => true));
    expect(counts.errors).toBe(entriesOf((row) => row.failed));

    // The fixture holds what used to split them: a closing message that
    // repeats the model's streamed words, a prompt of only whitespace, a
    // model step that only called a tool, one kept as a digest with nothing
    // to draw, and a call still waiting on its reply.
    expect(drawn.map((row) => [row.entry, row.kind])).toEqual([
      ["0", "prompt"],
      ["1", "calls"],
      ["1", "usage"],
      ["2", "tool"],
      ["3", "text"],
      ["3", "usage"],
      ["4", "tool"],
      ["5", "tool"],
      ["9", "text"],
      ["11", "seal"],
    ]);
    expect(counts.entries).toBe(8);
    expect(counts.kinds.responses).toBe(3);
    // The step that only called Read names it, and draws the call once, as
    // the Read step's row.
    expect(drawn.find((row) => row.kind === "calls")).toMatchObject({
      tools: ["Read"],
    });
  });
});
