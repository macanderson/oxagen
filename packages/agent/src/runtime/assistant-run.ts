/**
 * Every turn of the in-app agent is a run of its own (MC spec §14.1, §4.4;
 * ADR-053 §1): admitted in the evidence ledger before the engine is asked
 * anything, its completions and tool calls recorded as receipts keyed by the
 * engine frame's `seq`, and sealed when the engine's `turn_complete` arrives.
 *
 * The assistant is Oxagen's, and the customer talks to it without owning it.
 * So the run is attributed to the workspace's managed interactive agent
 * (`qa-chat`, `@oxagen/oxagen/interactive-agent`) acting through the
 * `oxagen.assistant` service principal, with the asking person's own
 * principal as the initiating principal. That pair is what the authorization
 * snapshot pins, and it is what keeps the turn out of the tenant's run lists:
 * `list_runs` excludes the two in-app surfaces (`chat`, `api-chat`), and
 * `list_recent_runs` reads through it.
 *
 * A turn the ledger cannot admit does not answer. `openAssistantRun` throws
 * `AssistantRunNotRecordedError` before the engine is contacted, and a receipt
 * that cannot be appended rejects the reverse request it belongs to, which
 * `runGovernedTurn` turns into a cancelled turn (mockup 10648: "the assistant
 * will not answer from a path that could not be recorded as a run").
 *
 * Billing: the turn's tokens are metered by the `@oxagen/ai` chokepoint on
 * the organisation's funding source (ADR-053 §3); the run itself is free to
 * the customer and its seal records `verdict: waived` — no witness judges an
 * explanation.
 */

import { schema, type Tx, withTenantDb } from "@oxagen/database";
import {
  createAgentRunAuthorizationSnapshot,
  readActiveKillSwitches,
  resourceScopeDigestOf,
} from "@oxagen/iam";
import { INTERACTIVE_AGENT_SLUG } from "@oxagen/oxagen/interactive-agent";
import { digestJcs } from "@oxagen/run-evidence";
import {
  canonicalJson,
  createPostgresRunStore,
  deferredAttester,
  digestOfCanonicalJson,
  parseRunSpecV2,
  RETENTION_CONTENT_CLASSES,
  TERMINAL_EVENT_TYPE,
  type AttemptEventBodyInput,
  type AttemptEventInput,
  type PlatformSurface,
  type ResolvedEngineIdentity,
  type RunStore,
  type ToolEngineCallOutcome,
} from "@oxagen/run-ledger";
import {
  deferredEvidenceArchive,
  deferredEvidenceBodies,
} from "@oxagen/run-ledger/evidence-store";
import { STELLA_SERVE_PINNED_VERSION } from "@oxagen/stella-engine-client";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, isNull } from "drizzle-orm";
import pino from "pino";
import type {
  ProjectRunContextArgs,
  ReadRunEvents,
} from "../dispatch/context-projection";
import type { AssistantSteeringFrame } from "./assistant-steering";
import {
  GOAL_VERDICT_EVENT_TYPE,
  goalVerdictPayload,
  type TurnLedgerGoalVerdict,
} from "./engine/goal";
import type { HistorySummaryFrame } from "./history-summary";
import { sendRunSealed } from "./run-sealed-event";
import type {
  TurnLedger,
  TurnLedgerModelCall,
  TurnLedgerModelIntent,
  TurnLedgerOutcome,
  TurnLedgerToolCall,
  TurnLedgerToolIntent,
} from "./governed-turn";

/** The service principal every assistant run acts through. */
export const ASSISTANT_PRINCIPAL_NAME = "oxagen.assistant";

/** The two surfaces an assistant turn is admitted on. */
export type AssistantRunSurface = Extract<PlatformSurface, "chat" | "api-chat">;

/**
 * ADR-058 decision 2 as a row: bodies of every content class, seven years
 * from the seal. `retention_policy_versions` is read workspace-latest
 * (`readWorkspaceRetention`), and a workspace with no row already behaves
 * exactly like this — so when the first assistant turn has to pin a policy
 * because the run spec needs one, this is the only row it can write without
 * changing what the workspace keeps.
 *
 * It used to write `digest_only` with a thirty-day TTL, reasoning that the
 * assistant's own receipts are digests anyway. That reasoning was sound about
 * assistant runs and wrong about everything else: the row is the workspace's
 * latest, so one assistant turn in a workspace that had never configured
 * retention silently opted the whole workspace down — every subsequent Tacho
 * run had its bodies refused and its replay grade fall to `inspect`, and
 * nobody chose it. There is no run-scoped or agent-scoped retention in this
 * model, so "a policy that is not the workspace's latest" cannot be
 * expressed; preserving the default is the only correct move.
 */
export const ASSISTANT_RETENTION_POLICY = {
  mode: "content_exact",
  retained_content_classes: [...RETENTION_CONTENT_CLASSES] as string[],
  // Seven years from the seal (ADR-058 decision 2, spec §13.1). The column is
  // NOT NULL, so the default has to be written as a number rather than left
  // absent.
  ttl_days: 365 * 7,
} as const;

/**
 * The engine identity pinned on the attempt. `stella-serve` reports no build
 * digest on its health routes, so the digest is over the identity the host
 * verified against: the engine name and the release the client is pinned to.
 * The pinned release is also the only version the run admits.
 */
export const ASSISTANT_ENGINE: ResolvedEngineIdentity = {
  name: "stella",
  version: STELLA_SERVE_PINNED_VERSION,
  buildDigest: digestJcs({
    name: "stella",
    surface: "serve",
    version: STELLA_SERVE_PINNED_VERSION,
  }),
};

/** A run's goal is the turn's instruction, bounded to the spec's ceiling. */
const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.assistant-run" },
});

const GOAL_MAX_CHARS = 8192;

/**
 * The summary of a thread's older messages, as the spec's context policy and
 * the `context.history_summarized` frame name it (`history-summary.ts`).
 */
export const HISTORY_SUMMARY_PROVIDER = "conversation_history";

/**
 * The context the turn frames, as the spec names it. `engram` is the
 * workspace memory `recallWorkspaceMemoryMessage` reads; `page` is the
 * page-context message the app's turn carries; `conversation_history` is the
 * summary of the messages older than the turn's history window (#4171). All
 * three are assembled in this process, which is why they are named here
 * rather than resolved from a provider registry the turn does not consult.
 */
export const ASSISTANT_CONTEXT_PROVIDERS = [
  "engram",
  "page",
  HISTORY_SUMMARY_PROVIDER,
] as const;

/**
 * One recalled-memory message, one page-context message and one history
 * summary, at most.
 */
export const ASSISTANT_MAX_CONTEXT_FRAMES = ASSISTANT_CONTEXT_PROVIDERS.length;

/**
 * The ceiling those frames are built under. Each is bounded at assembly: the
 * recall by its own row and query limits, the page context by the contract's
 * page-context schema, and the history summary by its output ceiling
 * (`HISTORY_SUMMARY_MAX_OUTPUT_TOKENS`). So this is the spec's statement of
 * the budget, not a second gate.
 */
export const ASSISTANT_MAX_CONTEXT_TOKENS = 8192;

export type AssistantRunNotRecordedReason =
  | "assistant_agent_missing"
  | "assistant_agent_inactive"
  | "operator_principal_missing"
  | "ledger_refused";

/** The turn was refused before the engine was asked: the ledger could not admit it. */
export class AssistantRunNotRecordedError extends Error {
  override readonly name = "AssistantRunNotRecordedError";
  readonly code = "assistant_run_not_recorded" as const;
  constructor(
    readonly reason: AssistantRunNotRecordedReason,
    detail: string,
    cause?: unknown,
  ) {
    super(`the assistant turn could not be recorded as a run: ${detail}`, {
      cause,
    });
  }
}

export interface AssistantRunScope {
  orgId: string;
  workspaceId: string;
}

export interface OpenAssistantRunArgs extends AssistantRunScope {
  /** The asking person; the run's initiating principal is their human principal. */
  userId: string;
  surface: AssistantRunSurface;
  /** This turn's user text; recorded as the run's goal. */
  instruction: string;
  /**
   * The goal a verifier judges the turn against, when the caller set one. It
   * is the run's goal in place of the instruction: it is what the run is
   * proven against, and the instruction stays on the first model frame.
   */
  goal?: string;
  /** The step cap the turn runs under; pinned on the spec. */
  maxSteps: number;
  /**
   * The capability names the turn materialised, as its tool policy. The spec
   * says what the run may call, so it has to be the set the turn actually
   * holds; an empty allowlist would read "no tools" on a run whose whole job
   * is calling them.
   */
  toolAllowlist: readonly string[];
  /**
   * The person's message that asked for the turn. The turn meters every model
   * call on this id (`token_usage.execution_step_id`), so the run records it
   * and the cost rollup reads the calls by it (#4167). Null for a run that
   * no message asked for, such as an approval's resume run, whose message
   * belongs to the turn that parked the call and is priced on that turn.
   */
  originMessageId: string | null;
  /**
   * Projects the windows the run recorded into Neo4j once it seals, as
   * USED_CONTEXT lineage (ADR-193). Best-effort: a failure is logged and
   * never fails or slows the seal. The in-app turn passes
   * `projectRunContextWindows`; a caller that passes none projects nothing.
   */
  projectContext?: ContextProjector;
  /** Test seams. Production leaves both unset. */
  store?: RunStore;
  now?: () => Date;
}

/** What the seal hands the context projection: the run, and a reader of its events. */
export type ContextProjector = (
  args: ProjectRunContextArgs,
  readEvents: ReadRunEvents,
) => Promise<unknown>;

/**
 * One reverse request as the recorder saw it, kept in arrival order so the
 * turn can build its `agent_executions` step rows from the same receipts the
 * seal attests to. The ledger holds digests; this holds the payloads the
 * execution record needs, and nothing leaves the process.
 */
export type AssistantRunReceipt =
  | ({ kind: "model" } & TurnLedgerModelCall)
  | ({ kind: "tool" } & TurnLedgerToolCall);

/** A recorded assistant run: the ledger hook the turn writes through, plus its ids. */
export interface AssistantRunRecorder extends TurnLedger {
  readonly runId: string;
  /** `arun_…`: what the flyout links and `get_run` opens. */
  readonly runPublicId: string;
  /**
   * The agent and version the run is attributed to — the same pair the spec's
   * `actor_binding` pins. `get_message_execution` needs them to write the
   * turn's `agent_executions` row against the agent that actually ran it.
   */
  readonly agentId: string;
  readonly agentVersionId: string;
  /**
   * Every model and tool receipt this recorder wrote, in the order the engine
   * asked. Read once, after the turn, to build the execution's steps.
   */
  readonly receipts: readonly AssistantRunReceipt[];
  /**
   * What the steering assembler put in this turn's prompt and what it cut
   * (ADR-093, #4158). Written before the engine is asked anything, so the
   * record states what the model was told even when the turn then fails.
   */
  steeringManifest(frame: AssistantSteeringFrame): Promise<void>;
  /**
   * The summary this turn carried in place of the messages older than its
   * history window, or why it carried an old one or none (#4171). Written
   * before the engine is asked anything, beside the steering manifest.
   */
  historySummary(frame: HistorySummaryFrame): Promise<void>;
}

/** What admission resolved about who acts and under which retention policy. */
export interface AssistantRunIdentity {
  agentId: string;
  agentPrincipalId: string;
  agentVersionId: string;
  agentVersionChecksum: string;
  initiatingPrincipalId: string;
  retention: { rowId: string; publicId: string; digest: string };
}

/**
 * The workspace's assistant agent as a kill switch names it, and the `agent`
 * switch that stops it, if one is on.
 */
export interface AssistantAgentState {
  /** Public id (`agt_…`): the id an `agent` switch is flipped on. */
  agentId: string;
  /** The `oxagen.assistant` principal, once a first turn provisioned it. */
  principalId: string | null;
  /** The active `agent` switch on the assistant, or null when none is on. */
  stoppedBy: { publicId: string; reason: string } | null;
}

/**
 * Read the assistant agent and whether an operator switched it off. Read only:
 * a workspace with no assistant agent answers null here and is refused later,
 * by `openAssistantRun`, as `assistant_agent_missing`. The turn refuses a
 * stopped assistant before it writes anything (assistant-turn.ts) and passes
 * the rest to `materializeTools` as the agent the turn acts as.
 */
export async function readAssistantAgentState(
  tx: Tx,
  scope: AssistantRunScope,
): Promise<AssistantAgentState | null> {
  const [agent] = await tx
    .select({
      publicId: schema.agents.publicId,
      principalId: schema.agents.principalId,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
        eq(schema.agents.slug, INTERACTIVE_AGENT_SLUG),
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);
  if (!agent) return null;
  // `set_kill_switch` writes an `agent` switch as a resource-scope deny over
  // this digest (kill_switch.set.ts), so the digest is what identifies it.
  const digest = resourceScopeDigestOf({ kind: "agent", id: agent.publicId });
  const switches = await readActiveKillSwitches(tx, scope);
  const hit = switches.find((s) => s.resourceScopeDigest === digest);
  return {
    agentId: agent.publicId,
    principalId: agent.principalId,
    stoppedBy: hit ? { publicId: hit.publicId, reason: hit.reason } : null,
  };
}

/**
 * Resolve the identities an assistant run is admitted under, provisioning
 * the `oxagen.assistant` service principal and the workspace's digest-only
 * retention policy the first time a turn runs there. Exported for its test;
 * `openAssistantRun` is the caller.
 */
export async function resolveAssistantRunIdentity(
  tx: Tx,
  scope: AssistantRunScope,
  userId: string,
): Promise<AssistantRunIdentity> {
  const [agent] = await tx
    .select({
      id: schema.agents.id,
      status: schema.agents.status,
      principalId: schema.agents.principalId,
      activeVersionId: schema.agents.activeVersionId,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
        eq(schema.agents.slug, INTERACTIVE_AGENT_SLUG),
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);
  if (!agent || !agent.activeVersionId) {
    throw new AssistantRunNotRecordedError(
      "assistant_agent_missing",
      `the workspace has no published ${INTERACTIVE_AGENT_SLUG} agent`,
    );
  }
  // A retired assistant, or one whose principal is suspended, would pass the
  // reads below and fail inside the authorization snapshot, which refuses a
  // non-active principal. Name the cause here instead (#4350).
  if (agent.status === "archived") {
    throw new AssistantRunNotRecordedError(
      "assistant_agent_inactive",
      `the workspace's ${INTERACTIVE_AGENT_SLUG} agent is retired`,
    );
  }
  if (agent.principalId !== null) {
    const [principal] = await tx
      .select({ status: schema.principals.status })
      .from(schema.principals)
      .where(eq(schema.principals.id, agent.principalId))
      .limit(1);
    if (principal?.status !== "active") {
      throw new AssistantRunNotRecordedError(
        "assistant_agent_inactive",
        `the ${INTERACTIVE_AGENT_SLUG} agent's ${ASSISTANT_PRINCIPAL_NAME} principal is ${principal?.status ?? "missing"}`,
      );
    }
  }

  const [version] = await tx
    .select({
      id: schema.agentVersions.id,
      config: schema.agentVersions.config,
    })
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.id, agent.activeVersionId))
    .limit(1);
  if (!version) {
    throw new AssistantRunNotRecordedError(
      "assistant_agent_missing",
      `the ${INTERACTIVE_AGENT_SLUG} agent's active version is not readable`,
    );
  }

  const [operator] = await tx
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, scope.orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.kind, "human"),
      ),
    )
    .limit(1);
  if (!operator) {
    throw new AssistantRunNotRecordedError(
      "operator_principal_missing",
      "the asking user has no human principal in this organisation",
    );
  }

  const agentPrincipalId =
    agent.principalId ??
    (await provisionAssistantPrincipal(tx, scope, agent.id));

  const retention = await resolveRetentionPolicy(tx, scope, userId);

  return {
    agentId: agent.id,
    agentPrincipalId,
    agentVersionId: version.id,
    agentVersionChecksum: digestJcs(version.config),
    initiatingPrincipalId: operator.id,
    retention,
  };
}

/**
 * One `oxagen.assistant` service principal per workspace, linked from the
 * managed agent row. Two first turns racing here both insert; the one whose
 * link lands keeps its row, the other deletes what it inserted and reads the
 * winner's.
 */
async function provisionAssistantPrincipal(
  tx: Tx,
  scope: AssistantRunScope,
  agentId: string,
): Promise<string> {
  const [principal] = await tx
    .insert(schema.principals)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      kind: "service",
      displayName: ASSISTANT_PRINCIPAL_NAME,
      parentUserId: null,
    })
    .returning({ id: schema.principals.id });
  if (!principal) {
    throw new AssistantRunNotRecordedError(
      "ledger_refused",
      "the assistant service principal could not be created",
    );
  }
  const [linked] = await tx
    .update(schema.agents)
    .set({ principalId: principal.id })
    .where(
      and(eq(schema.agents.id, agentId), isNull(schema.agents.principalId)),
    )
    .returning({ principalId: schema.agents.principalId });
  if (linked?.principalId === principal.id) return principal.id;

  await tx
    .delete(schema.principals)
    .where(eq(schema.principals.id, principal.id));
  const [winner] = await tx
    .select({ principalId: schema.agents.principalId })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  if (!winner?.principalId) {
    throw new AssistantRunNotRecordedError(
      "ledger_refused",
      "the assistant service principal could not be linked",
    );
  }
  return winner.principalId;
}

/**
 * The workspace's newest retention policy version, or version 1 of
 * `ASSISTANT_RETENTION_POLICY` when it has none. The digest unique index
 * makes two first turns resolve to one row.
 */
async function resolveRetentionPolicy(
  tx: Tx,
  scope: AssistantRunScope,
  userId: string,
): Promise<AssistantRunIdentity["retention"]> {
  const rpv = schema.retentionPolicyVersions;
  const read = async () => {
    const [row] = await tx
      .select({ id: rpv.id, publicId: rpv.publicId, digest: rpv.policyDigest })
      .from(rpv)
      .where(
        and(eq(rpv.orgId, scope.orgId), eq(rpv.workspaceId, scope.workspaceId)),
      )
      .orderBy(desc(rpv.version))
      .limit(1);
    return row
      ? { rowId: row.id, publicId: row.publicId, digest: row.digest }
      : null;
  };
  const existing = await read();
  if (existing) return existing;

  await tx
    .insert(rpv)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      version: 1,
      mode: ASSISTANT_RETENTION_POLICY.mode,
      retainedContentClasses: [
        ...ASSISTANT_RETENTION_POLICY.retained_content_classes,
      ],
      ttlDays: ASSISTANT_RETENTION_POLICY.ttl_days,
      policyDigest: digestJcs(ASSISTANT_RETENTION_POLICY),
      createdById: userId,
    })
    .onConflictDoNothing();
  const created = await read();
  if (!created) {
    throw new AssistantRunNotRecordedError(
      "ledger_refused",
      "the workspace retention policy could not be pinned",
    );
  }
  return created;
}

/**
 * Admit the turn as a run and open its attempt. Resolves before the engine
 * is contacted; a failure here is the refusal the flyout shows.
 */
export async function openAssistantRun(
  args: OpenAssistantRunArgs,
): Promise<AssistantRunRecorder> {
  const scope = { orgId: args.orgId, workspaceId: args.workspaceId };
  // The archive is not optional here: this recorder SEALS its attempt, and a
  // sealing store with no archive refuses in `sealAttemptInTx` — after the
  // model has answered and the tokens have been charged. Built without one,
  // every assistant turn produced a reply, billed it, then threw
  // `run_store_state_invalid`, which the app's kernel seam reports to the
  // person as the generic "could not be reached". `deferredEvidenceArchive`
  // rather than `evidenceStore()` because this module is constructed on a
  // path that does not always seal, and the deferred seam opens the storage
  // driver only when a segment is actually written.
  const store = args.store ?? assistantRunStore();
  const now = args.now ?? (() => new Date());
  const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
    runInTenantScope(scope, fn);

  let identity: AssistantRunIdentity;
  try {
    identity = await inScope(() =>
      withTenantDb((tx) => resolveAssistantRunIdentity(tx, scope, args.userId)),
    );
  } catch (err) {
    throw loggedRefusal(
      scope,
      err instanceof AssistantRunNotRecordedError
        ? err
        : new AssistantRunNotRecordedError(
            "ledger_refused",
            errorMessage(err),
            err,
          ),
    );
  }

  try {
    const snapshot = await inScope(() =>
      createAgentRunAuthorizationSnapshot({
        ...scope,
        initiatingPrincipalId: identity.initiatingPrincipalId,
        agentPrincipalId: identity.agentPrincipalId,
        now: now(),
      }),
    );
    const spec = parseRunSpecV2({
      version: 2,
      run_kind: "general",
      goal: goalOf(args.goal ?? args.instruction),
      engine_policy: {
        requested_engine: ASSISTANT_ENGINE.name,
        allowed_engine_versions: [ASSISTANT_ENGINE.version],
        model_policy_ref: "assistant.funding_source",
        max_steps: args.maxSteps,
        max_attempts: 1,
      },
      actor_binding: {
        initiating_principal_id: identity.initiatingPrincipalId,
        agent_principal_id: identity.agentPrincipalId,
        agent_id: identity.agentId,
        agent_version_id: identity.agentVersionId,
        agent_version_checksum: identity.agentVersionChecksum,
      },
      authorization_snapshot_ref: {
        snapshot_id: snapshot.snapshotId,
        snapshot_digest: snapshot.snapshotDigest,
        grant_ceiling_digest: snapshot.grantCeilingDigest,
        deny_generation_at_admission: {
          org: String(snapshot.denyGenerationAtAdmission.org),
          workspace: String(snapshot.denyGenerationAtAdmission.workspace),
        },
        resolved_at: snapshot.resolvedAt,
      },
      // What this turn actually ran under (ADR-076). The spec is what the
      // seal attests to, so every value here is the one the turn holds, not a
      // placeholder: an unsandboxed run that pins `sandbox_required: true`,
      // frames one memory and one page-context message under `max_frames: 0`,
      // and calls the governed catalogue under an empty allowlist, is a run
      // whose own evidence contradicts it.
      workspace_policy: { sandbox_required: false },
      context_policy: {
        provider_allowlist: [...ASSISTANT_CONTEXT_PROVIDERS],
        max_frames: ASSISTANT_MAX_CONTEXT_FRAMES,
        max_tokens: ASSISTANT_MAX_CONTEXT_TOKENS,
        retention_policy_id: identity.retention.publicId,
        retention_policy_digest: identity.retention.digest,
      },
      tool_policy: {
        allowlist: [...new Set(args.toolAllowlist)].sort(),
        // Nothing in the turn filters by risk; a write that needs a person
        // parks rather than being refused for its risk level.
        risk_ceiling: "high",
      },
    });

    const run = await inScope(() =>
      store.createRun({
        ...scope,
        surface: args.surface,
        spec,
        retentionPolicyRowId: identity.retention.rowId,
        repositoryBindingRowId: null,
        originMessageId: args.originMessageId,
      }),
    );
    // From here the run row exists and the caller does not hold a recorder it
    // could seal, so every later step is guarded: a transient ledger failure
    // during admission itself would otherwise leave the run — and its attempt,
    // if it got that far — open for ever, which is the same defect as a
    // preflight refusal after admission (assistant-turn.ts) and is the reason
    // this is a guard around the whole tail rather than a fix at one step.
    let attempt: Awaited<ReturnType<typeof store.createAttempt>>;
    try {
      attempt = await inScope(() =>
        store.createAttempt({
          runId: run.runId,
          producerId: ASSISTANT_PRINCIPAL_NAME,
          engine: ASSISTANT_ENGINE,
        }),
      );
    } catch (err) {
      // No attempt exists, so there is nothing to seal: drive the run itself
      // to `failed`, which is what `finishRun` is for.
      await terminalizeUnattemptedRun(store, inScope, run.runId, err);
      throw err;
    }
    const recorder = new Recorder(
      store,
      scope,
      inScope,
      now,
      run,
      attempt.attemptId,
      {
        agentId: identity.agentId,
        agentVersionId: identity.agentVersionId,
      },
      args.projectContext === undefined
        ? undefined
        : {
            // The turn's message is the :Execution the recall's citations
            // hang on; a run no message asked for anchors on itself.
            executionRef: args.originMessageId ?? run.publicId,
            project: args.projectContext,
          },
    );
    try {
      await recorder.append({
        eventType: "admission.run_admitted",
        payload: {
          attempt_public_id: attempt.attemptPublicId,
          attempt_number: attempt.attemptNumber,
          max_attempts: attempt.maxAttempts,
          spec_digest: run.specDigest,
          authorization_snapshot_digest: snapshot.snapshotDigest,
          grant_ceiling_digest: snapshot.grantCeilingDigest,
          engine_name: ASSISTANT_ENGINE.name,
          engine_version: ASSISTANT_ENGINE.version,
          engine_build_digest: ASSISTANT_ENGINE.buildDigest,
        },
      });
    } catch (err) {
      // The attempt exists, so sealing it is the terminal record — and the
      // seal drives the run terminal too.
      await recorder
        .seal({ status: "failed", error: errorMessage(err) })
        .catch((sealErr: unknown) => {
          logger.error(
            { err: sealErr, runId: run.publicId },
            "admission failed and the attempt could not be sealed; run left open",
          );
        });
      throw err;
    }
    return recorder;
  } catch (err) {
    throw loggedRefusal(
      scope,
      new AssistantRunNotRecordedError(
        "ledger_refused",
        errorMessage(err),
        err,
      ),
    );
  }
}

/**
 * Log a refused admission and hand the error back to throw. The flyout shows
 * one sentence for every refusal, so this line is the only place the cause is
 * written down: a retired assistant agent refused every turn in a workspace
 * for over an hour on 2026-09-25 and left nothing in the logs (#4350).
 */
function loggedRefusal(
  scope: AssistantRunScope,
  err: AssistantRunNotRecordedError,
): AssistantRunNotRecordedError {
  logger.warn(
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      reason: err.reason,
      err,
    },
    "assistant turn not admitted: the run could not be recorded",
  );
  return err;
}

/**
 * The run store the in-app assistant records through.
 *
 * Both seams are required, and the body one is load-bearing: the assistant's
 * frames carry bodies and `ASSISTANT_RETENTION_POLICY` retains every content
 * class, so a store built without `bodies` refuses the first frame of every
 * turn (`resolveBodyColumns` raises rather than silently downgrading a run
 * the workspace asked to keep content for). Exported so a test can assert
 * both are present without opening a storage driver.
 */
export function assistantRunStore(): RunStore {
  return createPostgresRunStore({
    archive: deferredEvidenceArchive,
    bodies: deferredEvidenceBodies,
    // The assistant seals its own attempts, so its seals are signed when a
    // key is configured (ADR-195).
    attester: deferredAttester,
  });
}

/**
 * A run admitted with no attempt behind it. `sealAttempt` cannot reach it, so
 * the run is finished directly; a failure here is logged with the run's public
 * id, because the alternative is losing the only handle on an open run.
 */
async function terminalizeUnattemptedRun(
  store: RunStore,
  inScope: <T>(fn: () => Promise<T>) => Promise<T>,
  runId: string,
  cause: unknown,
): Promise<void> {
  try {
    await inScope(() => store.finishRun(runId, "failed", errorMessage(cause)));
  } catch (err) {
    logger.error(
      { err, runId },
      "admission could not create an attempt and the run could not be finished; run left open",
    );
  }
}

type PendingEvent = Pick<AttemptEventInput, "eventType" | "payload" | "body">;

/**
 * The most bytes one frame body may carry, matching `TACHO_MAX_BODY_BYTES`
 * on the host side so an in-app run and a wrapped one are capped alike. A
 * body past it is not written at all: the payload's own `*_digest` still
 * names the content, and the seal derives `body_missing` from the frame, so
 * a reader sees a size limit rather than a recorder that never captured. The
 * alternative — truncating — would write bytes whose digest names nothing
 * that ever existed and whose JSON no reader can parse.
 */
export const ASSISTANT_MAX_BODY_BYTES = 1_048_576;

const bodyEncoder = new TextEncoder();

/**
 * The content of a frame as a body the ledger can redact, digest and retain
 * (MC spec §8.2). Canonical JSON, so the same content always serialises to
 * the same bytes and therefore the same digest.
 *
 * `undefined` when there is nothing to record or when the content is past
 * the cap, and `append` then writes the frame with its receipt alone. A
 * value `canonicalJson` refuses — a non-finite number, a cycle — is treated
 * the same way and logged: a frame with no body is a smaller loss than a
 * turn that fails because its evidence could not be serialised.
 */
function jsonBody(
  eventType: string,
  content: unknown,
): AttemptEventBodyInput | undefined {
  if (content === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = bodyEncoder.encode(canonicalJson(content));
  } catch (err) {
    logger.warn(
      { err, eventType },
      "frame content could not be canonicalised; the frame is recorded without a body",
    );
    return undefined;
  }
  if (bytes.byteLength > ASSISTANT_MAX_BODY_BYTES) {
    logger.info(
      { eventType, bytes: bytes.byteLength, cap: ASSISTANT_MAX_BODY_BYTES },
      "frame content is past the body cap; the frame is recorded without a body",
    );
    return undefined;
  }
  return { contentType: "application/json", bytes };
}

/**
 * Appends run in the order the engine's frames arrived, one transaction each,
 * chained so `attempt_seq` stays dense. A write takes its seq when the one
 * before it has settled, and the counter moves only past a durable event, so a
 * failed append leaves its seq to the next event and the seal: the store
 * refuses any seq past `lastAttemptSeq + 1`. Every write is awaited by the
 * reverse request it belongs to, so an answer never reaches the engine before
 * its receipt is durable.
 */
class Recorder implements AssistantRunRecorder {
  readonly runId: string;
  readonly runPublicId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  /** Append-only, in engine-frame order; the turn reads it once, after. */
  readonly receipts: AssistantRunReceipt[] = [];
  /** The seq the next event takes: one past the last durable event. */
  private nextSeq = 1;
  private chain: Promise<void> = Promise.resolve();
  /**
   * Latched by `seal`. The seal reads the chain once and then takes a seq, so
   * an append that arrived during that await would chain onto the older value
   * and could take a seq at or past the terminal event's, which the store
   * refuses. No caller reaches it today — `runGovernedTurn` awaits every
   * receipt before the outcome that seals — and this makes that falsifiable
   * rather than a comment nobody can check.
   */
  private sealed = false;

  constructor(
    private readonly store: RunStore,
    private readonly scope: AssistantRunScope,
    private readonly inScope: <T>(fn: () => Promise<T>) => Promise<T>,
    private readonly now: () => Date,
    run: { runId: string; publicId: string },
    private readonly attemptId: string,
    actor: { agentId: string; agentVersionId: string },
    /** The USED_CONTEXT projection run after the seal (ADR-193); absent, none. */
    private readonly lineage?: {
      executionRef: string;
      project: ContextProjector;
    },
  ) {
    this.runId = run.runId;
    this.runPublicId = run.publicId;
    this.agentId = actor.agentId;
    this.agentVersionId = actor.agentVersionId;
  }

  append(event: PendingEvent): Promise<void> {
    if (this.sealed) {
      return Promise.reject(
        new AssistantRunNotRecordedError(
          "ledger_refused",
          `attempt already sealed; ${event.eventType} arrived after the terminal event`,
        ),
      );
    }
    const write = this.chain.then(async () => {
      const attemptSeq = this.nextSeq;
      try {
        await this.inScope(() =>
          this.store.appendAttemptBatch({
            attemptId: this.attemptId,
            events: [
              {
                attemptSeq,
                eventType: event.eventType,
                observedAt: this.now().toISOString(),
                payload: event.payload,
                ...(event.body !== undefined ? { body: event.body } : {}),
              },
            ],
          }),
        );
      } catch (err) {
        throw new AssistantRunNotRecordedError(
          "ledger_refused",
          errorMessage(err),
          err,
        );
      }
      this.nextSeq = attemptSeq + 1;
    });
    // A failed append fails the request that owns it; the chain itself keeps
    // going so the seal can still be attempted with what was recorded.
    this.chain = write.catch(() => undefined);
    return write;
  }

  /**
   * The assembler's manifest as a `steering.manifest` frame, the kind a
   * wrapped agent's host seals for the same account. The payload is the
   * manifest's summary and digests: the text the model read, the manifest
   * itself, and the workspace instructions when they were a candidate. The
   * manifest, one item per candidate with its outcome and the reason for a
   * cut, is the frame's body, which the Run page's Context tab reads.
   */
  steeringManifest(frame: AssistantSteeringFrame): Promise<void> {
    const eventType = "steering.manifest";
    const { manifest } = frame;
    return this.append({
      eventType,
      payload: {
        schema: manifest.schema,
        delivers: manifest.delivers,
        budget_tokens: manifest.budget_tokens,
        spent_tokens: manifest.spent_tokens,
        included: manifest.included,
        cut: manifest.cut,
        text_digest: manifest.text_digest,
        manifest_digest: digestOfCanonicalJson(manifest),
        ...(frame.instructionsDigest
          ? { instructions_digest: frame.instructionsDigest }
          : {}),
        ...(frame.unavailableKinds.length > 0
          ? { unavailable_kinds: [...frame.unavailableKinds] }
          : {}),
      },
      body: jsonBody(eventType, manifest),
    });
  }

  /**
   * The history summary as a context frame: the digest of the exact summary,
   * how many messages it stands in for, how many the turn carried word for
   * word, and whether this turn wrote it. The summary itself is the frame's
   * body. A turn that carried none writes no body.
   */
  historySummary(frame: HistorySummaryFrame): Promise<void> {
    const eventType = "context.history_summarized";
    return this.append({
      eventType,
      payload: {
        provider: HISTORY_SUMMARY_PROVIDER,
        outcome: frame.outcome,
        ...(frame.digest !== null && frame.chars !== null
          ? { summary_digest: frame.digest, summary_chars: frame.chars }
          : {}),
        covered_message_count: frame.coveredMessages,
        window_message_count: frame.windowMessages,
        regenerated: frame.regenerated,
        ...(frame.reasonCode ? { reason_code: frame.reasonCode } : {}),
      },
      body: frame.text === null ? undefined : jsonBody(eventType, frame.text),
    });
  }

  /**
   * Write-ahead intention, appended before the provider is contacted.
   * Deliberately NOT pushed onto `receipts`, for the same reason
   * `toolCallStarted` is not: that array becomes the turn's
   * `agent_executions` steps, and counting the intention there would report
   * every completion twice. The durable evidence is the event.
   */
  modelCallStarted(record: TurnLedgerModelIntent): Promise<void> {
    const eventType = "model.engine_call_started";
    return this.append({
      eventType,
      payload: {
        engine_seq: record.seq,
        model_call_id: record.requestId,
        role: record.role,
        provider: record.provider,
        model: record.model,
        // The request's window, block by block (ADR-193). It is the record
        // `get_run_context` reads: bytes and items only, with the tokens
        // divided from the completion's reported total when it is read.
        ...(record.window ? { window: record.window } : {}),
      },
      // The request, and so the turn's prompt, rides the write-ahead frame
      // rather than the completion: it is what was asked, and it is already
      // durable when the provider is contacted, so a turn that dies mid-call
      // still says what it was asked to do.
      body: jsonBody(eventType, record.request),
    });
  }

  modelCall(record: TurnLedgerModelCall): Promise<void> {
    this.receipts.push({ kind: "model", ...record });
    const eventType = "model.engine_call_completed";
    return this.append({
      eventType,
      payload: {
        engine_seq: record.seq,
        model_call_id: record.requestId,
        role: record.role,
        provider: record.provider,
        model: record.model,
        outcome: record.outcome,
        ...(record.usage
          ? {
              input_tokens: record.usage.input_tokens,
              output_tokens: record.usage.output_tokens,
              cached_input_tokens: record.usage.cached_input_tokens ?? 0,
            }
          : {}),
      },
      // The completion, not the request: duplicating the messages onto both
      // frames would double the largest bytes a turn writes. This is the
      // frame `isContentBearingFrame` requires a body on, which is what
      // carries a run from `inspect` to `view`.
      //
      // A call that was cancelled, refused by the budget, or failed before
      // the provider answered has no response, and its body is `null`: the
      // provider returned nothing, and the record says so. `toolCall` does
      // the same with a denied call's missing error. Writing no body at all
      // read as lost content, and sealed a fully recorded run `inspect`.
      // A completed call always had an answer, so one that arrives without
      // it writes no body and the seal reports the loss.
      body: jsonBody(
        eventType,
        record.outcome === "completed"
          ? record.response
          : (record.response ?? null),
      ),
    });
  }

  /**
   * Write-ahead intention, appended before the tool runs. Deliberately NOT
   * pushed onto `receipts`: that array is what `stepsFromReceipts` turns into
   * the turn's `agent_executions` steps, and counting the intention there
   * would report every tool call twice. The durable evidence is the event.
   */
  toolCallStarted(record: TurnLedgerToolIntent): Promise<void> {
    const eventType = "tool.engine_call_started";
    return this.append({
      eventType,
      payload: {
        engine_seq: record.seq,
        tool_call_id: record.requestId,
        tool_name: record.toolName,
        ...(record.toolAlias ? { tool_alias: record.toolAlias } : {}),
        input_digest: digestJcs(record.input ?? null),
      },
      // What the tool was called with, on the frame that is durable before
      // the tool runs, so a side effect that commits is never recorded
      // without the arguments that caused it.
      body: jsonBody(eventType, record.input ?? null),
    });
  }

  toolCall(record: TurnLedgerToolCall): Promise<void> {
    this.receipts.push({ kind: "tool", ...record });
    const eventType = "tool.engine_call_completed";
    return this.append({
      eventType,
      payload: {
        engine_seq: record.seq,
        tool_call_id: record.requestId,
        tool_name: record.toolName,
        // The registry lists the outcomes the ledger accepts. An outcome the
        // turn adds without it fails to compile here, rather than refusing the
        // receipt and cancelling the turn at run time.
        outcome: record.outcome satisfies ToolEngineCallOutcome,
        // The approval a parked call waits on, so the Run page can say which
        // one. Only a parked receipt carries it; the registry refuses it on
        // any other outcome.
        ...(record.outcome === "parked" && record.approvalPublicId
          ? { approval_public_id: record.approvalPublicId }
          : {}),
        input_digest: digestJcs(record.input ?? null),
        ...(record.outcome === "completed"
          ? { output_digest: digestJcs(record.output ?? null) }
          : { error_digest: digestJcs(record.error ?? null) }),
        duration_ms: Math.max(0, Math.round(record.durationMs)),
      },
      // What came back — the output, or the error when the call failed.
      // The input is on the intention frame above; recording it twice would
      // double every tool argument in the run.
      body: jsonBody(
        eventType,
        record.outcome === "completed"
          ? (record.output ?? null)
          : (record.error ?? null),
      ),
    });
  }

  /**
   * One verifier round of a goal-shaped turn. The payload carries the round,
   * the verdict and the digests; the goal and the verifier's reasoning are
   * the body, so a reader of the run can see why the verifier said what it
   * said. Not a receipt: a verdict is no model or tool step of the turn.
   */
  goalVerdict(record: TurnLedgerGoalVerdict): Promise<void> {
    const eventType = GOAL_VERDICT_EVENT_TYPE;
    return this.append({
      eventType,
      payload: goalVerdictPayload(record),
      body: jsonBody(eventType, {
        goal: record.goal,
        reasoning: record.reasoning,
      }),
    });
  }

  async seal(outcome: TurnLedgerOutcome): Promise<void> {
    // Latch before the await, not after: an append queued while `this.chain`
    // settles would otherwise chain onto the value read here and race the
    // terminal event for a seq.
    this.sealed = true;
    await this.chain;
    const attemptSeq = this.nextSeq;
    const terminalStatus =
      outcome.status === "completed"
        ? "completed"
        : outcome.status === "aborted"
          ? "cancelled"
          : "failed";
    await this.inScope(async () => {
      await this.store.sealAttempt({
        attemptId: this.attemptId,
        terminalStatus,
        sealerId: ASSISTANT_PRINCIPAL_NAME,
        ...(outcome.status === "completed"
          ? { result: { verdict: "waived" } }
          : {
              error:
                outcome.status === "aborted" ? outcome.reason : outcome.error,
            }),
        terminalEvent: {
          attemptSeq,
          eventType: TERMINAL_EVENT_TYPE,
          observedAt: this.now().toISOString(),
          payload: {
            terminal_status: terminalStatus,
            ...(outcome.status === "completed"
              ? {
                  result_digest: digestJcs({
                    verdict: "waived",
                    text: outcome.text,
                  }),
                }
              : {
                  reason_code:
                    outcome.status === "aborted"
                      ? "engine_aborted"
                      : "turn_failed",
                  error_digest: digestJcs(
                    outcome.status === "aborted"
                      ? outcome.reason
                      : outcome.error,
                  ),
                }),
          },
        },
      });
    });
    // After the commit, as every other seal path sends it: the rollup builds
    // the run's cost row now rather than at the nightly sweep (#4167).
    await sendRunSealed({
      name: "cost/run.sealed",
      data: {
        runId: this.runPublicId,
        orgId: this.scope.orgId,
        workspaceId: this.scope.workspaceId,
      },
    });
    this.projectContext();
  }

  /**
   * USED_CONTEXT lineage for the windows this run recorded (ADR-193), read
   * back from the ledger it just sealed. Not awaited: a graph that is slow or
   * down must never hold or fail a seal, and no read depends on the edges.
   */
  private projectContext(): void {
    const lineage = this.lineage;
    if (lineage === undefined) return;
    const readEvents: ReadRunEvents = (runId, afterRunSeq, limit) =>
      this.store.readAttemptEventsSince(runId, afterRunSeq, limit);
    void this.inScope(() =>
      lineage.project(
        {
          runId: this.runId,
          runPublicId: this.runPublicId,
          executionRef: lineage.executionRef,
        },
        readEvents,
      ),
    ).catch((err: unknown) => {
      logger.warn(
        { err, runId: this.runPublicId },
        "context projection failed; the run's frames are still the record",
      );
    });
  }
}

function goalOf(instruction: string): string {
  const trimmed = instruction.trim();
  const goal = trimmed.length > 0 ? trimmed : "(empty turn)";
  return goal.length > GOAL_MAX_CHARS ? goal.slice(0, GOAL_MAX_CHARS) : goal;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
