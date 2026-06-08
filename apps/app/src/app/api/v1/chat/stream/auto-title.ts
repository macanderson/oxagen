import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { generateObjectFor, selectModel } from "@oxagen/ai";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";

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
    const { object } = await generateObjectFor({
      schema: z.object({ title: z.string().max(80) }),
      model: selectModel({ tier: "fast" }),
      system:
        "You are a conversation titler. Respond with a concise title (≤6 words, Title Case, no trailing punctuation) that captures the main topic of the user message. Return only the title.",
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
  } catch {
    // Best-effort — title generation failure must never affect the chat turn.
  }
}
