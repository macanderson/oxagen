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
 * point the list entry and the card at the same approval.
 */
import type {
  AssistantParkedCard,
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
  error?: string;
}

/**
 * Each tool receipt as one entry of the reply's `toolCalls`. Only a parked
 * call has an approval id; every other outcome reads `null`. A receipt of any
 * other kind, such as a model call, is skipped.
 */
export function toolCallsFromReceipts(
  receipts: readonly (ToolCallReceipt | { kind: "model" })[],
  parkedCards: readonly AssistantParkedCard[],
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
          ? parkedApprovalId(receipt, parkedCards)
          : null,
    });
  }
  return calls;
}

/**
 * The approval a parked receipt waits on. The receipt's public id comes
 * first. A writer that returned no public id leaves the receipt without one,
 * and the card then holds the row uuid instead. `ApprovalPendingError` names
 * that uuid in the receipt's error, so the card whose id appears there as a
 * whole word is this call's card.
 */
function parkedApprovalId(
  receipt: ToolCallReceipt,
  parkedCards: readonly AssistantParkedCard[],
): string | null {
  if (receipt.approvalPublicId !== undefined) return receipt.approvalPublicId;
  if (receipt.error === undefined) return null;
  const words = new Set(receipt.error.split(/\s+/));
  return (
    parkedCards.find((card) => words.has(card.approvalId))?.approvalId ?? null
  );
}

/**
 * The tool calls of a reply read back from its run, as `get_conversation`
 * returns them. The ledger frame keeps a parked call's approval public id but
 * not its error text, which lives in the frame body. So a parked call whose
 * frame names no approval reads `approvalId: null`, where the live reply
 * could still match its card by the row uuid in the error.
 */
export function toolCallsFromLedger(
  records: readonly RunToolCallRecord[],
  parkedCards: readonly AssistantParkedCard[],
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
    parkedCards,
  );
}
