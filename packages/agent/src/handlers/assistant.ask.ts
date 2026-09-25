// ask_assistant: one turn of the in-app agent. Every adapter reaches the turn
// through the kernel and this handler: the API route and the MCP tool run it
// to completion, the SSE route streams it with the hooks it carries beside the
// invoke (`streamAssistantTurn`), and the app's shell flyout invokes it from a
// Server Action through `kernelWrite`. The contract's gates run once, the same
// way, on all four.
//
// The turn's surface is the app, not the transport. `chat` means "a person
// asked this in the product" and `api-chat` means "a caller asked it over the
// API or MCP"; the run row, both message rows and the AI telemetry
// (`assistant-turn.ts` maps `chat` to the `app` telemetry surface) are keyed
// on it, and `list_runs` excludes both of them from the customer's own runs.
// A stream is one way for the app to arrive and `ctx.surface === "app"` is
// the other, so the surface is read from both. Reading only the stream
// attributed every flyout turn as an API turn — a ledger that looks complete
// and is wrong, which is worse than one that is missing.
//
// The kernel enters the tenant scope before this runs; the turn re-enters it
// around each store call because the engine's reverse requests arrive on the
// engine's clock, outside this request's scope. The turn runs outside this
// invoke's governed-action frame: the turn is not a governed action
// (`noBillingGate`), and each tool call it answers is one (ADR-053 §1).
import type {
  AssistantAskInput,
  AssistantAskOutput,
} from "@oxagen/oxagen/contracts/assistant.ask";
import { HandlerError } from "@oxagen/oxagen";
import { runOutsideGovernedAction } from "@oxagen/oxagen/kernel";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import type { AssistantRunSurface } from "../runtime/assistant-run";
import { takeAssistantStream } from "../runtime/assistant-stream";
import {
  AssistantStoppedError,
  AssistantTurnNeedsUserError,
  ConversationNotFoundError,
  prepareAssistantTurn,
} from "../runtime/assistant-turn";
import type { CapabilityContext } from "../types";

/**
 * The surface a turn is recorded on: `chat` when the app asked it — over the
 * SSE transport (which carries a stream) or from a Server Action (which
 * carries `surface: "app"`) — and `api-chat` for every caller outside it.
 */
function runSurfaceOf(
  ctx: CapabilityContext,
  streamed: boolean,
): AssistantRunSurface {
  return streamed || ctx.surface === "app" ? "chat" : "api-chat";
}

export async function assistantAskHandler(
  input: AssistantAskInput,
  ctx: CapabilityContext,
): Promise<AssistantAskOutput> {
  const stream = takeAssistantStream();
  const slugs = await resolveSlugs(ctx);
  try {
    const prepared = await prepareAssistantTurn({
      ctx,
      surface: runSurfaceOf(ctx, stream !== null),
      orgSlug: slugs.orgSlug,
      workspaceSlug: slugs.workspaceSlug,
      conversationId: input.conversationId,
      content: input.content,
      pageContext: input.pageContext,
      ...stream?.overrides,
    });
    stream?.onPrepared();
    const result = await runOutsideGovernedAction(() =>
      prepared.run(stream?.hooks),
    );
    return {
      conversationId: result.conversationId,
      userMessageId: result.userMessageId,
      assistantMessageId: result.assistantMessageId,
      runId: result.runId,
      reply: result.reply,
      parkedCards: result.parkedCards,
    };
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      throw new HandlerError({
        code: "not_found",
        reason: "conversation_not_found",
      });
    }
    if (err instanceof AssistantTurnNeedsUserError) {
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    }
    // An operator's `agent` kill switch on the assistant. Refused before
    // anything was written, with the switch and its reason in the message.
    if (err instanceof AssistantStoppedError) {
      throw new HandlerError({
        code: "forbidden",
        reason: "kill_switch",
        message: err.message,
      });
    }
    // Every other refusal keeps its own `code`, which the API's error
    // middleware maps: the credit gate's to 402, `engine_unavailable` and
    // `assistant_run_not_recorded` to 503, `engine_aborted` to 409.
    throw err;
  }
}

/** The slugs the system prompt names the scope by. */
async function resolveSlugs(
  ctx: CapabilityContext,
): Promise<{ orgSlug: string; workspaceSlug: string }> {
  return withTenantDb(async (tx) => {
    const [org] = await tx
      .select({ slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, ctx.orgId))
      .limit(1);
    const [ws] = await tx
      .select({ slug: schema.workspaces.slug })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .limit(1);
    return {
      orgSlug: org?.slug ?? ctx.orgId,
      workspaceSlug: ws?.slug ?? ctx.workspaceId,
    };
  });
}
