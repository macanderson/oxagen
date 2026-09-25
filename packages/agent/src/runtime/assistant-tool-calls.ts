/**
 * The tool calls behind one assistant reply, as `ask_assistant` returns them
 * (#4161). The run's tool receipts are the record of what the turn called, so
 * the list is read from them, in the order the recorder saw them.
 *
 * A parked call is recorded as `denied` today: the engine is told
 * `refused_by_policy`, because its error vocabulary has no wait. The turn
 * still knows which calls parked, through the cards `onApprovalRequired`
 * collected, and each parked call's error names its approval id
 * (`ApprovalPendingError`). A receipt whose error carries a card's approval
 * id is that card's call, so it reads as `parked` with the card's id. A
 * receipt that already says `parked` (#4196) is read the same way.
 */
import type {
  AssistantParkedCard,
  AssistantToolCall,
  AssistantToolCallOutcome,
} from "@oxagen/oxagen/contracts/assistant.ask";
import type { AssistantRunReceipt } from "./assistant-run";

type ToolReceipt = Extract<AssistantRunReceipt, { kind: "tool" }>;

/**
 * The recorded outcomes a parked call can carry: `denied` on main, `parked`
 * once #4196 lands. A set rather than two comparisons, because the compiler
 * narrows `receipt.outcome` to the ledger's union and refuses a comparison
 * with `parked` while that union lacks it.
 */
const MAY_BE_PARKED: ReadonlySet<AssistantToolCallOutcome> = new Set([
  "denied",
  "parked",
]);

/**
 * Each tool receipt as one entry of the reply's `toolCalls`.
 *
 * A card is claimed by one receipt at most, so two calls cannot both point
 * at the same approval. A denied receipt that no card names stays `denied`.
 */
export function toolCallsFromReceipts(
  receipts: readonly AssistantRunReceipt[],
  parkedCards: readonly AssistantParkedCard[],
): AssistantToolCall[] {
  const unclaimed = [...parkedCards];
  const calls: AssistantToolCall[] = [];
  for (const receipt of receipts) {
    if (receipt.kind !== "tool") continue;
    // Widened to the outcomes `ask_assistant` names: the ledger's union
    // gains `parked` in #4196, and this reads correctly on either side of it.
    const recorded: AssistantToolCallOutcome = receipt.outcome;
    const card = MAY_BE_PARKED.has(recorded)
      ? claimCard(unclaimed, receipt)
      : undefined;
    calls.push({
      toolCallId: receipt.requestId,
      toolName: receipt.toolName,
      outcome: card === undefined ? recorded : "parked",
      durationMs: Math.max(0, Math.round(receipt.durationMs)),
      approvalId: card?.approvalId ?? null,
    });
  }
  return calls;
}

/** Take the card whose approval id the receipt's error names, if any. */
function claimCard(
  unclaimed: AssistantParkedCard[],
  receipt: ToolReceipt,
): AssistantParkedCard | undefined {
  if (receipt.error === undefined) return undefined;
  const words = new Set(receipt.error.split(/\s+/));
  const at = unclaimed.findIndex((card) => words.has(card.approvalId));
  if (at === -1) return undefined;
  const [card] = unclaimed.splice(at, 1);
  return card;
}
