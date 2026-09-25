// The Transcript tab's rows, drawn from the entries the server folded
// (ADR-182), without a render. What makes a step (pairing a call's halves,
// gathering a call's frames, nesting a subagent, a call's outcome, an echo)
// is the server's fold and is tested there
// (`packages/run-ledger/src/transcript-steps.test.ts`). These tests hold what
// the page does with an entry: which rows it draws, which half each row
// reads, and how a page of entries is merged into what a reader holds.
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/data/contracts/run";
import { transcriptBody, transcriptEntry } from "./run.builders";
import {
  releaseSteps,
  releaseTranscript,
  type StepSpec,
  stepsOf,
} from "./transcript.builders";
import {
  closedLine,
  entryKey,
  FEED_GROUPS,
  type FeedRow,
  feedOf,
  LINE_CAP,
  mergeEntries,
  rebaseEntries,
  rowsOf,
  soleBody,
} from "./transcript-rows";

/** One entry with nothing on it but what a test names. */
function frame(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return transcriptEntry({ request: null, response: null, ...overrides });
}

/** The rows the steps draw, through the contract's own shape. */
function rowsFrom(specs: StepSpec[]): FeedRow[] {
  return feedOf(stepsOf(specs).entries);
}

/** The one row a list holds; a list of any other length fails the test. */
function only(rows: FeedRow[]): FeedRow {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error("no row");
  return row;
}

function toolOf(row: FeedRow | undefined) {
  if (row?.kind !== "tool") throw new Error("not a tool row");
  return row.call;
}

describe("the release run's rows", () => {
  const rows = feedOf(releaseTranscript().entries);

  it("reads as the design's rows, in the order the run happened", () => {
    expect(rows.map((row) => row.kind)).toEqual([
      "prompt",
      "recall",
      "thinking",
      "text",
      "usage",
      "tool",
      "text",
      "usage",
      "tool",
      "text",
      "usage",
      "tool",
      "tool",
      "thinking",
      "text",
      "usage",
      "tool",
      "text",
      "usage",
      "tool",
    ]);
  });

  it("files every row under the chip that shows it", () => {
    const groups = new Set(rows.map((row) => row.group));
    expect([...groups].sort()).toEqual(
      ["prompt", "recall", "responses", "thinking", "tools", "usage"].sort(),
    );
    expect(FEED_GROUPS).toEqual([
      "prompt",
      "responses",
      "thinking",
      "tools",
      "usage",
      "recall",
      "seal",
    ]);
  });

  it("marks the run's first prompt, and reads it from the prompt's request", () => {
    const [prompt] = rows;
    expect(prompt).toMatchObject({ kind: "prompt", first: true, turn: 1 });
  });

  it("draws the call a reply named and a tool step recorded once, as the step, with the decision keyed to it", () => {
    const tools = rows.filter((row) => row.kind === "tool");
    expect(tools.map((row) => toolOf(row).name)).toEqual([
      "github__list_pull_requests",
      "Read",
      "Write",
      "Bash",
      "Edit",
      "github__create_release",
    ]);
    const list = toolOf(tools[0]);
    expect(list.gates).toEqual([
      {
        decision: "allow",
        frame: { seq: "6", type: "policy_decision", chainRef: null },
      },
    ]);
    // The call's own frame is its receipt.
    expect(list.frame).toEqual({ seq: "7", type: "tool_call", chainRef: null });
    expect(list.durationMs).toBe(1100);
  });

  it("names a Read by its path and reads the file it returned", () => {
    const read = toolOf(
      rows.find((row) => row.kind === "tool" && row.call.name === "Read"),
    );
    expect(read.arg).toContain("CHANGELOG.md");
    expect(read.output).toContain("## 4.10.3");
  });

  it("reads a new file as a diff of additions, and an edit as its change", () => {
    const tools = rows.filter((row) => row.kind === "tool");
    const write = toolOf(tools.find((row) => toolOf(row).name === "Write"));
    expect(write.diffs[0]?.created).toBe(true);
    const edit = toolOf(tools.find((row) => toolOf(row).name === "Edit"));
    expect(edit.diffs[0]?.diff.added).toBeGreaterThan(0);
    expect(edit.diffs[0]?.diff.removed).toBeGreaterThan(0);
  });

  it("marks the call the server says failed, and only that one", () => {
    expect(
      rows.filter((row) => row.failed).map((row) => toolOf(row).name),
    ).toEqual(["Bash"]);
  });

  it("parks a call on an approval nobody answered, and states no duration for it", () => {
    const release = toolOf(rows.at(-1));
    expect(release.parked).toEqual({
      seq: "17",
      type: "approval_request",
      chainRef: null,
    });
    expect(release.pending).toBe(false);
    expect(release.durationMs).toBeNull();
    expect(release.output).toBeNull();
  });

  it("reads what a model step cost, its tokens and the frame that carried them", () => {
    const usage = rows.find((row) => row.kind === "usage");
    expect(usage).toMatchObject({
      kind: "usage",
      model: "claude-opus-5",
      cost: { micros: "412600", currency: "USD" },
      usage: { inputUncached: 3368, cacheRead: 12000, output: 412 },
      frame: { seq: "4", type: "model.response", chainRef: null },
    });
  });

  it("reads what was recalled from the entry's recall, as the server read it", () => {
    const recall = rows.find((row) => row.kind === "recall");
    expect(recall).toMatchObject({
      kind: "recall",
      recall: { unit: "frames", count: 6, tokens: 11204 },
    });
    if (recall?.kind !== "recall") throw new Error("no recall row");
    expect(recall.recall.items).toHaveLength(6);
  });

  it("carries the run's cumulative cost on each row", () => {
    // Every model step's cost, summed: $2.8383 by the last row.
    expect(rows.at(-1)?.spent?.micros).toBe("2838300");
    expect(rows[0]?.spent).toBeNull();
  });
});

describe("a tool entry's two halves (#3375)", () => {
  const call = (over: Partial<StepSpec>): StepSpec => ({
    seq: 1,
    endSeq: 2,
    t: 0,
    type: "tool.engine_call_started",
    kind: "tool_call",
    node: "tool",
    turn: 1,
    subject: "Bash",
    family: "shell",
    outcome: "ok",
    ...over,
  });

  it("draws the request as what the call was made with and the response as what came back", () => {
    const tool = toolOf(
      only(
        rowsFrom([
          call({
            request: {
              seq: 1,
              type: "tool.engine_call_started",
              text: JSON.stringify({ command: "pnpm lint" }),
            },
            response: {
              seq: 2,
              type: "tool.engine_call_completed",
              text: JSON.stringify({ output: "0 problems" }),
            },
          }),
        ]),
      ),
    );
    expect(tool.arg).toBe("pnpm lint");
    expect(tool.output).toBe("0 problems");
    expect(tool.frame.seq).toBe("2");
  });

  it("never draws a call's input as its result while no result came back (negative)", () => {
    const tool = toolOf(
      only(
        rowsFrom([
          call({
            endSeq: 1,
            outcome: "pending",
            request: {
              seq: 1,
              type: "tool.engine_call_started",
              text: JSON.stringify({ command: "sleep 60" }),
            },
          }),
        ]),
      ),
    );
    expect(tool.arg).toBe("sleep 60");
    expect(tool.output).toBeNull();
    expect(tool.pending).toBe(true);
    // The call's own frame is its request while it has no receipt.
    expect(tool.frame.seq).toBe("1");
  });

  it("draws the target the gate recorded when no half kept the input", () => {
    const tool = toolOf(
      only(
        rowsFrom([
          call({
            endSeq: 1,
            type: "tool_call",
            target: "git push origin main",
            response: { seq: 1, type: "tool_call", fidelity: "digest_only" },
          }),
        ]),
      ),
    );
    expect(tool.arg).toBe("git push origin main");
    expect(tool.raw).toBe("git push origin main");
  });

  it("parks a call on its receipt and names the approval the receipt names", () => {
    const tool = toolOf(
      only(
        rowsFrom([
          call({
            subject: "create_workspace",
            family: "tool",
            outcome: "parked",
            approvalId: "apr_7Kq2",
            response: { seq: 2, type: "tool.engine_call_completed" },
          }),
        ]),
      ),
    );
    expect(tool.parked).toEqual({
      seq: "2",
      type: "tool.engine_call_completed",
      chainRef: null,
    });
    expect(tool.approvalId).toBe("apr_7Kq2");
  });

  it("names the call by the server's reading of its tool, not the name the gateway recorded", () => {
    const tool = toolOf(
      only(
        rowsFrom([
          call({
            subject: "claude_code__Bash",
            tool: "Bash",
            request: {
              seq: 1,
              type: "tool.engine_call_started",
              text: '{"command":"ls"}',
            },
          }),
        ]),
      ),
    );
    expect(tool.name).toBe("Bash");
    // An answer that carried no reading shows the name as recorded: the
    // page keeps no prefix list of its own (ADR-182).
    const recorded = toolOf(
      only(rowsFrom([call({ subject: "claude_code__Bash" })])),
    );
    expect(recorded.name).toBe("claude_code__Bash");
  });

  it("reads a call a rule refused as failed, parking nothing (negative)", () => {
    const row = only(
      rowsFrom([
        call({
          outcome: "denied",
          gates: [{ seq: 2, decision: "deny", type: "policy_decision" }],
        }),
      ]),
    );
    expect(row.failed).toBe(true);
    expect(toolOf(row).parked).toBeNull();
    expect(toolOf(row).gates.map((gate) => gate.decision)).toEqual(["deny"]);
  });
});

describe("a model step's rows", () => {
  const model = (over: Partial<StepSpec>): StepSpec => ({
    seq: 1,
    t: 0,
    type: "llm_call",
    kind: "model_call",
    node: "model",
    turn: 1,
    outcome: "ok",
    model: "anthropic/claude-opus-5",
    ...over,
  });

  it("draws a call no tool step recorded from the reply's block, with the result the reply kept", () => {
    const rows = rowsFrom([
      model({
        response: {
          seq: 1,
          type: "llm_call",
          blocks: [
            {
              kind: "tool_use",
              name: "Read",
              input: { file_path: "src/a.ts" },
              callKey: "k1",
              stepKey: null,
              result: { ok: false, summary: "no such file" },
              family: "read",
            },
            {
              kind: "tool_use",
              name: "Bash",
              input: { command: "ls" },
              callKey: "k2",
              stepKey: "9",
              family: "shell",
            },
          ],
        },
      }),
    ]);
    const tool = only(rows);
    expect(tool.failed).toBe(true);
    expect(toolOf(tool)).toMatchObject({
      name: "Read",
      group: "read",
      output: "no such file",
      pending: false,
    });
  });

  it("names a call from the reply's block by the server's reading of its tool", () => {
    const rows = rowsFrom([
      model({
        response: {
          seq: 1,
          type: "llm_call",
          blocks: [
            {
              kind: "tool_use",
              name: "claude_code__Read",
              tool: "Read",
              input: { file_path: "src/a.ts" },
              callKey: "k1",
              stepKey: null,
              family: "read",
            },
          ],
        },
      }),
    ]);
    expect(toolOf(only(rows)).name).toBe("Read");
  });

  it("draws a reply kept as plain words, and one kept as JSON by its cost alone (negative)", () => {
    const words = rowsFrom([
      model({ response: { seq: 1, type: "llm_call", text: "Done." } }),
    ]);
    expect(words.map((row) => row.kind)).toEqual(["text"]);
    const json = rowsFrom([
      model({
        costMicros: "1000",
        response: { seq: 1, type: "llm_call", text: '{"content":[]}' },
      }),
    ]);
    expect(json.map((row) => row.kind)).toEqual(["usage"]);
  });

  it("says the model thought when only the reasoning tokens were kept", () => {
    const rows = rowsFrom([
      model({
        usage: {
          inputUncached: 10,
          cacheRead: null,
          cacheWrite: null,
          output: 4,
          reasoning: 40,
        },
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["thinking", "usage"]);
    expect(rows[0]).toMatchObject({ text: null, tokens: 40 });
  });

  it("draws nothing for a model step with no words, no tokens and no cost (negative)", () => {
    expect(rowsFrom([model({ model: undefined })])).toEqual([]);
  });

  it("names no model when the step recorded none", () => {
    const rows = rowsFrom([model({ model: undefined, costMicros: "10" })]);
    expect(only(rows)).toMatchObject({ kind: "usage", model: null });
  });
});

describe("an event's rows", () => {
  it("draws nothing for an entry with nothing to show, or one that repeats an earlier one", () => {
    expect(
      rowsFrom([
        {
          seq: 1,
          t: 0,
          type: "turn_end",
          kind: "frame",
          node: "reply",
          turn: 1,
          quiet: true,
        },
        {
          seq: 2,
          t: 0,
          type: "oxagen:message",
          kind: "frame",
          node: "reply",
          turn: 1,
          echoOf: "0",
          quiet: true,
          response: { seq: 2, type: "oxagen:message", text: "Cut it." },
        },
      ]),
    ).toEqual([]);
  });

  it("draws a reply's words, the run's stop, and a decision on no recorded call", () => {
    const rows = rowsFrom([
      {
        seq: 1,
        t: 0,
        type: "turn_end",
        kind: "frame",
        node: "reply",
        turn: 1,
        response: { seq: 1, type: "turn_end", text: "Released." },
      },
      {
        seq: 2,
        t: 1,
        type: "policy_decision",
        kind: "policy",
        node: "policy",
        turn: 1,
        subject: "Bash",
        outcome: "denied",
        gates: [{ seq: 2, decision: "deny", type: "policy_decision" }],
      },
      {
        seq: 3,
        t: 2,
        type: "agent_stop",
        kind: "frame",
        node: "seal",
        turn: 1,
        label: "end_turn",
      },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["text", "event", "seal"]);
    expect(rows[1]).toMatchObject({ name: "Bash", failed: true });
    expect(rows[2]).toMatchObject({ label: "end_turn", group: "seal" });
  });

  it("names a harness refusal by the tool it refused", () => {
    const row = only(
      rowsFrom([
        {
          seq: 1,
          t: 0,
          type: "harness_permission",
          kind: "frame",
          node: "event",
          turn: 1,
          subject: "Bash",
          outcome: "denied",
          label: "deny Bash",
        },
      ]),
    );
    expect(row).toMatchObject({ kind: "event", name: "Bash", failed: true });
  });
});

describe("a subagent's rows", () => {
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";

  it("names each row's parent by the entry the server says spawned its chain", () => {
    const rows = rowsFrom([
      {
        seq: 1,
        t: 0,
        type: "tool_requested",
        kind: "tool_call",
        node: "tool",
        turn: 1,
        subject: "Task",
        family: "agent",
        outcome: "ok",
      },
      {
        seq: 0,
        t: 1,
        type: "tool_call",
        kind: "tool_call",
        node: "tool",
        turn: 1,
        subject: "Read",
        family: "read",
        outcome: "ok",
        subagent: { sessionUuid: CHAIN, type: "Explore" },
        parentKey: "1",
      },
    ]);
    expect(rows.map((row) => [row.entry, row.parent])).toEqual([
      ["1", null],
      [`${CHAIN}:0`, "1"],
    ]);
  });
});

describe("a search's matches", () => {
  it("marks every row of an entry the search matched, and none of any other", () => {
    const specs = releaseSteps().map((spec) =>
      spec.seq === 12 ? { ...spec, matches: ["response" as const] } : spec,
    );
    const rows = rowsFrom(specs);
    expect(rows.filter((row) => row.matched).map((row) => row.entry)).toEqual([
      "12",
    ]);
  });
});

describe("entryKey", () => {
  it("reads the key the server named the entry by", () => {
    expect(entryKey(frame({ seq: "2", key: "sub:2" }))).toBe("sub:2");
  });
});

describe("mergeEntries", () => {
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
  const sub = { chainRef: CHAIN, type: "Explore" };
  const entry = (seq: string, over: Partial<TranscriptEntry> = {}) =>
    transcriptEntry({ seq, endSeq: seq, frames: 1, ...over });

  it("replaces an entry a page sends again where it stands, and appends the new ones in order", () => {
    const held = [entry("1"), entry("2"), entry("3")] as const;
    const grown = entry("2", { endSeq: "7", frames: 4, label: "Task ok" });
    const merged = mergeEntries(held, [grown, entry("8"), entry("9")]);
    expect(merged.map((e) => [e.seq, e.endSeq])).toEqual([
      ["1", "1"],
      ["2", "7"],
      ["3", "3"],
      ["8", "8"],
      ["9", "9"],
    ]);
    expect(merged[1]).toBe(grown);
    // The held list is not changed under the reader.
    expect(held[1].endSeq).toBe("2");
  });

  it("keeps the run's seq 1 and a subagent's seq 1 as two entries (negative)", () => {
    const merged = mergeEntries(
      [entry("1")],
      [entry("1", { subagent: sub }), entry("1", { subagent: sub, frames: 3 })],
    );
    expect(merged.map(entryKey)).toEqual(["1", `${CHAIN}:1`]);
    // The second copy of the subagent's entry replaced the first.
    expect(merged[1]?.frames).toBe(3);
  });

  it("answers the held entries for an empty page", () => {
    const held = [entry("1")] as const;
    expect(mergeEntries(held, [])).toEqual([entry("1")]);
  });
});

describe("rebaseEntries", () => {
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
  const sub = { chainRef: CHAIN, type: "Explore", spawnKey: "toolu_A" };
  const entry = (seq: string, over: Partial<TranscriptEntry> = {}) =>
    transcriptEntry({ seq, endSeq: seq, frames: 1, ...over });

  it("takes a fresh read's order, so a late subagent entry sits under its call, not at the foot (#4083)", () => {
    const held = [
      entry("1"),
      entry("2"),
      entry("0", { subagent: sub }),
      entry("3"),
    ] as const;
    const fresh = [
      entry("1"),
      entry("2"),
      entry("0", { subagent: sub }),
      entry("1", { subagent: sub }),
      entry("3"),
    ] as const;
    expect(rebaseEntries(fresh, held).map(entryKey)).toEqual([
      "1",
      "2",
      `${CHAIN}:0`,
      `${CHAIN}:1`,
      "3",
    ]);
    // Appending, as a tail page does, would have drawn it after seq 3.
    expect(mergeEntries(held, fresh).map(entryKey).at(-1)).toBe(`${CHAIN}:1`);
  });

  it("keeps the held entries a fresh read stopped short of, after its own", () => {
    const held = [entry("1"), entry("2"), entry("3")] as const;
    const fresh = [entry("1"), entry("2", { frames: 2 })] as const;
    const rebased = rebaseEntries(fresh, held);
    expect(rebased.map((e) => [e.seq, e.frames])).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 1],
    ]);
  });

  it("answers the fresh read itself when it holds everything (negative)", () => {
    const fresh = [entry("1"), entry("2")] as const;
    expect(rebaseEntries(fresh, [entry("1")])).toBe(fresh);
  });
});

describe("closedLine", () => {
  it("puts text on one line, each run of whitespace a single space", () => {
    expect(closedLine("  First line.\n\n\tSecond  line.\n")).toBe(
      "First line. Second line.",
    );
  });

  it("keeps text of exactly the cap whole (negative)", () => {
    const text = "a".repeat(LINE_CAP);
    expect(closedLine(text)).toBe(text);
  });

  it("cuts text one past the cap to the cap, ending in an ellipsis", () => {
    const line = closedLine("a".repeat(LINE_CAP + 1));
    expect(line).toHaveLength(LINE_CAP);
    expect(line).toBe(`${"a".repeat(LINE_CAP - 1)}…`);
  });

  it("returns nothing for text that is only whitespace", () => {
    expect(closedLine(" \n\t ")).toBe("");
  });
});

describe("soleBody", () => {
  it("reads the half an entry carries: what came back, else what went out", () => {
    const out = transcriptBody({ seq: "3", text: "Cut the release." });
    expect(soleBody(frame({ request: out, response: null }))).toBe(out);
    const back = transcriptBody({ seq: "4", text: "Cutting it." });
    expect(soleBody(frame({ request: null, response: back }))).toBe(back);
    expect(soleBody(frame({ request: null, response: null }))).toBeNull();
  });

  it("reads no body from an entry that carries both halves, since neither alone is the entry's (negative)", () => {
    expect(
      soleBody(
        frame({
          request: transcriptBody({ seq: "3", text: "asked" }),
          response: transcriptBody({ seq: "4", text: "answered" }),
        }),
      ),
    ).toBeNull();
  });
});

describe("rowsOf", () => {
  it("draws no row for a turn, which is a group of steps (negative)", () => {
    expect(rowsOf(frame({ node: null, kind: "turn" }))).toEqual([]);
  });
});
