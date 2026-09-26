// answer_interjection: a person answers the question an agent paused its run
// to ask (#3839).
//
//   1. Role gate. assertOrgRole with the contract's defaultRoles: org Owner or
//      Admin, or workspace Owner or Member, for the signed-in user or the
//      creator of the API key (resolveActingUserId). The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler checks.
//   2. One tenant transaction. Lock the question by either id form inside the
//      caller's org and workspace, whatever its state, so the refusal can say
//      which state stopped it. No row, or a question past its expiry, is
//      `interjection_expired`. A question someone answered is
//      `interjection_answered`. Both leave before any write.
//   3. The UPDATE that records the answer, guarded by `answered_at IS NULL AND
//      expires_at > now()`. The row lock makes a second answer wait for the
//      first and then find it answered.
//   4. For a wrapped run (`tse_…`) whose host can take it, a `message` command
//      carries the answer to the run, queued in the same transaction. The
//      host seals it on the run's chain as `oxagen:command_applied`. A ledger
//      run (`arun_…`) has no connection point, and a run whose host cannot
//      take the command gets none: the answer then lives on the question and
//      in the kernel's `capability.invoke_allowed` audit row, and `commandIds`
//      is empty.
//
// The command expires with the question: past it, the run has carried on
// without an answer and a late message would arrive out of context.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  type agentInterjectionAnswer,
  isInterjectionPublicId,
} from "@oxagen/oxagen/contracts/agent.interjection.answer";
import {
  commandBlockOf,
  steerBlockOf,
} from "@oxagen/oxagen/contracts/run.list";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { type RunScope, runScope } from "./run.list";
import {
  type CommandRowInput,
  postgresCommandStore,
  type RecipientSession,
  resolveDeliveryMode,
} from "./tacho.command.dispatch";

/** Who may answer: the contract's defaultRoles. */
export const INTERJECTION_ANSWER_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member"],
} as const;

/** One question as the answer path reads it, locked for the transaction. */
export type LockedInterjection = {
  id: string;
  publicId: string;
  runPublicId: string;
  answeredAt: Date | null;
  expiresAt: Date;
};

/** The reads and writes one answer makes, all inside one tenant transaction. */
export interface InterjectionAnswerStore {
  /** The question by public id or row uuid in the scope, locked, answered or not. */
  lock(scope: RunScope, id: string): Promise<LockedInterjection | null>;
  /** Record the answer on an open question; false when it was no longer open. */
  answer(args: {
    scope: RunScope;
    id: string;
    answer: string;
    userId: string | null;
    now: Date;
  }): Promise<boolean>;
  /** The root wrapped session a `tse_…` run names, with its host's liveness. */
  session(scope: RunScope, publicId: string): Promise<RecipientSession | null>;
  /** Queue one control command. */
  queue(row: CommandRowInput): Promise<{ publicId: string }>;
}

type AnswerInterjectionDeps = {
  /** Run `fn` against a store inside one tenant transaction. */
  withStore<T>(fn: (store: InterjectionAnswerStore) => Promise<T>): Promise<T>;
  now: () => Date;
};

const expired = () =>
  new HandlerError({
    code: "conflict",
    reason: "interjection_expired",
    message:
      "The question is not open in this workspace. Its run stopped waiting, or the id names no question here.",
  });

const answered = () =>
  new HandlerError({
    code: "conflict",
    reason: "interjection_answered",
    message: "Someone already answered this question.",
  });

/**
 * The `message` command that carries the answer to a wrapped run, or null
 * when the run cannot take one: a sealed run, a host that is gone, or a
 * harness that reads text only at session start. The rule is the one every
 * run row and `dispatch_command` read, so an answer never queues a command
 * the Fleet row would call undeliverable.
 */
export function answerCommand(args: {
  scope: RunScope;
  session: RecipientSession;
  interjectionId: string;
  answer: string;
  userId: string | null;
  now: Date;
  expiresAt: Date;
}): CommandRowInput | null {
  const { session, now } = args;
  const block =
    commandBlockOf({
      outcome: session.outcome,
      sealSource: session.sealSource,
      host: session.host,
      now,
    }) ?? steerBlockOf(session.runtime);
  if (block !== null) return null;
  const resolved = resolveDeliveryMode(
    "next_step",
    session.enforcementTier,
    session.host?.bundleFeatures ?? [],
    session.runtime,
  );
  return {
    scope: args.scope,
    session,
    command: "message",
    payload: {
      address: session.publicId,
      session_uuid: session.sessionUuid,
      text: args.answer,
      interjection_id: args.interjectionId,
    },
    requestedMode: "next_step",
    deliveryMode: resolved.deliveryMode,
    degradedReason: resolved.degradedReason,
    reason: `answer to ${args.interjectionId}`,
    outcome: "queued",
    outcomeDetail: null,
    issuedByUserId: args.userId,
    issuedAt: now,
    expiresAt: args.expiresAt,
  };
}

export function createAnswerInterjectionHandler(
  deps: AnswerInterjectionDeps,
): CapabilityHandler<typeof agentInterjectionAnswer> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      {
        org: [...INTERJECTION_ANSWER_ROLES.org],
        workspace: [...INTERJECTION_ANSWER_ROLES.workspace],
      },
    );
    const scope = runScope(ctx);
    const now = deps.now();

    const result = await deps.withStore(async (store) => {
      const row = await store.lock(scope, input.interjectionId);
      if (row === null) throw expired();
      if (row.answeredAt !== null) throw answered();
      if (row.expiresAt.getTime() <= now.getTime()) throw expired();
      const recorded = await store.answer({
        scope,
        id: row.id,
        answer: input.answer,
        userId: actingUserId,
        now,
      });
      if (!recorded) throw expired();

      const commandIds: string[] = [];
      if (row.runPublicId.startsWith("tse_")) {
        const session = await store.session(scope, row.runPublicId);
        const command =
          session === null
            ? null
            : answerCommand({
                scope,
                session,
                interjectionId: row.publicId,
                answer: input.answer,
                userId: actingUserId,
                now,
                expiresAt: row.expiresAt,
              });
        if (command !== null)
          commandIds.push((await store.queue(command)).publicId);
      }
      return { row, commandIds };
    });

    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        interjectionId: result.row.publicId,
        runId: result.row.runPublicId,
        commands: result.commandIds.length,
      },
      "answer_interjection: answered",
    );
    return {
      interjectionId: result.row.publicId,
      runId: result.row.runPublicId,
      answeredAt: now.toISOString(),
      commandIds: result.commandIds,
    };
  };
}

// ---- Postgres ------------------------------------------------------------------------

const ij = schema.interjections;

/** The id the caller passed, matched as the public id or the row uuid. */
function idCondition(id: string) {
  return isInterjectionPublicId(id)
    ? eq(ij.publicId, id.toLowerCase())
    : eq(ij.id, id);
}

export function postgresInterjectionAnswerStore(
  tx: Tx,
): InterjectionAnswerStore {
  const commands = postgresCommandStore(tx);
  return {
    lock: async (scope, id) => {
      const [row] = await tx
        .select({
          id: ij.id,
          publicId: ij.publicId,
          runPublicId: ij.runPublicId,
          answeredAt: ij.answeredAt,
          expiresAt: ij.expiresAt,
        })
        .from(ij)
        .where(
          and(
            idCondition(id),
            eq(ij.orgId, scope.orgId),
            eq(ij.workspaceId, scope.workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    answer: async ({ scope, id, answer, userId, now }) => {
      const updated = await tx
        .update(ij)
        .set({
          answeredAt: now,
          answer,
          answeredByUserId: userId,
          updatedAt: now,
          updatedById: userId,
        })
        .where(
          and(
            eq(ij.id, id),
            eq(ij.orgId, scope.orgId),
            eq(ij.workspaceId, scope.workspaceId),
            isNull(ij.answeredAt),
            sql`${ij.expiresAt} > now()`,
          ),
        )
        .returning({ id: ij.id });
      return updated.length > 0;
    },
    session: (scope, publicId) => commands.session(scope, publicId),
    queue: (row) => commands.insert(row),
  };
}

export const agentInterjectionAnswerHandler = createAnswerInterjectionHandler({
  withStore: (fn) =>
    withTenantDb((tx) => fn(postgresInterjectionAnswerStore(tx))),
  now: () => new Date(),
});
