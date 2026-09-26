// The Governed actions tab's derivations, without a render: what kind a frame
// is, how it went, where its tick sits, which turn band and mark it gets,
// which frame is open and where ◀ and ▶ lead, and which approval frame
// records which approval.
import { describe, expect, it } from "vitest";
import type { RunTranscript } from "@/data/contracts/run";
import { readError, readOk } from "@/data/read";
import {
  decidedRelease,
  parkedRelease,
  releaseAt,
  releaseFrames,
  releaseTranscript,
} from "./actions-tab.builders";
import {
  entriesBySeq,
  isApprovalFrame,
  isParked,
  kindCounts,
  kindOf,
  markOf,
  matchApprovals,
  openFrameOf,
  runStateOf,
  stepsOf,
  tickPositions,
  timelineMarks,
  turnBands,
} from "./player-model";
import { runFrame, runRow, transcriptEntry } from "./run.builders";

const frames = releaseFrames();
const entries = entriesBySeq(readOk(releaseTranscript()));

describe("kindOf", () => {
  it.each([
    ["model.request", "model"],
    ["model.call_completed", "model"],
    ["llm_call", "model"],
    ["tool_requested", "tool"],
    ["tool.engine_call_completed", "tool"],
    ["policy_decision", "gov"],
    ["token_issued", "gov"],
    ["approval_request", "gov"],
    ["context.assembled", "ctx"],
    ["steering.manifest", "ctx"],
    ["control.steer", "op"],
    ["oxagen:command_applied", "op"],
    ["agent_start", "life"],
    ["turn_end", "life"],
  ])("files %s under %s", (type, kind) => {
    expect(kindOf(type)).toBe(kind);
  });

  it("counts the page's frames by kind in the legend's order, leaving out a kind with none", () => {
    expect(kindCounts(frames)).toEqual([
      { kind: "model", count: 6 },
      { kind: "tool", count: 3 },
      { kind: "gov", count: 4 },
      { kind: "ctx", count: 1 },
      { kind: "op", count: 1 },
      { kind: "life", count: 1 },
    ]);
    expect(kindCounts([runFrame({ type: "tool_call" })])).toEqual([
      { kind: "tool", count: 1 },
    ]);
  });
});

describe("markOf", () => {
  it("gives a decision the hue of what was decided, and a decision it did not carry a quiet one", () => {
    expect(markOf("policy_decision", "allow")).toBe("allowed");
    expect(markOf("policy_decision", "deny")).toBe("denied");
    expect(markOf("policy_decision", "ask")).toBe("approval");
    expect(markOf("approval_decision", "defer")).toBe("approval");
    expect(markOf("policy_decision", null)).toBe("quiet");
  });

  it("marks a request, an operator command and a tool frame, and nothing else", () => {
    expect(markOf("approval_request", null)).toBe("approval");
    expect(markOf("control.steer", null)).toBe("proven");
    expect(markOf("oxagen:command_applied", null)).toBe("proven");
    expect(markOf("tool_call", null)).toBe("quiet");
    expect(markOf("model.response", null)).toBeNull();
  });

  it("counts the request and a decision that asked as needing a person, and an allow as not", () => {
    expect(isParked("approval_request", null)).toBe(true);
    expect(isParked("policy_decision", "ask")).toBe(true);
    expect(isParked("policy_decision", "allow")).toBe(false);
    expect(isParked("policy_decision", null)).toBe(false);
  });

  it("reads a call whose receipt says it parked as needing a person, and a denied one as not", () => {
    const receipt = "tool.engine_call_completed";
    expect(isParked(receipt, null, "parked")).toBe(true);
    expect(isParked(receipt, null, "denied")).toBe(false);
    expect(isParked(receipt, null)).toBe(false);
    expect(markOf(receipt, null, "parked")).toBe("approval");
    expect(markOf(receipt, null, "completed")).toBeNull();
    expect(isApprovalFrame(receipt, "parked")).toBe(true);
    expect(isApprovalFrame(receipt, "completed")).toBe(false);
  });

  // ADR-182 rule 3: the Player reads the frame's fields, never its label. A
  // label that says "parked" on a frame whose recorded status does not is
  // not a parked call.
  it("reads nothing out of a frame's label (negative)", () => {
    const receipt = "tool.engine_call_completed";
    expect(isParked(receipt, null, "completed")).toBe(false);
    expect(markOf(receipt, null, null)).toBeNull();
    expect(isApprovalFrame(receipt, null)).toBe(false);
    const labelOnly = runFrame({
      seq: "14",
      cursor: "14",
      type: receipt,
      summary: "create_tag parked apr_early",
      tool: null,
      toolStatus: null,
      approvalId: null,
      observedAt: releaseAt(14),
    });
    expect(
      matchApprovals(
        [labelOnly],
        [parkedRelease({ id: "apr_early", tool: "create_tag" })],
      ).matched.size,
    ).toBe(0);
  });
});

describe("tickPositions", () => {
  it("places ticks by their instants, at least 1.7% apart, inside 97% of the track", () => {
    const xs = tickPositions(frames);
    expect(xs).toHaveLength(16);
    expect(xs[0]).toBe(0);
    // Pushed apart, the ticks ran past 97% and the whole was scaled back in.
    for (let i = 1; i < xs.length; i++)
      expect(xs[i] ?? 0).toBeGreaterThan(xs[i - 1] ?? 0);
    expect(xs.at(-1)).toBeCloseTo(97);
  });

  it("still spaces frames recorded in the same instant", () => {
    const same = [
      runFrame({ seq: "1", cursor: "a" }),
      runFrame({ seq: "2", cursor: "b" }),
    ];
    expect(tickPositions(same)).toEqual([0, 1.7]);
    expect(tickPositions([])).toEqual([]);
  });
});

describe("turnBands", () => {
  it("draws one band per stretch of frames the transcript placed in a turn, marking the one a steer opens", () => {
    const xs = tickPositions(frames);
    const bands = turnBands(frames, xs, entries);
    expect(bands.map((band) => [band.turn, band.alt, band.afterSteer])).toEqual(
      [
        [1, false, false],
        [2, true, true],
      ],
    );
    // Frames 0 and 1 fall before the first turn, so no band sits behind them.
    expect(bands[0]?.left).toBeCloseTo((xs[2] ?? 0) - 1.2);
    expect((bands[1]?.left ?? 0) + (bands[1]?.width ?? 0)).toBe(100);
  });

  it("draws no band for frames the transcript did not carry (negative)", () => {
    const xs = tickPositions(frames);
    expect(turnBands(frames, xs, new Map())).toEqual([]);
    expect(turnBands(frames, xs, entriesBySeq(readError("down", 503)))).toEqual(
      [],
    );
  });

  it("leaves a subagent's entries out, since its seq names a frame of another chain", () => {
    const transcript: RunTranscript = {
      ...releaseTranscript(),
      entries: [
        transcriptEntry({
          seq: "3",
          turn: 9,
          subagent: { chainRef: "sess_b", type: null },
        }),
      ],
    };
    expect(entriesBySeq(readOk(transcript)).size).toBe(0);
  });
});

describe("timelineMarks", () => {
  it("marks the steer, and marks a decision that asked and the request beside it once", () => {
    const xs = tickPositions(frames);
    const marks = timelineMarks(frames, xs, entries);
    expect(marks.map((mark) => mark.kind)).toEqual(["steer", "parked"]);
    expect(marks[1]?.at).toBe(xs[14]);
  });
});

describe("openFrameOf and stepsOf", () => {
  it("opens the first frame shown when the URL names none, or names something that is not a seq", () => {
    expect(openFrameOf(frames, null)).toMatchObject({
      seq: "0",
      index: 0,
      named: false,
    });
    expect(openFrameOf(frames, "../etc")).toMatchObject({ seq: "0", index: 0 });
    expect(openFrameOf([], null)).toBeNull();
  });

  it("steps to the neighbours on the page and ends at its edges", () => {
    const open = openFrameOf(frames, "0");
    if (open === null) throw new Error("no frame");
    expect(stepsOf(frames, open)).toEqual({
      first: "0",
      prev: null,
      next: "1",
      last: "15",
    });
  });

  it("steps from a frame the page does not hold to the nearest shown frames, reading seqs as numbers", () => {
    const page = ["8", "9", "10", "100"].map((seq) =>
      runFrame({ seq, cursor: seq }),
    );
    const open = openFrameOf(page, "11");
    expect(open).toMatchObject({
      seq: "11",
      index: -1,
      frame: null,
      named: true,
    });
    if (open === null) throw new Error("no frame");
    expect(stepsOf(page, open)).toMatchObject({ prev: "10", next: "100" });
    const before = openFrameOf(page, "2");
    if (before === null) throw new Error("no frame");
    expect(stepsOf(page, before)).toMatchObject({ prev: null, next: "8" });
  });
});

describe("runStateOf", () => {
  it("reads live, paused, sealed and halted as recorded", () => {
    expect(runStateOf(runRow({ status: "live" }))).toBe("live");
    expect(runStateOf(runRow({ status: "live", ingressPaused: true }))).toBe(
      "paused",
    );
    expect(runStateOf(runRow({ status: "sealed" }))).toBe("sealed");
    expect(runStateOf(runRow({ status: "halted" }))).toBe("halted");
  });
});

describe("matchApprovals", () => {
  it("ties the request frame that names the approval's tool to it", () => {
    const parked = parkedRelease();
    const { byFrame, matched } = matchApprovals(frames, [parked]);
    expect(byFrame.get("15")).toBe(parked);
    expect([...matched]).toEqual([parked.id]);
    expect(isApprovalFrame("approval_request")).toBe(true);
    expect(isApprovalFrame("policy_decision")).toBe(false);
  });

  it("pairs the closest instants first when two calls to one tool parked", () => {
    const page = [
      runFrame({
        seq: "4",
        cursor: "4",
        type: "approval_request",
        summary: "approval_request create_tag",
        tool: "create_tag",
        observedAt: releaseAt(4),
      }),
      runFrame({
        seq: "14",
        cursor: "14",
        type: "approval_request",
        summary: "approval_request create_tag",
        tool: "create_tag",
        observedAt: releaseAt(14),
      }),
    ];
    const late = parkedRelease({
      id: "apr_late",
      tool: "create_tag",
      createdAt: releaseAt(14),
    });
    const early = parkedRelease({
      id: "apr_early",
      tool: "create_tag",
      createdAt: releaseAt(4),
    });
    const { byFrame } = matchApprovals(page, [late, early]);
    expect(byFrame.get("4")?.id).toBe("apr_early");
    expect(byFrame.get("14")?.id).toBe("apr_late");
  });

  it("ties a decision frame by when the call was decided, beside its request", () => {
    const decided = decidedRelease();
    const decision = runFrame({
      seq: "16",
      cursor: "16",
      type: "approval_decision",
      summary: "allow github__create_release",
      tool: "github__create_release",
      observedAt: decided.resolvedAt,
    });
    const { byFrame } = matchApprovals([...frames, decision], [decided]);
    expect(byFrame.get("15")).toBe(decided);
    expect(byFrame.get("16")).toBe(decided);
  });

  it("ties the assistant's parked receipt to the approval it names, ahead of a closer instant", () => {
    // Two parked `create_tag` calls. The receipt at 14 names the EARLY
    // approval, so a match by instant would pair it with the wrong card.
    const page = [
      runFrame({
        seq: "14",
        cursor: "14",
        type: "tool.engine_call_completed",
        summary: "create_tag parked",
        tool: "create_tag",
        toolStatus: "parked",
        approvalId: "apr_early",
        observedAt: releaseAt(14),
      }),
    ];
    const late = parkedRelease({
      id: "apr_late",
      tool: "create_tag",
      createdAt: releaseAt(14),
    });
    const early = parkedRelease({
      id: "apr_early",
      tool: "create_tag",
      createdAt: releaseAt(4),
    });
    const { byFrame, matched } = matchApprovals(page, [late, early]);
    expect(byFrame.get("14")?.id).toBe("apr_early");
    expect([...matched]).toEqual(["apr_early"]);
    // A receipt that names no approval pairs by tool and instant.
    const unnamed = runFrame({
      seq: "14",
      cursor: "14",
      type: "tool.engine_call_completed",
      summary: "create_tag parked",
      tool: "create_tag",
      toolStatus: "parked",
      observedAt: releaseAt(14),
    });
    expect(matchApprovals([unnamed], [late, early]).byFrame.get("14")?.id).toBe(
      "apr_late",
    );
    // A denied receipt is no approval frame at all.
    const denied = runFrame({
      seq: "14",
      cursor: "14",
      type: "tool.engine_call_completed",
      summary: "create_tag denied",
      tool: "create_tag",
      toolStatus: "denied",
      observedAt: releaseAt(14),
    });
    expect(matchApprovals([denied], [late, early]).matched.size).toBe(0);
  });

  it("matches nothing to a frame that names no tool, or another tool (negative)", () => {
    const ledger = runFrame({
      seq: "3",
      cursor: "3",
      type: "tool.approval_recorded",
      summary: "tool.approval_recorded",
    });
    expect(matchApprovals([ledger], [parkedRelease()]).matched.size).toBe(0);
    expect(
      matchApprovals(frames, [parkedRelease({ tool: "github__delete_repo" })])
        .matched.size,
    ).toBe(0);
    // A pending approval has no decision instant, so no decision frame takes it.
    const decision = runFrame({
      seq: "16",
      cursor: "16",
      type: "approval_decision",
      summary: "allow github__create_release",
      tool: "github__create_release",
    });
    expect(matchApprovals([decision], [parkedRelease()]).matched.size).toBe(0);
  });
});
