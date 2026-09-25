/**
 * The tool calls behind one assistant reply, as `ask_assistant` returns them
 * (#4161). The run's tool receipts are the record of what the turn called, so
 * the list is read from them, in the order the recorder saw them.
 *
 * A parked call's receipt says `parked` and carries the approval's public id
 * (#4196). That is the id the reply's parked card holds, so the flyout can
 * point the list entry and the card at the same approval.
 */
import type {
  AssistantParkedCard,
  AssistantToolCall,
} from "@oxagen/oxagen/contracts/assistant.ask";
import type { AssistantRunReceipt } from "./assistant-run";

type ToolReceipt = Extract<AssistantRunReceipt, { kind: "tool" }>;

/**
 * Each tool receipt as one entry of the reply's `toolCalls`. Only a parked
 * call has an approval id; every other outcome reads `null`.
 */
export function toolCallsFromReceipts(
  receipts: readonly AssistantRunReceipt[],
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
  receipt: ToolReceipt,
  parkedCards: readonly AssistantParkedCard[],
): string | null {
  if (receipt.approvalPublicId !== undefined) return receipt.approvalPublicId;
  if (receipt.error === undefined) return null;
  const words = new Set(receipt.error.split(/\s+/));
  return (
    parkedCards.find((card) => words.has(card.approvalId))?.approvalId ?? null
  );
}
