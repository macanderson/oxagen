import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import type { CapabilityContext } from "@oxagen/oxagen";
import type {
  A2AArtifact,
  A2AMessage,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
} from "./protocol";

type Scope = Pick<
  CapabilityContext,
  "orgId" | "workspaceId" | "userId" | "apiKeyId"
>;

/** Persisted A2A task row projected to the fields the transport needs. */
export interface A2ATaskRow {
  /** Internal UUID — the value agent_executions.origin_id / a2a_tasks.agent_id joins reference. Never sent on the wire (the wire taskId is publicId). */
  id: string;
  publicId: string;
  contextId: string;
  state: A2ATaskState;
  messageHistory: A2AMessage[];
  artifacts: A2AArtifact[];
  statusMessage: A2AMessage | null;
  errorMessage: string | null;
  updatedAt: Date;
}

function scopeOf(ctx: Scope) {
  return { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
}

function authorId(ctx: Scope): string {
  return ctx.userId ?? ctx.apiKeyId ?? ctx.orgId;
}

/** Map a DB row to the A2A wire Task shape, optionally clamping history length. */
export function toA2ATask(row: A2ATaskRow, historyLength?: number): A2ATask {
  const status: A2ATaskStatus = {
    state: row.state,
    ...(row.statusMessage ? { message: row.statusMessage } : {}),
    timestamp: row.updatedAt.toISOString(),
  };
  const history =
    historyLength !== undefined && historyLength >= 0
      ? row.messageHistory.slice(-historyLength)
      : row.messageHistory;
  return {
    kind: "task",
    id: row.publicId,
    contextId: row.contextId,
    status,
    artifacts: row.artifacts,
    history,
    ...(row.errorMessage ? { metadata: { error: row.errorMessage } } : {}),
  };
}

/**
 * Create a new A2A task row (state 'submitted') seeded with the inbound user
 * message. Returns the persisted row (its public_id is the A2A taskId).
 */
export async function createTask(
  ctx: CapabilityContext,
  args: { contextId: string; userMessage: A2AMessage },
): Promise<A2ATaskRow> {
  return runInTenantScope(scopeOf(ctx), () =>
    withTenantDb(async (tx) => {
      const [inserted] = await tx
        .insert(schema.a2aTasks)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          contextId: args.contextId,
          state: "submitted",
          messageHistory: [args.userMessage],
          artifacts: [],
          createdByUserId: authorId(ctx),
          updatedByUserId: authorId(ctx),
        })
        .returning({
          id: schema.a2aTasks.id,
          publicId: schema.a2aTasks.publicId,
          contextId: schema.a2aTasks.contextId,
          updatedAt: schema.a2aTasks.updatedAt,
        });
      if (!inserted) throw new Error("Failed to create A2A task");
      return {
        id: inserted.id,
        publicId: inserted.publicId,
        contextId: inserted.contextId,
        state: "submitted" as const,
        messageHistory: [args.userMessage],
        artifacts: [],
        statusMessage: null,
        errorMessage: null,
        updatedAt: inserted.updatedAt,
      };
    }),
  );
}

/**
 * Load the full A2A message history for a conversation (contextId), oldest →
 * newest, flattened across every task that shares the contextId. Used to give
 * the agent multi-turn continuity within an A2A conversation.
 */
export async function loadContextHistory(
  ctx: CapabilityContext,
  contextId: string,
): Promise<A2AMessage[]> {
  return runInTenantScope(scopeOf(ctx), () =>
    withTenantDb(async (tx) => {
      const rows = await tx
        .select({ messageHistory: schema.a2aTasks.messageHistory })
        .from(schema.a2aTasks)
        .where(
          and(
            eq(schema.a2aTasks.contextId, contextId),
            eq(schema.a2aTasks.workspaceId, ctx.workspaceId),
            isNull(schema.a2aTasks.deletedAt),
          ),
        )
        .orderBy(schema.a2aTasks.createdAt);
      return rows.flatMap((r) => (r.messageHistory as A2AMessage[]) ?? []);
    }),
  );
}

/** Load a task by its A2A taskId (public_id), scoped to the workspace. */
export async function loadTask(
  ctx: CapabilityContext,
  taskId: string,
): Promise<A2ATaskRow | null> {
  return runInTenantScope(scopeOf(ctx), () =>
    withTenantDb(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.a2aTasks.id,
          publicId: schema.a2aTasks.publicId,
          contextId: schema.a2aTasks.contextId,
          state: schema.a2aTasks.state,
          messageHistory: schema.a2aTasks.messageHistory,
          artifacts: schema.a2aTasks.artifacts,
          statusMessage: schema.a2aTasks.statusMessage,
          errorMessage: schema.a2aTasks.errorMessage,
          updatedAt: schema.a2aTasks.updatedAt,
        })
        .from(schema.a2aTasks)
        .where(
          and(
            eq(schema.a2aTasks.publicId, taskId),
            eq(schema.a2aTasks.workspaceId, ctx.workspaceId),
            isNull(schema.a2aTasks.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        publicId: row.publicId,
        contextId: row.contextId,
        state: row.state as A2ATaskState,
        messageHistory: (row.messageHistory as A2AMessage[]) ?? [],
        artifacts: (row.artifacts as A2AArtifact[]) ?? [],
        statusMessage: (row.statusMessage as A2AMessage | null) ?? null,
        errorMessage: row.errorMessage ?? null,
        updatedAt: row.updatedAt,
      };
    }),
  );
}

/** Patch a task's state / artifacts / history / status message / routing. */
export async function updateTask(
  ctx: CapabilityContext,
  taskId: string,
  patch: {
    state?: A2ATaskState;
    artifacts?: A2AArtifact[];
    appendMessages?: A2AMessage[];
    statusMessage?: A2AMessage | null;
    errorMessage?: string | null;
    /** Resolved skillId target (agent.agents.id) — set once, at skill resolution. */
    agentId?: string | null;
  },
): Promise<A2ATaskRow | null> {
  return runInTenantScope(scopeOf(ctx), () =>
    withTenantDb(async (tx) => {
      const [current] = await tx
        .select({
          id: schema.a2aTasks.id,
          publicId: schema.a2aTasks.publicId,
          contextId: schema.a2aTasks.contextId,
          state: schema.a2aTasks.state,
          messageHistory: schema.a2aTasks.messageHistory,
          artifacts: schema.a2aTasks.artifacts,
          statusMessage: schema.a2aTasks.statusMessage,
          errorMessage: schema.a2aTasks.errorMessage,
        })
        .from(schema.a2aTasks)
        .where(
          and(
            eq(schema.a2aTasks.publicId, taskId),
            eq(schema.a2aTasks.workspaceId, ctx.workspaceId),
            isNull(schema.a2aTasks.deletedAt),
          ),
        )
        .limit(1);
      if (!current) return null;

      const nextHistory = patch.appendMessages
        ? [
            ...((current.messageHistory as A2AMessage[]) ?? []),
            ...patch.appendMessages,
          ]
        : ((current.messageHistory as A2AMessage[]) ?? []);
      const nextArtifacts =
        patch.artifacts ?? (current.artifacts as A2AArtifact[]);
      const nextState = (patch.state ?? current.state) as A2ATaskState;
      const nextStatusMessage =
        patch.statusMessage !== undefined
          ? patch.statusMessage
          : (current.statusMessage as A2AMessage | null);
      const nextError =
        patch.errorMessage !== undefined
          ? patch.errorMessage
          : (current.errorMessage ?? null);

      const [updated] = await tx
        .update(schema.a2aTasks)
        .set({
          state: nextState,
          messageHistory: nextHistory,
          artifacts: nextArtifacts,
          statusMessage: nextStatusMessage,
          errorMessage: nextError,
          updatedAt: new Date(),
          updatedByUserId: authorId(ctx),
          // Routing/lineage columns are set-once-when-known — only touch the
          // column when the caller actually passed a value, so an unrelated
          // lifecycle update (e.g. the terminal-state patch) never clobbers a
          // resolution written by an earlier patch in the same task's life.
          ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
        })
        .where(
          and(
            eq(schema.a2aTasks.publicId, taskId),
            eq(schema.a2aTasks.workspaceId, ctx.workspaceId),
          ),
        )
        .returning({ updatedAt: schema.a2aTasks.updatedAt });

      return {
        id: current.id,
        publicId: current.publicId,
        contextId: current.contextId,
        state: nextState,
        messageHistory: nextHistory,
        artifacts: nextArtifacts,
        statusMessage: nextStatusMessage,
        errorMessage: nextError,
        updatedAt: updated?.updatedAt ?? new Date(),
      };
    }),
  );
}
