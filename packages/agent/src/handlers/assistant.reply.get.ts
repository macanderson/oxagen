// get_assistant_reply: the reply an in-app agent turn left on the record, read
// by its run (ADR-176). The flyout reads it after its stream dropped. The turn
// ran on and persisted its reply (ADR-092), and this is how the person gets it
// back without asking again.
//
// Three reads, each inside the tenant scope the kernel entered: the role gate,
// the run on the ledger, and the reply in the person's own conversations. The
// ledger read is fenced by row-level security, so a run of another
// organization resolves to nothing. The reply is found by the run id the turn
// writes into the assistant message's metadata (`appendAssistantMessage`,
// runtime/assistant-turn.ts), only in conversations the person owns, and only
// among messages written since the run opened. The reply is always written
// after its run is admitted, so that bound loses nothing, and it keeps the
// scan on the conversation's `(conversation_id, created_at)` index.
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import {
  assistantReplyGet,
  type AssistantReplyGetInput,
  type AssistantReplyGetOutput,
} from "@oxagen/oxagen/contracts/assistant.reply.get";
import type { RunSummary } from "@oxagen/run-ledger";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { assistantRunStore } from "../runtime/assistant-run";
import type { CapabilityContext } from "../types";

/** The run surfaces an in-app agent turn is recorded on (assistant-run.ts). */
const ASSISTANT_SURFACES: ReadonlySet<string> = new Set(["chat", "api-chat"]);

/** The roles the contract grants, checked here for every tier (INV-29). */
const REPLY_ROLES = {
  org: allowedRoles(assistantReplyGet.defaultRoles.org),
  workspace: allowedRoles(assistantReplyGet.defaultRoles.workspace),
};

function allowedRoles(grants: Record<string, string | undefined>): string[] {
  return Object.entries(grants)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

export type AssistantReplyRun = Pick<
  RunSummary,
  "surface" | "status" | "createdAt"
>;

export type AssistantReply = NonNullable<AssistantReplyGetOutput["reply"]>;

/** The read's seams: who is asking, the run on the ledger, and the reply. */
export interface AssistantReplyDeps {
  /** The person asking, once the role gate has passed them. */
  actingUser: (ctx: CapabilityContext) => Promise<string>;
  /** The run by its `arun_…` id, fenced to the tenant; null when there is none. */
  readRun: (runId: string) => Promise<AssistantReplyRun | null>;
  /** The reply written for the run in one of `userId`'s conversations. */
  readReply: (args: {
    orgId: string;
    workspaceId: string;
    userId: string;
    runId: string;
    since: Date;
  }) => Promise<AssistantReply | null>;
}

export function createAssistantReplyRead(deps: AssistantReplyDeps) {
  return async (
    input: AssistantReplyGetInput,
    ctx: CapabilityContext,
  ): Promise<AssistantReplyGetOutput> => {
    const userId = await deps.actingUser(ctx);
    const run = await deps.readRun(input.runId);
    // A wrapped session's run and a run this tenant cannot see read alike, so
    // the answer tells nothing about a run the caller could not open.
    if (run === null || !ASSISTANT_SURFACES.has(run.surface)) {
      throw new HandlerError({
        code: "not_found",
        reason: "run_not_found",
        message: "No in-app agent run with that id in this workspace",
      });
    }
    const reply = await deps.readReply({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId,
      runId: input.runId,
      since: run.createdAt,
    });
    return { runId: input.runId, runStatus: run.status, reply };
  };
}

async function actingUser(ctx: CapabilityContext): Promise<string> {
  const userId = await resolveActingUserId(ctx);
  // assertOrgRole refuses a missing user with `no_principal` before any query.
  await assertOrgRole({ ...ctx, userId }, REPLY_ROLES);
  if (userId === null) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }
  return userId;
}

async function readReply(args: {
  orgId: string;
  workspaceId: string;
  userId: string;
  runId: string;
  since: Date;
}): Promise<AssistantReply | null> {
  const { conversations, messages } = schema;
  return withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        conversationId: messages.conversationId,
        text: messages.content,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(conversations.orgId, args.orgId),
          eq(conversations.workspaceId, args.workspaceId),
          eq(conversations.userId, args.userId),
          isNull(conversations.deletedAt),
          eq(messages.orgId, args.orgId),
          eq(messages.workspaceId, args.workspaceId),
          eq(messages.role, "assistant"),
          gte(messages.createdAt, args.since),
          sql`${messages.metadata}->>'runId' = ${args.runId}`,
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export const assistantReplyGetHandler = createAssistantReplyRead({
  actingUser,
  readRun: (runId) => assistantRunStore().getRunByPublicId(runId),
  readReply,
});
