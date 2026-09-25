"use server";
// One turn with the in-app agent (#2968, ADR-053). `ask_assistant` records the
// turn as a run of its own, drives it on the assistant engine with every
// completion and tool call answered by Oxagen, and returns the reply whole —
// so a turn is one `kernelWrite`, not a stream. The contract is `mode: "async"`
// because the deprecated app streamed it over the chat SSE transport; rev1
// ships no second transport (ARCHITECTURE.md §1.2), and the handler returns the
// finished reply either way.
//
// Workspace-scoped, because the agent answers over one workspace's fleet record
// and knowledge graph. The shell mounts at organization scope, so the caller
// passes the workspace it is standing in and the flyout only offers the
// composer when there is one.
import { assistantAsk } from "@oxagen/oxagen/contracts/assistant.ask";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** A governed write the turn parked, waiting on a person. */
export type ParkedCard = {
  approvalId: string;
  capability: string;
  expiresAt: string;
};

/**
 * One tool call behind a reply (#4161). `parked` is a governed write waiting
 * on a person; `approvalId` names its approval, and is null for every other
 * outcome.
 */
export type ToolCallSummary = {
  toolCallId: string;
  toolName: string;
  outcome: "completed" | "failed" | "denied" | "cancelled" | "parked";
  durationMs: number;
  approvalId: string | null;
};

export type AssistantTurn = {
  conversationId: string;
  /** `arun_…`: the run this turn was recorded as; the Run page opens it. */
  runId: string;
  reply: string;
  parkedCards: readonly ParkedCard[];
  /** Every tool call the turn made, in the order it made them. */
  toolCalls: readonly ToolCallSummary[];
};

/**
 * Ask the in-app agent one question inside `ws`.
 *
 * `conversationId` null opens a new conversation; the id that comes back
 * continues it. `route` is where the person was standing when they asked —
 * the agent is being asked about what is on screen, so the page travels with
 * the question.
 *
 * `entityLabel` is the name the page gave the record `entityId` names (a
 * run's title, a runtime's hostname), so the agent can cite the record the
 * way the person sees it. The caller cuts it to the contract's cap. The turn
 * strips its control characters and quotes it as a label beside the id.
 */
export async function askAssistant(
  org: string,
  ws: string,
  input: {
    conversationId: string | null;
    content: string;
    route: string | null;
    entityId: string | null;
    entityLabel?: string | null;
  },
): Promise<ActionResult<AssistantTurn>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, assistantAsk, {
    conversationId: input.conversationId,
    content: input.content,
    pageContext:
      input.route === null
        ? null
        : {
            route: input.route,
            orgSlug: org,
            workspaceSlug: ws,
            entityId: input.entityId,
            entityLabel: input.entityLabel ?? null,
          },
  });
}
