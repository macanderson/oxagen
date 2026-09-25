import { describe, expect, it } from "vitest";
import type { AssistantRunReceipt } from "./assistant-run";
import { toolCallsFromReceipts } from "./assistant-tool-calls";

const APPROVAL = "0a1b2c3d-0000-4000-8000-00000000a001";
const OTHER_APPROVAL = "0a1b2c3d-0000-4000-8000-00000000a002";

const card = (approvalId: string, capability = "set_budget") => ({
  approvalId,
  capability,
  expiresAt: "2026-09-24T10:05:00.000Z",
});

/** The error `ApprovalPendingError` carries onto the receipt of a parked call. */
const parkedError = (capability: string, approvalId: string) =>
  `refused: ${capability} is waiting for approval ${approvalId} until 2026-09-24T10:05:00.000Z`;

type ToolReceipt = Extract<AssistantRunReceipt, { kind: "tool" }>;

/**
 * A tool receipt. `outcome` is a plain string so the `parked` outcome #4196
 * adds to the ledger's union can be written before that change lands.
 */
function tool(
  over: Partial<Omit<ToolReceipt, "outcome">> & { outcome?: string },
): AssistantRunReceipt {
  return {
    kind: "tool",
    seq: 2,
    requestId: "tc-1",
    toolName: "list_runs",
    outcome: "completed",
    input: {},
    durationMs: 12,
    ...over,
  } as AssistantRunReceipt;
}

const model: AssistantRunReceipt = {
  kind: "model",
  seq: 1,
  requestId: "mc-1",
  role: "worker",
  provider: "anthropic",
  model: "claude",
  outcome: "completed",
} as AssistantRunReceipt;

describe("toolCallsFromReceipts", () => {
  it("lists each tool receipt in order with its outcome and whole-millisecond duration, and skips completions", () => {
    const calls = toolCallsFromReceipts(
      [
        model,
        tool({ requestId: "tc-1", toolName: "list_runs", durationMs: 12.6 }),
        tool({
          requestId: "tc-2",
          toolName: "get_run",
          outcome: "failed",
          error: "run not found",
          durationMs: 3,
        }),
        tool({
          requestId: "tc-3",
          toolName: "search_tools",
          outcome: "cancelled",
          durationMs: -1,
        }),
      ],
      [],
    );
    expect(calls).toEqual([
      {
        toolCallId: "tc-1",
        toolName: "list_runs",
        outcome: "completed",
        durationMs: 13,
        approvalId: null,
      },
      {
        toolCallId: "tc-2",
        toolName: "get_run",
        outcome: "failed",
        durationMs: 3,
        approvalId: null,
      },
      {
        toolCallId: "tc-3",
        toolName: "search_tools",
        outcome: "cancelled",
        durationMs: 0,
        approvalId: null,
      },
    ]);
  });

  it("reads a denied receipt whose error names a parked card's approval as parked, with that approval", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          requestId: "tc-1",
          toolName: "set_budget",
          outcome: "denied",
          error: parkedError("set_budget", APPROVAL),
        }),
      ],
      [card(APPROVAL)],
    );
    expect(calls).toEqual([
      {
        toolCallId: "tc-1",
        toolName: "set_budget",
        outcome: "parked",
        durationMs: 12,
        approvalId: APPROVAL,
      },
    ]);
  });

  it("keeps a policy denial denied beside a parked call of the same tool (negative)", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          requestId: "tc-1",
          toolName: "set_budget",
          outcome: "denied",
          error: "refused: set_budget blocked by a decision rule",
        }),
        tool({
          requestId: "tc-2",
          toolName: "set_budget",
          outcome: "denied",
          error: parkedError("set_budget", APPROVAL),
        }),
      ],
      [card(APPROVAL)],
    );
    expect(calls.map((c) => [c.toolCallId, c.outcome, c.approvalId])).toEqual([
      ["tc-1", "denied", null],
      ["tc-2", "parked", APPROVAL],
    ]);
  });

  it("gives each parked call its own approval when a turn parks two", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          requestId: "tc-1",
          toolName: "set_budget",
          outcome: "denied",
          error: parkedError("set_budget", OTHER_APPROVAL),
        }),
        tool({
          requestId: "tc-2",
          toolName: "set_budget",
          outcome: "denied",
          error: parkedError("set_budget", APPROVAL),
        }),
      ],
      [card(APPROVAL), card(OTHER_APPROVAL)],
    );
    expect(calls.map((c) => c.approvalId)).toEqual([OTHER_APPROVAL, APPROVAL]);
  });

  it("never reads a completed or failed receipt as parked, whatever its error says (negative)", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          requestId: "tc-1",
          outcome: "failed",
          error: parkedError("set_budget", APPROVAL),
        }),
      ],
      [card(APPROVAL)],
    );
    expect(calls[0]).toMatchObject({ outcome: "failed", approvalId: null });
  });

  it("matches the approval id as a whole word, not a prefix (negative)", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          outcome: "denied",
          error: parkedError("set_budget", `${APPROVAL}-9`),
        }),
      ],
      [card(APPROVAL)],
    );
    expect(calls[0]).toMatchObject({ outcome: "denied", approvalId: null });
  });

  it("reads a receipt the ledger already records as parked (#4196) with its card's approval", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          toolName: "set_budget",
          outcome: "parked",
          error: parkedError("set_budget", APPROVAL),
        }),
      ],
      [card(APPROVAL)],
    );
    expect(calls[0]).toMatchObject({
      outcome: "parked",
      approvalId: APPROVAL,
    });
  });
});
