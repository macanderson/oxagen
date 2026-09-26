// The timeout of a host's repository question (#3941, D8), as the durable
// function in @oxagen/inngest-functions runs it through its runner seam.
//
// `resolveRaisedInterjectionRepository` runs as soon as the question is
// raised. It names the repository the host asked about, from the frame's
// remote digest, and writes it onto the row, so the Run page can show it
// before anyone answers. A failure is logged and answered as `unresolved`:
// the timeout must still run, and `answer_interjection` resolves the
// repository itself when a person picks a path.
//
// `denyExpiredInterjection` runs at the deadline. It settles the row three
// ways:
//
//   - Nobody answered. It records `deny` with no person, a new `rcp_…`
//     receipt and the answer text the host's own timeout records, writes the
//     `agent.interjection_answered` event with source `timeout`, and queues
//     the `message` command that releases the host's hold and tells the agent
//     why. The run goes on with no skills.
//   - The host's own timeout answered first, and the ingest recorded its
//     `control.answer` as `deny` with no receipt. It adds the receipt and the
//     event and queues nothing: the host has already let the loop go.
//   - A person answered, or an earlier run of this step already settled it.
//     Nothing is written, so a retried step writes one deny.
//
// Every write is in one tenant transaction under the row lock, so a person's
// answer and the timeout cannot both land.
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { emitSecurityEventIn } from "@oxagen/database/security";
import type { AgentInterjectionRaisedEventData } from "@oxagen/inngest-functions/events";
import type {
  InterjectionDenyOutcome,
  InterjectionResolveOutcome,
} from "@oxagen/inngest-functions/interjection-timeout-runner";
import type { InterjectBody } from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  answerCommand,
  type InterjectionAuditEvent,
  type LockedInterjection,
  lockInterjection,
  mintReceiptId,
} from "../agent.interjection.answer";
import { logger } from "../logger";
import type { RunScope } from "../run.list";
import {
  type CommandRowInput,
  postgresCommandStore,
  type RecipientSession,
} from "../tacho.command.dispatch";
import { HOST_TIMEOUT_ANSWER } from "./interjection-frames";
import { resolveInterjectionRepository } from "./interjection-repository";

/** What the agent is told when nobody answered in time. The host tells it the same. */
export const INTERJECTION_TIMED_OUT_TEXT =
  "Oxagen asked a person whether to bind this repository to a workspace, " +
  "and nobody answered in time. This session goes on without skills.";

/**
 * How long the release waits for the host to collect it. The question has
 * already expired, so the release cannot expire with it as a person's
 * answer does. `dispatch_command`'s default.
 */
export const INTERJECTION_RELEASE_TTL_MS = 3_600_000;

/** The reads and writes the timeout makes, inside one tenant transaction. */
export interface InterjectionTimeoutStore {
  lock(scope: RunScope, id: string): Promise<LockedInterjection | null>;
  /** Write the repository onto a row that names none. */
  setRepository(scope: RunScope, id: string, repository: string): Promise<void>;
  /** Record `deny` on a row nobody answered; false when someone had. */
  deny(args: {
    scope: RunScope;
    id: string;
    receiptId: string;
    now: Date;
  }): Promise<boolean>;
  /** Add the receipt to a `deny` the host's timeout recorded; false when it has one. */
  receipt(args: {
    scope: RunScope;
    id: string;
    receiptId: string;
    now: Date;
  }): Promise<boolean>;
  session(scope: RunScope, publicId: string): Promise<RecipientSession | null>;
  queue(row: CommandRowInput): Promise<{ publicId: string }>;
  audit(event: InterjectionAuditEvent): Promise<void>;
}

export interface InterjectionTimeoutDeps {
  /** Run `fn` against a store inside one tenant transaction in `scope`. */
  withStore<T>(
    scope: RunScope,
    fn: (store: InterjectionTimeoutStore) => Promise<T>,
  ): Promise<T>;
  now: () => Date;
  mintReceipt: () => string;
  resolveRepository(
    scope: RunScope,
    body: InterjectBody,
  ): Promise<string | null>;
}

function scopeOf(request: AgentInterjectionRaisedEventData): RunScope {
  return { orgId: request.orgId, workspaceId: request.workspaceId };
}

/**
 * Name the repository a raised question is about and write it onto the row.
 * Skipped when the row already names one, is answered, or is not a
 * repository question.
 */
export async function resolveRaisedInterjectionRepository(
  request: AgentInterjectionRaisedEventData,
  deps: InterjectionTimeoutDeps,
): Promise<InterjectionResolveOutcome> {
  const scope = scopeOf(request);
  const row = await deps.withStore(scope, (store) =>
    store.lock(scope, request.interjectionId),
  );
  if (
    row === null ||
    row.kind !== "repo_unknown" ||
    row.body === null ||
    row.answeredAt !== null ||
    row.repository !== null
  )
    return { outcome: "skipped", repository: row?.repository ?? null };
  let repository: string | null;
  try {
    repository = await deps.resolveRepository(scope, row.body);
  } catch (err) {
    logger.warn(
      { err, orgId: scope.orgId, interjectionId: row.publicId },
      "interjection timeout: the repository could not be resolved; the timeout still runs",
    );
    return { outcome: "unresolved", repository: null };
  }
  if (repository === null) return { outcome: "unresolved", repository: null };
  const named = repository;
  await deps.withStore(scope, (store) =>
    store.setRepository(scope, row.id, named),
  );
  return { outcome: "resolved", repository };
}

function denyAudit(args: {
  scope: RunScope;
  row: LockedInterjection;
  receiptId: string;
  commandIds: string[];
  now: Date;
}): InterjectionAuditEvent {
  return {
    eventType: "agent.interjection_answered",
    actorUserId: null,
    orgId: args.scope.orgId,
    workspaceId: args.scope.workspaceId,
    capability: null,
    outcome: "success",
    occurredAt: args.now,
    ip: null,
    userAgent: null,
    requestId: `interjection-timeout:${args.row.publicId}`,
    detail: {
      interjectionId: args.row.publicId,
      runId: args.row.runPublicId,
      kind: args.row.kind,
      path: "deny",
      source: "timeout",
      receiptId: args.receiptId,
      commandIds: args.commandIds,
    },
  };
}

/** Answer `deny` on a repository question nobody answered by its deadline. */
export async function denyExpiredInterjection(
  request: AgentInterjectionRaisedEventData,
  deps: InterjectionTimeoutDeps,
): Promise<InterjectionDenyOutcome> {
  const scope = scopeOf(request);
  const now = deps.now();
  const outcome = await deps.withStore(
    scope,
    async (store): Promise<InterjectionDenyOutcome> => {
      const row = await store.lock(scope, request.interjectionId);
      // Only a repository question has a timeout: the ingest sends the event
      // for no other row.
      if (row === null || row.kind !== "repo_unknown")
        return { outcome: "gone", receiptId: null, commandIds: [] };
      if (row.receiptId !== null)
        return { outcome: "answered", receiptId: row.receiptId, commandIds: [] };
      if (row.answeredAt === null && row.expiresAt.getTime() > now.getTime())
        return { outcome: "not_due", receiptId: null, commandIds: [] };

      const receiptId = deps.mintReceipt();
      if (row.answeredAt !== null) {
        // The host's own timeout answered first. A path with no receipt that
        // is not deny is an answer from before receipts, left alone.
        if (row.path !== "deny")
          return { outcome: "answered", receiptId: null, commandIds: [] };
        if (!(await store.receipt({ scope, id: row.id, receiptId, now })))
          return { outcome: "answered", receiptId: null, commandIds: [] };
        await store.audit(
          denyAudit({ scope, row, receiptId, commandIds: [], now }),
        );
        return { outcome: "receipted", receiptId, commandIds: [] };
      }

      if (!(await store.deny({ scope, id: row.id, receiptId, now })))
        return { outcome: "answered", receiptId: null, commandIds: [] };
      const commandIds: string[] = [];
      if (row.runPublicId.startsWith("tse_") && row.body !== null) {
        const session = await store.session(scope, row.runPublicId);
        const command =
          session === null
            ? null
            : answerCommand({
                scope,
                session,
                interjectionId: row.publicId,
                answer: INTERJECTION_TIMED_OUT_TEXT,
                userId: null,
                now,
                expiresAt: new Date(
                  now.getTime() + INTERJECTION_RELEASE_TTL_MS,
                ),
                interjection: {
                  key: row.body.interjection_key,
                  path: "deny",
                  source: "timeout",
                  receipt_id: receiptId,
                  answered_by: null,
                },
              });
        if (command !== null)
          commandIds.push((await store.queue(command)).publicId);
      }
      await store.audit(denyAudit({ scope, row, receiptId, commandIds, now }));
      return { outcome: "denied", receiptId, commandIds };
    },
  );
  logger.info(
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      interjectionId: request.interjectionId,
      outcome: outcome.outcome,
      receiptId: outcome.receiptId,
      commands: outcome.commandIds.length,
    },
    "interjection timeout: settled",
  );
  return outcome;
}

// ---- Postgres ------------------------------------------------------------------------

const ij = schema.interjections;

export function postgresInterjectionTimeoutStore(
  tx: Tx,
): InterjectionTimeoutStore {
  const commands = postgresCommandStore(tx);
  const inScope = (scope: RunScope, id: string) =>
    and(
      eq(ij.id, id),
      eq(ij.orgId, scope.orgId),
      eq(ij.workspaceId, scope.workspaceId),
    );
  return {
    lock: (scope, id) => lockInterjection(tx, scope, id),
    setRepository: async (scope, id, repository) => {
      await tx
        .update(ij)
        .set({ repository, updatedAt: new Date() })
        .where(and(inScope(scope, id), isNull(ij.repository)));
    },
    deny: async ({ scope, id, receiptId, now }) => {
      const updated = await tx
        .update(ij)
        .set({
          answeredAt: now,
          answer: HOST_TIMEOUT_ANSWER,
          answeredByUserId: null,
          path: "deny",
          receiptId,
          updatedAt: now,
        })
        .where(and(inScope(scope, id), isNull(ij.answeredAt)))
        .returning({ id: ij.id });
      return updated.length > 0;
    },
    receipt: async ({ scope, id, receiptId, now }) => {
      const updated = await tx
        .update(ij)
        .set({ receiptId, updatedAt: now })
        .where(
          and(
            inScope(scope, id),
            isNotNull(ij.answeredAt),
            eq(ij.path, "deny"),
            isNull(ij.receiptId),
          ),
        )
        .returning({ id: ij.id });
      return updated.length > 0;
    },
    session: (scope, publicId) => commands.session(scope, publicId),
    queue: (row) => commands.insert(row),
    audit: (event) => emitSecurityEventIn(tx, event),
  };
}

export const POSTGRES_INTERJECTION_TIMEOUT_DEPS: InterjectionTimeoutDeps = {
  withStore: (scope, fn) =>
    runInTenantScope(scope, () =>
      withTenantDb((tx) => fn(postgresInterjectionTimeoutStore(tx))),
    ),
  now: () => new Date(),
  mintReceipt: mintReceiptId,
  resolveRepository: (scope, body) =>
    runInTenantScope(scope, () => resolveInterjectionRepository(scope, body)),
};
