import { describe, expect, it } from "vitest";
import type { AssistantRunReceipt } from "./assistant-run";
import { toolCallsFromReceipts } from "./assistant-tool-calls";

const PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w0";
const ROW_ID = "0a1b2c3d-0000-4000-8000-00000000a001";
const OTHER_ROW_ID = "0a1b2c3d-0000-4000-8000-00000000a002";

const card = (approvalId: string, capability = "set_budget") => ({
  approvalId,
  capability,
  expiresAt: "2026-09-24T10:05:00.000Z",
});

/**
 * The error `ApprovalPendingError` carries onto the receipt of a parked call.
 * It names the public id, or the row uuid when the writer returned none.
 */
const parkedError = (capability: string, approvalId: string) =>
  `refused: ${capability} is waiting for approval ${approvalId} until 2026-09-24T10:05:00.000Z`;

type ToolReceipt = Extract<AssistantRunReceipt, { kind: "tool" }>;

function tool(over: Partial<ToolReceipt>): AssistantRunReceipt {
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
        tool({
          requestId: "tc-4",
          toolName: "retire_agent",
          outcome: "denied",
          error: "refused: retire_agent blocked by a decision rule",
          durationMs: 1,
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
      {
        toolCallId: "tc-4",
        toolName: "retire_agent",
        outcome: "denied",
        durationMs: 1,
        approvalId: null,
      },
    ]);
  });

  it("reads a parked receipt with the approval's public id, the id its card holds", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          toolName: "set_budget",
          outcome: "parked",
          approvalPublicId: PUBLIC_ID,
          error: parkedError("set_budget", PUBLIC_ID),
        }),
      ],
      [card(PUBLIC_ID)],
    );
    expect(calls).toEqual([
      {
        toolCallId: "tc-1",
        toolName: "set_budget",
        outcome: "parked",
        durationMs: 12,
        approvalId: PUBLIC_ID,
      },
    ]);
  });

  it("keeps the public id when no card was collected for the call", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          outcome: "parked",
          approvalPublicId: PUBLIC_ID,
          error: parkedError("set_budget", PUBLIC_ID),
        }),
      ],
      [],
    );
    expect(calls[0]).toMatchObject({
      outcome: "parked",
      approvalId: PUBLIC_ID,
    });
  });

  it("falls back to the card whose row uuid the error names when the receipt has no public id", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          requestId: "tc-1",
          outcome: "parked",
          error: parkedError("set_budget", OTHER_ROW_ID),
        }),
        tool({
          requestId: "tc-2",
          outcome: "parked",
          error: parkedError("set_budget", ROW_ID),
        }),
      ],
      [card(ROW_ID), card(OTHER_ROW_ID)],
    );
    expect(calls.map((c) => [c.toolCallId, c.approvalId])).toEqual([
      ["tc-1", OTHER_ROW_ID],
      ["tc-2", ROW_ID],
    ]);
  });

  it("matches the row uuid as a whole word, not a prefix (negative)", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          outcome: "parked",
          error: parkedError("set_budget", `${ROW_ID}-9`),
        }),
      ],
      [card(ROW_ID)],
    );
    expect(calls[0]).toMatchObject({ outcome: "parked", approvalId: null });
  });

  it("gives no approval id to a denied or failed receipt, whatever its error says (negative)", () => {
    const calls = toolCallsFromReceipts(
      [
        tool({
          requestId: "tc-1",
          outcome: "denied",
          error: parkedError("set_budget", ROW_ID),
        }),
        tool({
          requestId: "tc-2",
          outcome: "failed",
          approvalPublicId: PUBLIC_ID,
          error: parkedError("set_budget", ROW_ID),
        }),
      ],
      [card(ROW_ID), card(PUBLIC_ID)],
    );
    expect(calls.map((c) => [c.outcome, c.approvalId])).toEqual([
      ["denied", null],
      ["failed", null],
    ]);
  });
});
