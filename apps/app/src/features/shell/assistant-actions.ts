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
// `readReplyCost` is the other half of a turn: what the run it was recorded as
// cost, read from that run's cost record on demand (#4167). It is a
// `kernelRead` here rather than a DataSource port because a "use server"
// feature module reads on demand through the kernel seam (ADR-089, ADR-167).
import { assistantAsk } from "@oxagen/oxagen/contracts/assistant.ask";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import type { Cost } from "@/data/contracts/money";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
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

/**
 * What one reply cost, as the run's cost record says it (`get_run_cost`).
 *
 * `pending`: no rollup has priced the run yet, so the cost is not known. It is
 * never a zero. `recorded`: the rollup has built the run's row. Its `cost` is
 * null when the rollup priced none of the run's model calls, and a zero only
 * when the calls it priced cost nothing.
 */
export type ReplyCost =
  | { kind: "pending" }
  | {
      kind: "recorded";
      /** The run's priced cost, with the basis the rollup recorded. */
      cost: Cost | null;
      /** The models the rollup priced, as the record names them. */
      models: readonly string[];
      /** The row was built while the run was open, so the figure may grow. */
      estimate: boolean;
      /** Some model call went unpriced, so `cost` covers only the priced ones. */
      incomplete: boolean;
    };

/**
 * Read what the turn recorded as `runId` cost, in the workspace it was asked
 * in. The flyout calls it once a reply lands and once more if the first read
 * came back pending (`use-reply-cost.ts`).
 */
export async function readReplyCost(
  org: string,
  ws: string,
  runId: string,
): Promise<ActionResult<ReplyCost>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: runCostGet,
    input: { runId },
    page: "shell",
  });
  if (!read.ok) return readToActionResult(read);
  const { rollup } = read.value;
  if (rollup === null) return { ok: true, value: { kind: "pending" } };
  return {
    ok: true,
    value: {
      kind: "recorded",
      cost: rollup.cost,
      models: rollup.byModel.map((row) => row.model),
      estimate: rollup.isEstimate,
      incomplete: rollup.byModel.some((row) => row.hasUnpriced),
    },
  };
}
