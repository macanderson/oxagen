import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  generateObjectFor,
  selectModel,
  resolvePrompt,
  conversationTitlePrompt,
  loadWorkspacePromptConfig,
} from "@oxagen/ai";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";

/**
 * Generates a short title for a newly created conversation (fire-and-forget).
 * Uses the fast (Haiku) model since title generation is pure infrastructure.
 * Guards against overwriting an already-set title via the `isNull` predicate so
 * concurrent first-turn calls are idempotent.
 *
 * Best-effort by contract: any failure (model error, DB error) is swallowed so
 * title generation can never affect the chat turn the user is waiting on.
 */
export async function autoTitleConversation(opts: {
  conversationId: string;
  firstUserMessage: string;
  orgId: string;
  workspaceId: string;
  requestId: string;
}): Promise<void> {
  try {
    // Honor a workspace override/append for the (overridable) titler prompt.
    const promptConfig = await runInTenantScope(
      { orgId: opts.orgId, workspaceId: opts.workspaceId },
      () => loadWorkspacePromptConfig(opts.workspaceId),
    ).catch(() => ({}));
    const { object } = await generateObjectFor({
      schema: z.object({ title: z.string().max(80) }),
      model: selectModel({ tier: "fast" }),
      system: resolvePrompt({
        key: "conversation.title",
        baseline: conversationTitlePrompt(),
        config: promptConfig,
      }),
      prompt: opts.firstUserMessage.slice(0, 500),
      temperature: 0.3,
      telemetry: {
        orgId: opts.orgId,
        workspaceId: opts.workspaceId,
        surface: "app",
        messageId: opts.requestId,
      },
    });

    const title = object.title?.trim();
    if (!title) return;

    await runInTenantScope(
      { orgId: opts.orgId, workspaceId: opts.workspaceId },
      () =>
        withTenantDb((tx) =>
          tx
            .update(schema.conversations)
            .set({ title, updatedAt: new Date() })
            .where(
              and(
                eq(schema.conversations.id, opts.conversationId),
                isNull(schema.conversations.title),
              ),
            ),
        ),
    );
  } catch (err) {
    // Best-effort — title generation failure must never affect the chat turn,
    // but don't swallow it silently: a persistent failure (model/DB error) is
    // otherwise invisible.
    logger.warn(
      { err, conversationId: opts.conversationId },
      "[auto-title] title generation failed — skipping",
    );
  }
}
