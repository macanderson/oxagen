// answer_interjection: a person answers the question an agent paused its run
// to ask (#3839), or the question a host asked when a session started in a
// repository the workspace has not bound (#3941).
//
//   1. Role gate. assertOrgRole for the signed-in user or the creator of the
//      API key (resolveActingUserId). A free-text answer admits org Owner or
//      Admin, or workspace Owner or Member: the contract's defaultRoles. A
//      path answer admits org Owner or Admin, or workspace Owner: the
//      defaultRoles of link_repository and create_workspace, which the path
//      runs. The kernel's IAM check allows every capability for a
//      non-enterprise org, so the handler checks.
//   2. A first read of the question by either id form inside the caller's org
//      and workspace, whatever its state. No row, or a question past its
//      expiry, is `interjection_expired`. A question someone answered is
//      `interjection_answered`. A field the question's kind does not take, or
//      a missing one it needs, is `interjection_answer_shape`. All three leave
//      before any write.
//   3. A path answer does what it names, outside any transaction, because
//      both paths call GitHub. `link` runs link_repository on the repository
//      the host asked about. `create` runs create_workspace with it as the new
//      workspace's main repository, and the new workspace starts with skills
//      off. Both run through the kernel, so an enterprise org's policies and
//      the capability's own audit row apply to them. The repository is the
//      one the timeout function resolved onto the row, or, when it has not
//      yet, the one this call resolves from the frame's remote digest. None is
//      `interjection_repository_unresolved`.
//   4. One tenant transaction. Lock the question and check it again, then the
//      UPDATE that records the answer, its path and a new `rcp_…` receipt,
//      guarded by `answered_at IS NULL AND expires_at > now()`. The row lock
//      makes a second answer wait for the first and then find it answered.
//      For a wrapped run (`tse_…`) whose host can take it, a `message` command
//      carries the answer to the run, queued in the same transaction. One
//      `agent.interjection_answered` security event records the receipt.
//
// A link or create that succeeded before step 4 found the question closed
// stays done: the refusal says the question was answered, and the repository
// stays bound. A link retried after it bound the repository takes the
// existing binding as its own.
//
// The command expires with the question: past it, the run has carried on
// without an answer and a late message would arrive out of context. A path
// answer's command also carries `payload.interjection`. The host reads it to
// seal `control.answer` and what the answer did, and to release the loop it
// holds. The host releases that loop, not the harness, so only the host's
// reach decides whether the command is queued.
import type {
  CapabilityContext,
  CapabilityHandler,
  CheckedContext,
} from "@oxagen/oxagen";
import { HandlerError, isHandlerError } from "@oxagen/oxagen/handler-error";
import {
  type AgentInterjectionAnswerInput,
  type AgentInterjectionAnswerOutput,
  type agentInterjectionAnswer,
  isInterjectionPublicId,
} from "@oxagen/oxagen/contracts/agent.interjection.answer";
import type { INTERJECTION_KINDS } from "@oxagen/oxagen/contracts/agent.interjection.list";
import {
  type RepositoryLinkInput,
  type RepositoryLinkOutput,
  repositoryLink,
} from "@oxagen/oxagen/contracts/repository.link";
import {
  type WorkspaceCreateInput,
  type WorkspaceCreateOutput,
  workspaceCreate,
} from "@oxagen/oxagen/contracts/workspace.create";
import {
  commandBlockOf,
  steerBlockOf,
} from "@oxagen/oxagen/contracts/run.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { emitSecurityEventIn } from "@oxagen/database/security";
import {
  INTERJECTION_PATHS,
  type InterjectBody,
  type InterjectionAnswerPayload,
  type InterjectionPath,
  interjectBodySchema,
} from "@oxagen/tacho";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resolveInterjectionRepository } from "./lib/interjection-repository";
import { logger } from "./logger";
import { type RunScope, runScope } from "./run.list";
import {
  type CommandRowInput,
  postgresCommandStore,
  type RecipientSession,
  resolveDeliveryMode,
} from "./tacho.command.dispatch";

/** Who may give a free-text answer: the contract's defaultRoles. */
export const INTERJECTION_ANSWER_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member"],
} as const;

/**
 * Who may take a path: the defaultRoles of link_repository and
 * create_workspace, which are the same pair. A workspace Member can answer a
 * free-text question and cannot take either path.
 */
export const INTERJECTION_PATH_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner"],
} as const;

export type InterjectionKind = (typeof INTERJECTION_KINDS)[number];

/** One question as the answer path reads it, locked for the transaction. */
export type LockedInterjection = {
  id: string;
  publicId: string;
  runPublicId: string;
  answeredAt: Date | null;
  expiresAt: Date;
  kind: InterjectionKind;
  /** The `control.interject` body; null on a question, or a body that no longer parses. */
  body: InterjectBody | null;
  /** `owner/name` resolved from the body's remote digest; null until resolved. */
  repository: string | null;
  path: InterjectionPath | null;
  receiptId: string | null;
};

/** The audit row an answer writes, in the shape the security events table takes. */
export type InterjectionAuditEvent = Parameters<typeof emitSecurityEventIn>[1];

/** The reads and writes one answer makes, all inside one tenant transaction. */
export interface InterjectionAnswerStore {
  /** The question by public id or row uuid in the scope, locked, answered or not. */
  lock(scope: RunScope, id: string): Promise<LockedInterjection | null>;
  /** Record the answer on an open question; false when it was no longer open. */
  answer(args: {
    scope: RunScope;
    id: string;
    answer: string;
    /** The path a `repo_unknown` answer took; null for free text. */
    path: InterjectionPath | null;
    /** The repository this call resolved, recorded when the row had none. */
    repository: string | null;
    receiptId: string;
    userId: string | null;
    now: Date;
  }): Promise<boolean>;
  /** The root wrapped session a `tse_…` run names, with its host's liveness. */
  session(scope: RunScope, publicId: string): Promise<RecipientSession | null>;
  /** Queue one control command. */
  queue(row: CommandRowInput): Promise<{ publicId: string }>;
  /** The `usr_…` public id of a user, or null when there is no such user. */
  userPublicId(userId: string): Promise<string | null>;
  /** The workspace's existing link to `fullName`, for a link that was already made. */
  linkedBinding(
    scope: RunScope,
    fullName: string,
  ): Promise<{ bindingId: string; fullName: string } | null>;
  /** Write one audit row in the same transaction. */
  audit(event: InterjectionAuditEvent): Promise<void>;
}

/** The capabilities a path answer runs. Production runs them through the kernel. */
export interface InterjectionPathCalls {
  link(
    input: RepositoryLinkInput,
    ctx: CapabilityContext,
  ): Promise<RepositoryLinkOutput>;
  create(
    input: WorkspaceCreateInput,
    ctx: CapabilityContext,
  ): Promise<WorkspaceCreateOutput>;
}

export type AnswerInterjectionDeps = {
  /** Run `fn` against a store inside one tenant transaction. */
  withStore<T>(fn: (store: InterjectionAnswerStore) => Promise<T>): Promise<T>;
  now: () => Date;
  /** A new receipt id (`rcp_…`). */
  mintReceipt: () => string;
  paths: InterjectionPathCalls;
  /** `owner/name` of the repository a frame's remote digest names, or null. */
  resolveRepository(
    scope: RunScope,
    body: InterjectBody,
  ): Promise<string | null>;
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

const shape = (message: string) =>
  new HandlerError({
    code: "conflict",
    reason: "interjection_answer_shape",
    message,
  });

const unresolved = () =>
  new HandlerError({
    code: "conflict",
    reason: "interjection_repository_unresolved",
    message:
      "Oxagen could not find the repository this question is about among the repositories this workspace's GitHub installation can see, so it cannot link it or create a workspace for it.",
  });

/** A new receipt id, from the alphabet public ids use. */
export function mintReceiptId(): string {
  return `rcp_${schema.cryptoRandom(22)}`;
}

/**
 * Refuse a combination of fields the question's kind does not take. A
 * `question` takes `answer` alone. A `repo_unknown` takes `path`, and
 * `create` exactly when the path is `create`.
 */
export function assertAnswerShape(
  kind: InterjectionKind,
  input: Pick<AgentInterjectionAnswerInput, "answer" | "path" | "create">,
): void {
  if (kind === "question") {
    if (input.path !== undefined || input.create !== undefined)
      throw shape(
        "This question takes a free-text answer. Send `answer` without `path` or `create`.",
      );
    if (input.answer === undefined)
      throw shape("This question takes a free-text answer. Send `answer`.");
    return;
  }
  if (input.answer !== undefined)
    throw shape(
      "This question asks which repository path to take. Send `path` without `answer`.",
    );
  if (input.path === undefined)
    throw shape(
      "This question asks which repository path to take. Send `path` as `link` or `create`.",
    );
  if (input.path === "create" && input.create === undefined)
    throw shape(
      "The `create` path needs the new workspace's name and slug in `create`.",
    );
  if (input.path === "link" && input.create !== undefined)
    throw shape("The `link` path takes no `create`.");
}

/** `owner` and `name` of an `owner/name`. */
function splitFullName(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf("/");
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/**
 * The context a nested capability call runs under: the caller's, without the
 * fields the kernel attaches to a checked context. The kernel refuses a
 * context that arrives carrying a decision reference.
 */
function nestedContext(ctx: CheckedContext): CapabilityContext {
  const plain: CheckedContext = { ...ctx };
  delete plain.authorizationDecision;
  delete plain.principal;
  delete plain.idempotencyKey;
  delete plain.execution;
  return plain;
}

/** What a path answer did, before the answer is recorded. */
type PathOutcome = {
  path: "link" | "create";
  text: string;
  /** The row's answer. */
  answer: string;
  repository: { bindingId: string; fullName: string };
  workspace: { publicId: string; slug: string } | null;
  /** The slug the host names in `repo.bound`. */
  workspaceSlug: string;
};

/** What the agent is told once the question is settled. */
export const INTERJECTION_LINK_TEXT = (slug: string): string =>
  `A person linked this repository to the workspace ${slug}. The session goes on under that workspace.`;
export const INTERJECTION_CREATE_TEXT = (slug: string): string =>
  `A person created the workspace ${slug} for this repository. Its skills are off, so the session goes on without skills.`;

async function linkPath(
  deps: AnswerInterjectionDeps,
  ctx: CheckedContext,
  scope: RunScope,
  body: InterjectBody,
  fullName: string,
): Promise<PathOutcome> {
  const slug = body.paths[0].workspace_slug;
  let repository: { bindingId: string; fullName: string };
  try {
    const linked = await deps.paths.link(
      { provider: "github", ...splitFullName(fullName) },
      nestedContext(ctx),
    );
    repository = { bindingId: linked.bindingId, fullName: linked.fullName };
  } catch (err) {
    // A retry after a link that bound the repository and then failed to
    // record the answer. The binding that exists is this answer's.
    if (!isHandlerError(err) || err.reason !== "repository_already_linked")
      throw err;
    const existing = await deps.withStore((store) =>
      store.linkedBinding(scope, fullName),
    );
    if (existing === null) throw err;
    repository = existing;
  }
  return {
    path: "link",
    text: INTERJECTION_LINK_TEXT(slug),
    answer: `Linked ${repository.fullName} to the workspace ${slug}.`,
    repository,
    workspace: null,
    workspaceSlug: slug,
  };
}

async function createPath(
  deps: AnswerInterjectionDeps,
  ctx: CheckedContext,
  create: { name: string; slug: string },
  fullName: string,
): Promise<PathOutcome> {
  const created = await deps.paths.create(
    {
      name: create.name,
      slug: create.slug,
      mainRepo: { provider: "github", ...splitFullName(fullName) },
    },
    nestedContext(ctx),
  );
  return {
    path: "create",
    text: INTERJECTION_CREATE_TEXT(created.slug),
    answer: `Created the workspace ${created.slug} for ${created.mainRepo.fullName}, with skills off.`,
    repository: {
      bindingId: created.mainRepo.bindingId,
      fullName: created.mainRepo.fullName,
    },
    workspace: { publicId: created.publicId, slug: created.slug },
    workspaceSlug: created.slug,
  };
}

/**
 * Run the path a person took on a repository question: find the repository,
 * then link it or create a workspace for it. `resolvedRepository` is set when
 * this call resolved the repository, so the answer records it on the row.
 */
async function takePath(
  deps: AnswerInterjectionDeps,
  ctx: CheckedContext,
  scope: RunScope,
  row: LockedInterjection,
  input: Pick<AgentInterjectionAnswerInput, "path" | "create">,
): Promise<{ outcome: PathOutcome; resolvedRepository: string | null }> {
  const body = row.body;
  if (body === null) {
    // The ingest writes only a body that parsed, so this is drift between
    // the stored body and its schema.
    logger.error(
      { orgId: scope.orgId, interjectionId: row.publicId },
      "answer_interjection: the stored control.interject body no longer parses",
    );
    throw unresolved();
  }
  const resolvedRepository =
    row.repository === null
      ? await deps.resolveRepository(scope, body)
      : null;
  const fullName = row.repository ?? resolvedRepository;
  if (fullName === null) throw unresolved();
  const outcome =
    input.path === "create" && input.create !== undefined
      ? await createPath(deps, ctx, input.create, fullName)
      : await linkPath(deps, ctx, scope, body, fullName);
  return { outcome, resolvedRepository };
}

/**
 * The `message` command that carries the answer to a wrapped run, or null
 * when the run cannot take one: a sealed run, a host that is gone, or, for a
 * free-text answer, a harness that reads text only at session start. The rule
 * is the one every run row and `dispatch_command` read, so an answer never
 * queues a command the Fleet row would call undeliverable.
 *
 * With `interjection`, the command also releases the loop the host holds.
 * The host applies it whatever the harness is, so only the host's reach
 * counts.
 */
export function answerCommand(args: {
  scope: RunScope;
  session: RecipientSession;
  interjectionId: string;
  answer: string;
  userId: string | null;
  now: Date;
  expiresAt: Date;
  interjection?: InterjectionAnswerPayload;
}): CommandRowInput | null {
  const { session, now } = args;
  const reach = commandBlockOf({
    outcome: session.outcome,
    sealSource: session.sealSource,
    host: session.host,
    now,
  });
  const block =
    args.interjection === undefined
      ? (reach ?? steerBlockOf(session.runtime))
      : reach;
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
      ...(args.interjection === undefined
        ? {}
        : { interjection: args.interjection }),
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
  return async (input, ctx): Promise<AgentInterjectionAnswerOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    const roles =
      input.path === undefined
        ? INTERJECTION_ANSWER_ROLES
        : INTERJECTION_PATH_ROLES;
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: [...roles.org], workspace: [...roles.workspace] },
    );
    const scope = runScope(ctx);
    const now = deps.now();

    const first = await deps.withStore((store) =>
      store.lock(scope, input.interjectionId),
    );
    if (first === null) throw expired();
    assertAnswerShape(first.kind, input);
    if (first.answeredAt !== null) throw answered();
    if (first.expiresAt.getTime() <= now.getTime()) throw expired();

    const taken =
      first.kind === "repo_unknown"
        ? await takePath(deps, ctx, scope, first, input)
        : null;
    const outcome = taken?.outcome ?? null;
    const resolvedRepository = taken?.resolvedRepository ?? null;

    const result = await deps.withStore(async (store) => {
      const row = await store.lock(scope, first.id);
      if (row === null) throw expired();
      if (row.answeredAt !== null) throw answered();
      if (row.expiresAt.getTime() <= now.getTime()) throw expired();
      const receiptId = deps.mintReceipt();
      const answerText = outcome?.answer ?? input.answer ?? "";
      const recorded = await store.answer({
        scope,
        id: row.id,
        answer: answerText,
        path: outcome?.path ?? null,
        repository: resolvedRepository,
        receiptId,
        userId: actingUserId,
        now,
      });
      if (!recorded) throw expired();

      const commandIds: string[] = [];
      if (row.runPublicId.startsWith("tse_")) {
        const session = await store.session(scope, row.runPublicId);
        const interjection: InterjectionAnswerPayload | undefined =
          outcome === null || row.body === null
            ? undefined
            : {
                key: row.body.interjection_key,
                path: outcome.path,
                source: "person",
                receipt_id: receiptId,
                answered_by:
                  actingUserId === null
                    ? null
                    : await store.userPublicId(actingUserId),
                binding_id: outcome.repository.bindingId,
                workspace_slug: outcome.workspaceSlug,
                ...(outcome.workspace === null
                  ? {}
                  : { workspace_id: outcome.workspace.publicId }),
              };
        const command =
          session === null
            ? null
            : answerCommand({
                scope,
                session,
                interjectionId: row.publicId,
                answer: outcome?.text ?? answerText,
                userId: actingUserId,
                now,
                expiresAt: row.expiresAt,
                ...(interjection === undefined ? {} : { interjection }),
              });
        if (command !== null)
          commandIds.push((await store.queue(command)).publicId);
      }

      await store.audit({
        eventType: "agent.interjection_answered",
        actorUserId: actingUserId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        capability: "answer_interjection",
        outcome: "success",
        occurredAt: now,
        ip: ctx.clientIp ?? null,
        userAgent: null,
        requestId: ctx.requestId,
        detail: {
          interjectionId: row.publicId,
          runId: row.runPublicId,
          kind: row.kind,
          path: outcome?.path ?? null,
          source: "person",
          receiptId,
          ...(outcome === null
            ? {}
            : { bindingId: outcome.repository.bindingId }),
          ...(outcome?.workspace
            ? { workspaceId: outcome.workspace.publicId }
            : {}),
          commandIds,
        },
      });
      return { row, commandIds, receiptId };
    });

    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        interjectionId: result.row.publicId,
        runId: result.row.runPublicId,
        path: outcome?.path ?? null,
        receiptId: result.receiptId,
        commands: result.commandIds.length,
      },
      "answer_interjection: answered",
    );
    return {
      interjectionId: result.row.publicId,
      runId: result.row.runPublicId,
      answeredAt: now.toISOString(),
      commandIds: result.commandIds,
      receiptId: result.receiptId,
      path: outcome?.path ?? null,
      repository: outcome?.repository ?? null,
      workspace: outcome?.workspace ?? null,
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

/** A stored path, or null for anything the column should not hold. */
function pathOf(value: string | null): InterjectionPath | null {
  return (INTERJECTION_PATHS as readonly string[]).includes(value ?? "")
    ? (value as InterjectionPath)
    : null;
}

/**
 * Lock one question in the scope by either id form, whatever its state. The
 * timeout function reads the row the same way.
 */
export async function lockInterjection(
  tx: Tx,
  scope: RunScope,
  id: string,
): Promise<LockedInterjection | null> {
  const [row] = await tx
    .select({
      id: ij.id,
      publicId: ij.publicId,
      runPublicId: ij.runPublicId,
      answeredAt: ij.answeredAt,
      expiresAt: ij.expiresAt,
      kind: ij.kind,
      body: ij.body,
      repository: ij.repository,
      path: ij.path,
      receiptId: ij.receiptId,
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
  if (row === undefined) return null;
  const kind: InterjectionKind =
    row.kind === "repo_unknown" ? "repo_unknown" : "question";
  const body =
    kind === "repo_unknown" ? interjectBodySchema.safeParse(row.body) : null;
  return {
    id: row.id,
    publicId: row.publicId,
    runPublicId: row.runPublicId,
    answeredAt: row.answeredAt,
    expiresAt: row.expiresAt,
    kind,
    body: body?.success ? body.data : null,
    repository: row.repository ?? null,
    path: pathOf(row.path ?? null),
    receiptId: row.receiptId ?? null,
  };
}

export function postgresInterjectionAnswerStore(
  tx: Tx,
): InterjectionAnswerStore {
  const commands = postgresCommandStore(tx);
  return {
    lock: (scope, id) => lockInterjection(tx, scope, id),
    answer: async ({
      scope,
      id,
      answer,
      path,
      repository,
      receiptId,
      userId,
      now,
    }) => {
      const updated = await tx
        .update(ij)
        .set({
          answeredAt: now,
          answer,
          answeredByUserId: userId,
          path,
          receiptId,
          ...(repository === null ? {} : { repository }),
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
    userPublicId: async (userId) => {
      const [row] = await tx
        .select({ publicId: schema.users.publicId })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return row?.publicId ?? null;
    },
    linkedBinding: async (scope, fullName) => {
      const heads = schema.repositoryBindingHeads;
      const bindings = schema.repositoryBindings;
      const [row] = await tx
        .select({
          bindingId: bindings.publicId,
          fullName: bindings.providerFullName,
        })
        .from(heads)
        .innerJoin(bindings, eq(bindings.id, heads.currentBindingId))
        .where(
          and(
            eq(heads.orgId, scope.orgId),
            eq(heads.workspaceId, scope.workspaceId),
            eq(heads.provider, "github"),
            eq(heads.role, "linked"),
            sql`lower(${bindings.providerFullName}) = lower(${fullName})`,
          ),
        )
        .limit(1);
      return row ?? null;
    },
    audit: (event) => emitSecurityEventIn(tx, event),
  };
}

export const agentInterjectionAnswerHandler = createAnswerInterjectionHandler({
  withStore: (fn) =>
    withTenantDb((tx) => fn(postgresInterjectionAnswerStore(tx))),
  now: () => new Date(),
  mintReceipt: mintReceiptId,
  paths: {
    link: async (input, ctx) =>
      (await invoke(repositoryLink.name, input, ctx)) as RepositoryLinkOutput,
    create: async (input, ctx) =>
      (await invoke(workspaceCreate.name, input, ctx)) as WorkspaceCreateOutput,
  },
  resolveRepository: (scope, body) =>
    resolveInterjectionRepository(scope, body),
});
