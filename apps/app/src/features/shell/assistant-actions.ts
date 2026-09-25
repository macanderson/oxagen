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
//
// The flyout names each turn with a `turnId` it mints, so the person can stop
// it (#4164). The stop does not travel through this module: the question is
// itself a pending action, and a page's actions run one at a time, so a stop
// sent as a second action would wait for the turn it means to end. It posts
// to the `assistant/stop` route instead, which calls `stopAssistantTurn` here.
import { assistantAsk } from "@oxagen/oxagen/contracts/assistant.ask";
import { assistantTurnCancel } from "@oxagen/oxagen/contracts/assistant.turn.cancel";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** A governed write the turn parked, waiting on a person. */
export type ParkedCard = {
  approvalId: string;
  capability: string;
  expiresAt: string;
};

export type AssistantTurn = {
  conversationId: string;
  /** `arun_…`: the run this turn was recorded as; the Run page opens it. */
  runId: string;
  reply: string;
  parkedCards: readonly ParkedCard[];
  /** The person stopped the turn; `reply` is what was written before the stop. */
  stopped: boolean;
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
 *
 * `turnId` is a uuid the caller mints for the turn, so `stopAssistantTurn`
 * can name it while it runs.
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
    turnId?: string;
  },
): Promise<ActionResult<AssistantTurn>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, assistantAsk, {
    conversationId: input.conversationId,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
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

/**
 * Stop the viewer's own turn that `askAssistant` is still running under
 * `turnId` (#4164). `found` is false when no such turn is running: it ended,
 * it was already stopped, or it has not started yet, in which case the stop
 * is held and applied when it does. Only the person who asked can stop a
 * turn, so another person's `turnId` also answers `found: false`.
 */
export async function stopAssistantTurn(
  org: string,
  ws: string,
  turnId: string,
): Promise<ActionResult<{ turnId: string; found: boolean }>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, assistantTurnCancel, { turnId });
}
