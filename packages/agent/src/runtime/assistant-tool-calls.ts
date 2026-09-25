/**
 * The tool calls behind one assistant reply, as `ask_assistant` returns them
 * and as `get_conversation` reads them back (#4161). The run's tool receipts
 * are the record of what the turn called, so the list is read from them, in
 * the order the recorder saw them. `ask_assistant` builds it from the turn's
 * own receipts. `get_conversation` builds it from the same calls read back
 * from the run ledger, so a restored reply lists what the live one listed.
 *
 * A parked call's receipt says `parked` and carries the approval's public id
 * (#4196). That is the id the reply's parked card holds, so the flyout can
 * point the list entry and the card at the same approval. Both places that
 * park a call name the public id, so the receipt's own id is the only source.
 */
import type {
  AssistantToolCall,
  AssistantToolCallOutcome,
} from "@oxagen/oxagen/contracts/assistant.ask";
import type { RunToolCallRecord } from "@oxagen/run-ledger";

/**
 * The fields of one tool receipt the list reads. A turn's own receipts
 * (`AssistantRunReceipt`) carry these and more, and a call read back from the
 * ledger is mapped onto them, so both paths share one builder.
 */
export interface ToolCallReceipt {
  kind: "tool";
  requestId: string;
  toolName: string;
  outcome: AssistantToolCallOutcome;
  durationMs: number;
  approvalPublicId?: string;
}

/**
 * Each tool receipt as one entry of the reply's `toolCalls`. Only a parked
 * call has an approval id, and it is the receipt's public id. A parked receipt
 * with no public id reads `null`, as does every other outcome. A receipt of
 * any other kind, such as a model call, is skipped.
 */
export function toolCallsFromReceipts(
  receipts: readonly (ToolCallReceipt | { kind: "model" })[],
): AssistantToolCall[] {
  const calls: AssistantToolCall[] = [];
  for (const receipt of receipts) {
    if (receipt.kind !== "tool") continue;
    calls.push({
      toolCallId: receipt.requestId,
      toolName: receipt.toolName,
      outcome: receipt.outcome,
      durationMs: Math.max(0, Math.round(receipt.durationMs)),
      approvalId:
        receipt.outcome === "parked"
          ? (receipt.approvalPublicId ?? null)
          : null,
    });
  }
  return calls;
}

/**
 * The tool calls of a reply read back from its run, as `get_conversation`
 * returns them. The ledger frame keeps a parked call's approval public id, so
 * a restored reply names the same approval the live one named.
 */
export function toolCallsFromLedger(
  records: readonly RunToolCallRecord[],
): AssistantToolCall[] {
  return toolCallsFromReceipts(
    records.map(
      (record): ToolCallReceipt => ({
        kind: "tool",
        requestId: record.toolCallId,
        toolName: record.toolName,
        outcome: record.outcome,
        durationMs: record.durationMs,
        ...(record.approvalPublicId === null
          ? {}
          : { approvalPublicId: record.approvalPublicId }),
      }),
    ),
  );
}
