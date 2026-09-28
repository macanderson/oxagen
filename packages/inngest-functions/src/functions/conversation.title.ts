import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  CREDIT_REASONS,
  conversationTitlePrompt,
  generateObjectFor,
  loadWorkspacePromptConfigSafe,
  resolveModelFundingSource,
  resolvePrompt,
  selectModelFromFunding,
} from "@oxagen/ai";
import { evaluateTurnCreditGate } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { NonRetriableError } from "@oxagen/functions";
import { capSubject } from "@oxagen/tacho/session-subject";
import { runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { createFunction } from "../create-function";
import { CONVERSATION_OPENED_EVENT } from "../events";
import { logger } from "../logger";

type ConversationTitleRequest = {
  conversationId: string;
  orgId: string;
  workspaceId: string;
};

/** What happened to one conversation's title. */
export type ConversationTitleOutcome =
  | "written"
  | "not_prompt_titled"
  | "credit_refused"
  | "model_failed"
  | "empty_title"
  | "renamed_meanwhile";

/** The model sees at most this much of the first question. */
const QUESTION_MAX_CHARS = 500;

const titleSchema = z.object({ title: z.string().max(200) });

function requestOf(data: unknown): ConversationTitleRequest | null {
  const d = data as Partial<ConversationTitleRequest> | null;
  return typeof d?.conversationId === "string" &&
    d.conversationId.length > 0 &&
    typeof d.orgId === "string" &&
    d.orgId.length > 0 &&
    typeof d.workspaceId === "string" &&
    d.workspaceId.length > 0
    ? {
        conversationId: d.conversationId,
        orgId: d.orgId,
        workspaceId: d.workspaceId,
      }
    : null;
}

/**
 * Drops the quotes and the closing punctuation a model tends to add, then
 * caps the rest at 72 characters on a word boundary. Null when nothing is left.
 */
export function modelTitle(raw: string): string | null {
  const bare = raw
    .trim()
    .replace(/^["'`‘’“”]+/u, "")
    .replace(/["'`‘’“”.!?,;:]+$/u, "");
  return capSubject(bare);
}

/** The first question of a conversation that still carries its prompt title. */
async function readQuestion(
  scope: TenantScope,
  conversationId: string,
): Promise<string | null> {
  return runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      const [conversation] = await tx
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.id, conversationId),
            eq(schema.conversations.orgId, scope.orgId),
            eq(schema.conversations.workspaceId, scope.workspaceId),
            eq(schema.conversations.titleSource, "prompt"),
            isNull(schema.conversations.deletedAt),
          ),
        )
        .limit(1);
      if (!conversation) return null;
      const [first] = await tx
        .select({ content: schema.messages.content })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, conversationId),
            eq(schema.messages.orgId, scope.orgId),
            eq(schema.messages.workspaceId, scope.workspaceId),
            eq(schema.messages.role, "user"),
          ),
        )
        .orderBy(asc(schema.messages.createdAt))
        .limit(1);
      const question = first?.content.trim() ?? "";
      return question.length > 0 ? question : null;
    }),
  );
}

/**
 * One fast-tier call that names the conversation. It runs outside any
 * database transaction, and only after the credit gate admits it.
 *
 * The funding resolver and the credit gate read inside the tenant scope. An
 * Inngest step runs on its own, so both reads meet a cold cache: outside the
 * scope the credential read throws `TenantScopeError` and the gate's read
 * fails open. The scope opens no transaction.
 */
async function nameQuestion(
  scope: TenantScope,
  question: string,
): Promise<{ title: string | null; outcome: ConversationTitleOutcome }> {
  const selection = await runInTenantScope(scope, async () => {
    const funding = await resolveModelFundingSource(scope.orgId);
    const chosen = selectModelFromFunding(scope.orgId, funding, {
      tier: "fast",
    });
    const gate = await evaluateTurnCreditGate(scope.orgId, {
      fundedBy: chosen.fundedBy,
    });
    return gate.ok ? chosen : null;
  });
  if (selection === null) return { title: null, outcome: "credit_refused" };
  const config = await runInTenantScope(scope, () =>
    loadWorkspacePromptConfigSafe(scope.workspaceId),
  );
  try {
    const { object } = await runInTenantScope(scope, () =>
      generateObjectFor({
        ...selection,
        // The title belongs to the assistant's conversation, so it counts
        // against the assistant spend cap with the turn's completions.
        chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
        schema: titleSchema,
        system: resolvePrompt({
          key: "conversation.title",
          baseline: conversationTitlePrompt(),
          config,
        }),
        prompt: question.slice(0, QUESTION_MAX_CHARS),
        temperature: 0.3,
        abortSignal: AbortSignal.timeout(30_000),
        maxRetries: 0,
        telemetry: {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          surface: "app",
          messageId: randomUUID(),
        },
      }),
    );
    const title = modelTitle(object.title);
    return title
      ? { title, outcome: "written" }
      : { title: null, outcome: "empty_title" };
  } catch (err) {
    logger.warn(
      { err, orgId: scope.orgId },
      "conversation.title: the model call failed; the prompt title stays",
    );
    return { title: null, outcome: "model_failed" };
  }
}

/** Writes the title only while the row still carries its prompt title. */
async function writeTitle(
  scope: TenantScope,
  conversationId: string,
  title: string,
): Promise<boolean> {
  const updated = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .update(schema.conversations)
        .set({ title, titleSource: "model", updatedAt: new Date() })
        .where(
          and(
            eq(schema.conversations.id, conversationId),
            eq(schema.conversations.orgId, scope.orgId),
            eq(schema.conversations.workspaceId, scope.workspaceId),
            eq(schema.conversations.titleSource, "prompt"),
          ),
        )
        .returning({ id: schema.conversations.id }),
    ),
  );
  return updated.length > 0;
}

/**
 * `chat/conversation.opened` → ask the fast model for a better name than the
 * one cut from the first question (#4571).
 *
 * The conversation already has a readable title before this runs, so every
 * failure keeps it: a refused credit gate, a failed call and an empty answer
 * all return without a write. The write replaces only a title whose source is
 * still `prompt`, so a rename that lands while the model is thinking wins.
 * The model call runs in its own step, outside any transaction, so a retried
 * write does not pay for a second call.
 *
 * One run per conversation at a time. The sender keys the event by
 * conversation, so the bus drops a repeat send. A repeat that still arrives
 * waits for the first run's write, then finds no prompt title and stops.
 */
export const [conversationTitle] = createFunction(
  {
    id: "conversation.title",
    retries: 1,
    concurrency: { limit: 1, key: "event.data.conversationId" },
  },
  { event: CONVERSATION_OPENED_EVENT },
  async ({ event, step }) => {
    const request = requestOf(event.data);
    if (request === null)
      throw new NonRetriableError(
        "chat/conversation.opened carries no conversationId, orgId and workspaceId",
      );
    const scope = { orgId: request.orgId, workspaceId: request.workspaceId };
    const question = await step.run("read-question", () =>
      readQuestion(scope, request.conversationId),
    );
    if (question === null)
      return {
        conversationId: request.conversationId,
        outcome: "not_prompt_titled" as ConversationTitleOutcome,
      };
    const named = await step.run("name-conversation", () =>
      nameQuestion(scope, question),
    );
    if (named.title === null) {
      logger.info(
        { conversationId: request.conversationId, outcome: named.outcome },
        "conversation.title: the prompt title stays",
      );
      return { conversationId: request.conversationId, outcome: named.outcome };
    }
    const title = named.title;
    const written = await step.run("write-title", () =>
      writeTitle(scope, request.conversationId, title),
    );
    return {
      conversationId: request.conversationId,
      outcome: (written
        ? "written"
        : "renamed_meanwhile") as ConversationTitleOutcome,
    };
  },
);
