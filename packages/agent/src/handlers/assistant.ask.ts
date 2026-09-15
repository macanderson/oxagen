// ask_assistant: one turn of the in-app agent. Every adapter reaches the turn
// through the kernel and this handler: the API route and the MCP tool run it
// to completion, and the SSE route streams it with the hooks it carries beside
// the invoke (`streamAssistantTurn`). The contract's gates run once, the same
// way, on all three. The stream is what names the surface: `POST /chat/stream`
// is the app's one transport and the only caller that carries one, so a
// streamed turn is admitted on `chat` and every other turn on `api-chat`.
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
import { takeAssistantStream } from "../runtime/assistant-stream";
import {
  AssistantTurnNeedsUserError,
  ConversationNotFoundError,
  prepareAssistantTurn,
} from "../runtime/assistant-turn";
import type { CapabilityContext } from "../types";

export async function assistantAskHandler(
  input: AssistantAskInput,
  ctx: CapabilityContext,
): Promise<AssistantAskOutput> {
  const stream = takeAssistantStream();
  const slugs = await resolveSlugs(ctx);
  try {
    const prepared = await prepareAssistantTurn({
      ctx,
      surface: stream ? "chat" : "api-chat",
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
      parkedCard: result.parkedCard,
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
