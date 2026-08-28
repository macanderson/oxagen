/**
 * Platform turn driver — agent-engine v2 Phase 2 integration
 * (docs/specs/agent-engine-v2/plan.md, "Phase 2 — Durable runs"; ADR-033).
 *
 * `createPlatformTurnDriver()` builds the `TurnDriver` that
 * `@oxagen/agent-worker`'s durable-run harness (`createAgentWorker`) invokes
 * for every claimed run: deserialize + validate the run's `spec` (RunSpec v1,
 * below), run the turn through the SAME entrypoint every other platform
 * surface uses (`executeTurn` from `@oxagen/agent-runner` — the seam
 * `apps/api/src/routes/v1/chat.stream.ts` also calls), and report back via
 * the worker's injected `io` (event sink + abort signal).
 *
 * ## RunSpec v1 — the fixed wire contract
 *
 * The contract lives in ONE place —
 * `@oxagen/agent-runner`'s `run-spec-v1-legacy.ts` — shared by the enqueuing
 * API route and this claim-side driver (see
 * docs/specs/run-evidence-ingress/02-run-attempt-foundation-plan.md, Task 6).
 * `parseRunSpec` below is a re-export kept for the existing importers; see
 * that module for the schema,
 * for why v1 rows are explicitly NON-EVIDENCE, and for why they can never be
 * promoted to v2. The shape it accepts:
 *
 * ```json
 * {
 *   "version": 1,
 *   "instruction": "<string>",
 *   "model": "<optional string>",
 *   "history": ["...optional ModelMessage[]..."],
 *   "toolPolicy": { "allowlist": ["cap", ...], "riskCeiling": "low|medium|high" },
 *   "delegation": { "agentId": "agt_… | uuid", "userId": "<enqueuing user id>" }
 * }
 * ```
 *
 * `delegation` (Agent RBAC Phase 2b, docs/specs/agent-rbac/spec.md §3.4/§3.5)
 * is optional and additive: `userId` is the human who enqueued the run
 * (stamped by the enqueue route from its authenticated ctx — the run record
 * itself carries no principal columns, so the spec is where it rides), and
 * `agentId` names the deployed agent identity the run acts as. When
 * `delegation.agentId` is present this driver resolves the two-principal
 * AgentRunIAMContext (agent principal + initiating human), prefetches the
 * once-per-run authz snapshot, and attaches it as `ctx.agentRun` — activating
 * kernel IAM enforcement for every capability the turn invokes AND the
 * materializeTools model-facing tool filter, both reading the ONE cached
 * resolution (§3.5). A delegated run whose agent identity cannot be resolved
 * to a live agent principal FAILS (thrown → failRun) rather than running
 * ungoverned. A spec with no `delegation.agentId` behaves exactly as before
 * this field existed (no agentRun on the context; kernel treats the turn as
 * the pre-agent-RBAC runner surface).
 *
 * A v1 `delegation.userId` that is absent resolves the human side of the
 * ceiling to the UNPRIVILEGED SENTINEL, never to the agent's creator — see
 * `resolveAgentRunAuthzContext`'s header in `@oxagen/iam` for why binding the
 * creator is a privilege-escalation path.
 *
 * `run.orgId`/`run.workspaceId`/`run.surface` ride on the `ClaimedRun` row,
 * not inside `spec` — v1 runs are always enqueued with `surface: "api-chat"`
 * (conversational chat turns dispatched to the durable worker instead of run
 * in-request).
 *
 * ## This driver executes v1 ONLY
 *
 * A v2 claim reaching `createPlatformTurnDriver` is refused, not adapted. The
 * v1 harness writes through `appendEvents` — run-global `seq`, no attempt, no
 * digest, `ON CONFLICT DO NOTHING` — and a v2 run's evidence chain requires
 * every event to be fenced to an immutable attempt. Executing one through the
 * other would produce a run whose seal covers events it never governed. The v2
 * execution path is `@oxagen/agent-worker`'s `AttemptTurnDriver`, and it stays
 * disabled until PR 2B (see `main.ts`).
 *
 * What this file DOES contribute to v2 is `hydrateAgentRunContext` — the
 * pre-flight that turns a claimed v2 run's TYPED columns into the
 * `CapabilityContext.agentRun` binding, after proving the columns and the
 * stored spec still agree.
 *
 * ## What this v1 driver deliberately does NOT do (explicit follow-ups)
 *
 * - **No mid-turn checkpoint.** `io.checkpoint` is never called. The
 *   in-process TS engine (`runCodingAgent`, reached via `executeTurn`) owns
 *   its whole turn loop and has no serializable mid-turn state to hand back —
 *   that capability arrives with the Phase 3 embedded Stella core's
 *   step-scoped `run_step` API (spec.md §4.3/§6). Until then, crash-resume
 *   for a run this driver owns is a FULL RE-RUN from the top, bounded by the
 *   run's `attempts` counter (`MAX_RUN_ATTEMPTS = 3`,
 *   `packages/agent-runner/src/run-store.ts`) — acceptable for a
 *   conversational turn, but with two consequences:
 *     - Any capability tool the model already called with a mutating effect
 *       (a record created, a message sent, etc.) MAY RE-EXECUTE on the re-run
 *       attempt. There is no idempotency layer here; a capability whose side
 *       effect is not safe to repeat needs its own idempotency key upstream
 *       (a kernel/capability concern, not this driver's).
 *     - Separately — and independent of the full-run-retry case above — the
 *       engine's OWN intra-turn step retries (`maxRetries`, left at the
 *       engine default since this driver passes none) can re-run a single
 *       step and therefore re-emit that step's `stream-part`/`coding-event`s
 *       into the append-only event log. Log consumers must tolerate a
 *       re-emitted step's events (the same behavior `chat.stream` explicitly
 *       turns OFF via `maxRetries: 0` for its live SSE client — this driver's
 *       log-based consumers don't share that constraint, so the default is
 *       left on).
 *     - Narrower still: the worker harness (`@oxagen/agent-worker`) only
 *       flushes buffered events on checkpoint or turn settlement (never
 *       inline per-event), so a crash in the window AFTER the final flush but
 *       BEFORE the terminal store call can leave a run reclaimed and re-run
 *       even though its whole event log already landed — the resumed
 *       attempt's seqs then interleave with the prior attempt's under
 *       `appendEvents`' `ON CONFLICT (run_id, seq) DO NOTHING`, producing a
 *       log with events from two attempts. This is harness behavior (Phase
 *       2c, not this driver), and the window is narrow, but a log consumer
 *       should not assume a run's event log came from a single attempt.
 * - **Per-turn dollar budget: workspace/org governance only.** A budget guard
 *   IS wired (`RunCodingAgentOptions.budgetGuard`, built via
 *   `createTurnBudgetGuard` from `@oxagen/billing` — the same module
 *   `chat.stream.ts`/`bridge.ts` use), but only the WORKSPACE/ORG governance
 *   half of budget resolution can apply. `get_budget_policy`
 *   (`workspace.budget_policy.read`) keys on `ctx.workspaceId` ALONE, which
 *   every durable run has, so an org/workspace ceiling or default DOES bind a
 *   durable run's spend. The MEMBER's own saved budget preference
 *   (`budget.policy.read`) is deliberately NOT resolved here — that handler
 *   throws without an authenticated `ctx.userId`
 *   (`packages/handlers/src/budget.policy.read.ts`). The enqueuing principal
 *   IS now captured when the enqueue surface knows it (`delegation.userId`,
 *   Agent RBAC Phase 2b) and rides on `ctx.userId`, but resolving the
 *   member's own per-turn budget default from it remains a follow-up — until
 *   then only an org/workspace ceiling or default governs a durable run,
 *   never a member override. The workspace-governance read fails open (read
 *   error/no governance ⇒ unbounded) exactly like `chat.stream.ts`'s
 *   `readWorkspaceGovernance`, and is made with the driver's OWN context
 *   (no `agentRun`) so an agent role can never unbind workspace budget
 *   governance by denying the read.
 * - **No workspace/sandbox/code-mode.** `RunCodingAgentOptions.workspace` is
 *   omitted — conversational mode only (no filesystem tools, no diff, no
 *   command execution). Follow-up: a code-mode RunSpec variant needs a
 *   sandbox binding (`ModalSandboxWorkspace`, mirroring
 *   `packages/handlers/src/agent.repo.edit.ts`) before durable runs can drive
 *   repo edits.
 *
 * ## Tool-name translation is NOT applied here
 *
 * `materializeTools`' `nameMap` (model-safe-alias → real-capability-name) is
 * intentionally left unused by this driver. `onStreamPart`/`onEvent` both
 * forward engine output VERBATIM (`io.onEvent("stream-part"|"coding-event",
 * <untranslated>)`); translating tool names on the `coding-event` channel but
 * not the raw `stream-part` channel would make the two disagree about the
 * same tool call in the same log. Name translation is a projection concern
 * for whichever future consumer renders the event log for humans (mirroring
 * `apps/api/src/routes/v1/chat-stream-translator.ts`'s
 * `toolNameMap[toolName] ?? toolName`) — not this driver's job.
 */
import type { ModelMessage } from "ai";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen/kernel";
import {
  createAgentRunResolution,
  type AgentRunIAMContext,
} from "@oxagen/oxagen/iam";
import {
  fetchAgentRunAuthz,
  loadAuthorizationSnapshot,
  resolveAgentRunAuthzContext,
} from "@oxagen/iam";
import {
  executeTurn,
  parseRunSpecV1,
  parseRunSpecV2,
  assertRunRowMatchesSpec,
  DEFAULT_AGENT_MODEL,
  DEFAULT_MAX_AGENT_STEPS,
  type ClaimedRunV2Detail,
  type PlatformSurface,
  type RunLeaseRef,
  type RunRowIdentity,
  type RunSpecV1,
  type RunSpecV2,
} from "@oxagen/agent-runner";
import type { ResolvedPrincipal } from "@oxagen/oxagen";
import {
  createTurnBudgetGuard,
  governedBudgetFromRead,
  resolveEffectiveTurnBudget,
  TURN_BUDGET_OFF,
  type SavedWorkspaceGovernance,
  type TurnBudgetPolicy,
} from "@oxagen/billing";
import type { CapabilityContext } from "../types";
import { materializeTools } from "./materialize-tools";
import { createPlatformAgentAi } from "../adapters";

// ---------------------------------------------------------------------------
// Structural worker-harness contract — mirrors @oxagen/agent-worker's
// src/types.ts EXACTLY, field for field. NOT imported: @oxagen/agent-worker's
// own main.ts imports `createPlatformTurnDriver` FROM this package, so an
// import in the other direction would make the two packages a cycle.
// TypeScript's structural typing means the function this module exports
// satisfies the real `TurnDriver` interface without either package needing
// to import the other's types — the same trick packages/agent/src/types.ts
// already plays for `CapabilityContext` against `@oxagen/oxagen`.
// KEEP IN SYNC with packages/agent-worker/src/types.ts.
// ---------------------------------------------------------------------------

/** A run claimed off the durable-run queue, ready to be driven to completion. */
export interface ClaimedRun {
  runId: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  surface: string;
  spec: unknown;
  attempts: number;
  /** Restored engine state from the last committed checkpoint, or null for a fresh run. */
  checkpoint: unknown | null;
  /** Seq of the last event durably appended as of the restored checkpoint. 0 for a fresh run. */
  checkpointSeq: number;
  /**
   * 1 = legacy run-global claim, 2 = fenced immutable attempt.
   *
   * Optional here, required by the store: a fake in an older test — or the V1
   * port in `@oxagen/agent-worker` — hands over a claim without it, and
   * treating that as v1 is both backward compatible and the fail-closed
   * direction (`assertClaimIsLegacyV1` refuses only what it can positively
   * identify as v2, and `hydrateAgentRunContext` refuses anything that is not
   * positively v2).
   */
  specVersion?: 1 | 2;
  /** The fencing token set. Non-null exactly when `specVersion === 2`. */
  lease?: RunLeaseRef | null;
  /** Trusted identity + attempt detail. Non-null exactly when v2. */
  v2?: ClaimedRunV2Detail | null;
}

/** One event in a run's append-only event log, seq assigned by the worker (never the store). */
export interface RunEventRecord {
  seq: number;
  type: string;
  payload: unknown;
}

/**
 * Drives one claimed run to completion in ordinary process memory. See
 * `@oxagen/agent-worker`'s `src/types.ts` for the full contract this shape
 * must satisfy (event buffering/flush timing, checkpoint semantics, signal
 * composition) — this driver never calls `io.checkpoint` (see module doc).
 */
export interface TurnDriver {
  (
    run: ClaimedRun,
    io: {
      onEvent: (type: string, payload: unknown) => void;
      checkpoint: (state: unknown) => Promise<void>;
      signal: AbortSignal;
    },
  ): Promise<{ result: unknown }>;
}

// ---------------------------------------------------------------------------
// RunSpec v1 — the schema and parser now live in @oxagen/agent-runner's
// run-spec-v1-legacy.ts, shared with the enqueuing API route. Re-exported here
// under the original names because this module has been their import site
// since Phase 2 and a rename would churn every caller for no behavioral gain.
// ---------------------------------------------------------------------------

export type { RunSpecV1 };

/**
 * Validate a claimed run's `spec` against RunSpec v1. Throws a plain `Error`
 * with a clear, human-readable message on ANY validation failure — including
 * an unrecognized `version` — because a thrown driver error is exactly what
 * the worker harness turns into `failRun`'s message
 * (`packages/agent-worker/src/terminal.ts`'s `decideTerminalAction`).
 */
export function parseRunSpec(raw: unknown): RunSpecV1 {
  return parseRunSpecV1(raw);
}

// ---------------------------------------------------------------------------
// v2 — trusted claim hydration
// ---------------------------------------------------------------------------

/**
 * Project a claimed v2 run's typed columns into the row-identity shape the
 * trusted comparator expects.
 *
 * This is a pure REMAPPING, not a re-derivation: every value comes off the
 * `agent_runs` row the claim locked, in the store's camelCase projection, and
 * the comparator reads them in the migration's snake_case names. Deriving any
 * of them from the spec instead would make the comparison compare the spec to
 * itself and pass unconditionally — the exact failure mode the check exists to
 * catch.
 */
export function runRowIdentityFromClaim(
  detail: ClaimedRunV2Detail,
): RunRowIdentity {
  return {
    spec_version: 2,
    run_kind: detail.runKind,
    spec_digest: detail.specDigest,
    initiating_principal_id: detail.initiatingPrincipalId,
    agent_principal_id: detail.agentPrincipalId,
    agent_id: detail.agentId,
    agent_version_id: detail.agentVersionId,
    agent_version_checksum: detail.agentVersionChecksum,
    authorization_snapshot_id: detail.authorizationSnapshotId,
    parent_run_id: detail.parentRunId,
    repository_binding_public_id: detail.repositoryBindingPublicId,
    provider: detail.repositoryProvider,
    provider_repository_id: detail.providerRepositoryId,
    connection_id: detail.repositoryConnectionId,
    configured_default_ref: detail.configuredDefaultRef,
    base_commit_sha: detail.baseCommitSha,
    base_tree_sha: detail.baseTreeSha,
    retention_policy_id: detail.retentionPolicyPublicId,
    retention_policy_digest: detail.retentionPolicyDigest,
    max_attempts: detail.maxAttempts,
  };
}

/** What a hydrated v2 claim yields: the validated spec and its IAM binding. */
export interface HydratedAgentRun {
  spec: RunSpecV2;
  agentRun: AgentRunIAMContext;
}

/**
 * Hydrate `CapabilityContext.agentRun` for a claimed v2 run, refusing to
 * proceed unless the row, the stored spec, and the persisted authorization
 * snapshot all agree.
 *
 * Order matters, and each step fails CLOSED:
 *
 *  1. **The claim must be v2.** A v1 or unversioned claim has no principals to
 *     bind; synthesizing them is exactly the "invented authority" the plan
 *     forbids.
 *  2. **Spec digest, then column-by-column identity.** `assertRunRowMatchesSpec`
 *     hashes the spec against the row's stored digest before comparing fields
 *     — a spec that does not hash to its digest is not a trustworthy basis for
 *     any comparison. Either copy could be the tampered one, so a disagreement
 *     trusts neither.
 *  3. **The snapshot is READ BACK, never rebuilt.** `loadAuthorizationSnapshot`
 *     returns the ceiling exactly as admission pinned it. Recomputing it from
 *     current grants would let a role granted after admission widen a run
 *     mid-flight — the precise thing pinning prevents.
 *  4. **The snapshot's digests must match the spec's pinned reference.** A
 *     snapshot row that loads but hashes differently means the run is pointing
 *     at a ceiling that is not the one it was admitted under.
 *
 * Called BEFORE any engine or tool materialization: a run whose identity
 * cannot be proven must not reach a model, let alone a capability.
 */
export async function hydrateAgentRunContext(
  run: ClaimedRun,
): Promise<HydratedAgentRun> {
  const detail = run.specVersion === 2 ? run.v2 : null;
  if (!detail) {
    throw new Error(
      `Run ${run.publicId} is not a trusted v2 claim (spec_version ` +
        `${String(run.specVersion ?? 1)}) — refusing to hydrate an agent-run ` +
        `authorization context it has no principals for`,
    );
  }

  const spec = parseRunSpecV2(run.spec);
  assertRunRowMatchesSpec(runRowIdentityFromClaim(detail), spec);

  const authorization = await loadAuthorizationSnapshot(
    detail.authorizationSnapshotId,
  );
  if (authorization === null) {
    throw new Error(
      `Authorization snapshot ${detail.authorizationSnapshotId} for run ` +
        `${run.publicId} could not be loaded — a governed run may not execute ` +
        `without the ceiling it was admitted under`,
    );
  }

  const pinned = spec.authorization_snapshot_ref;
  if (
    authorization.snapshotDigest !== pinned.snapshot_digest ||
    authorization.grantCeilingDigest !== pinned.grant_ceiling_digest
  ) {
    throw new Error(
      `Authorization snapshot ${authorization.snapshotPublicId} for run ` +
        `${run.publicId} does not match the ceiling pinned at admission ` +
        `(snapshot digest ${authorization.snapshotDigest} vs ` +
        `${pinned.snapshot_digest})`,
    );
  }

  const agentPrincipal: ResolvedPrincipal = {
    id: detail.agentPrincipalId,
    kind: "agent",
    orgId: run.orgId,
    workspaceId: run.workspaceId,
  };
  // v2 admission REQUIRES an initiating principal — `actor_binding` has no
  // nullable form — so unlike the pre-run resolver there is no unprivileged
  // sentinel case to handle here. A run that reached the queue without one
  // would have failed step 2 above.
  const humanPrincipal: ResolvedPrincipal = {
    id: detail.initiatingPrincipalId,
    kind: "human",
    orgId: run.orgId,
    workspaceId: run.workspaceId,
  };

  return {
    spec,
    agentRun: {
      principalKind: "agent",
      agentPrincipal,
      humanPrincipal,
      // The trusted `agent_id` COLUMN, which v2 pins as the internal uuid —
      // not an `agt_` public id. It is an opaque correlation value in the
      // audit trace, and resolving it to a public id here would mean a lookup
      // whose result nothing verified.
      agentId: detail.agentId,
      runId: run.runId,
      parentRunId: detail.parentRunId,
      // The attempt this invocation belongs to. Present because hydration
      // happens after the claim created one; a decision row binds run,
      // attempt, and snapshot together or none of the three.
      attemptId: run.lease?.attemptId ?? null,
      authorization,
    },
  };
}

/**
 * Refuse a v2 claim on the v1 execution path.
 *
 * Defense in depth, not redundancy: the worker's V1 loop and the V2 attempt
 * loop are separate code paths fed by separate claim queries, so a v2 row
 * arriving here means a claim dispatcher regression. Executing it would append
 * unfenced, undigested events into a run whose seal is supposed to cover an
 * immutable attempt — a silently corrupt evidence chain, which is far worse
 * than a failed run.
 */
export function assertClaimIsLegacyV1(run: ClaimedRun): void {
  if (run.specVersion === 2) {
    throw new Error(
      `Run ${run.publicId} is a trusted v2 claim and cannot execute on the ` +
        `legacy v1 driver — v2 attempts execute through the worker's fenced ` +
        `attempt path`,
    );
  }
}

/**
 * Build the `TurnDriver` the worker harness invokes for every claimed run.
 * Stateless factory — no per-run state lives on the returned closure; each
 * call gets its own tenant scope, capability context, and materialized tool
 * set derived from its own `ClaimedRun`.
 */
export function createPlatformTurnDriver(): TurnDriver {
  return async (run, io) => {
    // Before the spec is even parsed: a v2 row must never execute here.
    assertClaimIsLegacyV1(run);
    const spec = parseRunSpec(run.spec);

    // Non-request context (no kernel/CapabilityHandler middleware has opened
    // a scope for us — this is a worker process claiming rows across every
    // org): open the tenant scope explicitly around the whole turn, mirroring
    // agent.repo.edit.ts's onRouteOutcome fire-and-forget re-entry pattern,
    // generalized to the entire turn instead of one callback.
    return runInTenantScope(
      { orgId: run.orgId, workspaceId: run.workspaceId },
      async () => {
        // ── Agent RBAC (Phase 2b, spec §3.4/§3.5) ──────────────────────────
        // A delegated run (spec.delegation.agentId) resolves its two-principal
        // IAM context — the agent's own delegated principal + the invoking
        // human (delegation.userId when the enqueue route captured one,
        // otherwise the creator recorded at provisioning) — and prefetches
        // the ONE per-run authz snapshot onto `agentRun.resolution`. Both IAM
        // seams read this same object: materializeTools' model-facing tool
        // filter (below) and the kernel's checkIAM (which reuses a
        // pre-populated `resolution` instead of fetching its own —
        // packages/iam/src/check-iam.ts resolutionForAgentRun). Runs inside
        // the tenant scope opened above (both resolvers use withTenantDb).
        const delegation = spec.delegation;
        let agentRun: AgentRunIAMContext | undefined;
        if (delegation?.agentId !== undefined) {
          const authzCtx = await resolveAgentRunAuthzContext({
            orgId: run.orgId,
            workspaceId: run.workspaceId,
            agentId: delegation.agentId,
            // The AUTHENTICATED enqueuing human, or null. Null resolves the
            // human side to the unprivileged sentinel — never the agent's
            // creator (see @oxagen/iam's agent-run-context.ts header).
            initiatingUserId: delegation.userId ?? null,
          });
          if (authzCtx === null) {
            // Fail closed, loudly: a run that DECLARED an agent identity but
            // cannot anchor it to a live agent principal must never execute
            // ungoverned. The thrown message becomes failRun's error.
            throw new Error(
              `Agent run delegation failed: agent "${delegation.agentId}" ` +
                `could not be resolved to a live agent principal — failing ` +
                `closed (the run will not execute without its delegation ceiling)`,
            );
          }
          agentRun = {
            principalKind: "agent",
            agentPrincipal: authzCtx.agentPrincipal,
            humanPrincipal: authzCtx.humanPrincipal,
            agentId: delegation.agentId,
            runId: run.runId,
            parentRunId: null,
          };
          // Prefetch the once-per-run snapshot so tool materialization can
          // filter from it BEFORE the first kernel check of the run. A fetch
          // failure here throws → failRun (same fail-closed posture as
          // fetch-agent-authz's missing-migration contract).
          agentRun.resolution = createAgentRunResolution(
            await fetchAgentRunAuthz({
              orgId: run.orgId,
              workspaceId: run.workspaceId,
              agentPrincipalId: authzCtx.agentPrincipal.id,
              humanPrincipalId: authzCtx.humanPrincipal?.id ?? null,
            }),
          );
        }

        // `baseCtx` is the driver's OWN identity for housekeeping reads (no
        // agentRun); `ctx` — handed to tool materialization and every model
        // tool call — carries `agentRun` for delegated runs so kernel IAM
        // enforcement activates. A non-delegated spec builds the exact
        // pre-agent-RBAC context (no extra keys, ctx === baseCtx).
        const baseCtx: CapabilityContext = {
          orgId: run.orgId,
          workspaceId: run.workspaceId,
          // The enqueuing human, when the enqueue surface captured one
          // (delegation.userId) — honest attribution; null preserves the
          // pre-delegation shape byte-for-byte.
          userId: delegation?.userId ?? null,
          apiKeyId: null,
          requestId: run.runId,
          surface: "runner",
          messageId: null,
        };
        const ctx: CapabilityContext =
          agentRun !== undefined ? { ...baseCtx, agentRun } : baseCtx;

        const { tools: extraTools, mutatingToolNames } = await materializeTools(
          ctx,
          {
            allowlist: spec.toolPolicy?.allowlist
              ? new Set(spec.toolPolicy.allowlist)
              : undefined,
            riskCeiling: spec.toolPolicy?.riskCeiling,
          },
        );

        // messageId argument = run id (this driver's execution_step_id /
        // credit-ledger reference_id). surface: "runner" explicitly — the
        // SAME tag as ctx.surface above — so LLM/token-usage telemetry
        // (execution_logs, the credit ledger) and tool-invocation telemetry
        // (tool_invocations, tagged from ctx.surface in materializeTools)
        // agree about which surface drove this turn, instead of the AI
        // port silently defaulting to "agent" while the tool calls it makes
        // are tagged "runner".
        const ai = createPlatformAgentAi(ctx, run.runId, "runner");

        // Per-turn dollar budget (see module doc's follow-up note for exactly
        // what is and is not covered). Only the WORKSPACE/ORG governance half
        // of budget resolution applies to a durable run — `get_budget_policy`
        // keys on ctx.workspaceId alone, which every run has. The MEMBER's own
        // saved default (budget.policy.read) is never resolved: that handler
        // requires an authenticated ctx.userId, which pre-delegation runs
        // never carry (delegated runs now do — resolving the member default
        // remains a follow-up). Fail OPEN on any governance-read error
        // (no_handler, IAM deny, DB error, …) — a broken or unregistered
        // governance capability must never block a turn — same fail-open
        // contract as chat.stream.ts's readWorkspaceGovernance.
        //
        // DELIBERATELY invoked with `baseCtx` (no `agentRun`): this read is
        // the DRIVER's own governance housekeeping, not a model/agent action.
        // Routing it through agent-run IAM would mean an agent role that
        // doesn't grant the governance read silently UNBINDS the workspace
        // budget (deny → catch → fail-open → unbounded spend) — the opposite
        // of what RBAC-restricting an agent should do.
        const workspaceBudgetGovernance = await invoke(
          "get_budget_policy",
          {},
          baseCtx,
          { surface: "agent" },
        )
          .then((raw) =>
            governedBudgetFromRead(raw as SavedWorkspaceGovernance),
          )
          .catch((err) => {
            console.warn(
              "[turn-driver] workspace budget governance read failed — failing open to unbounded:",
              String(err),
            );
            return null;
          });
        const turnBudgetPolicy: TurnBudgetPolicy = resolveEffectiveTurnBudget(
          TURN_BUDGET_OFF, // no member policy possible — see note above
          null, // no org-level governance read here — workspace-scoped only
          workspaceBudgetGovernance,
        );
        // createTurnBudgetGuard returns undefined when the policy is off, so
        // an ungoverned run passes no guard at all (unbounded, identical to
        // before this feature).
        const budgetGuard = createTurnBudgetGuard(
          turnBudgetPolicy,
          spec.model ?? DEFAULT_AGENT_MODEL,
          {
            // No interactive approver on the durable-run worker — deny (stop)
            // rather than hang, mirroring bridge.ts's A2A guard.
            onPause: () => false,
          },
        );

        const result = await executeTurn(run.surface as PlatformSurface, {
          ai,
          instruction: spec.instruction,
          history: spec.history as ModelMessage[] | undefined,
          model: spec.model,
          // Runaway backstop for the agentic tool loop, NOT a functional
          // limit — RunSpec v1 has no per-run step override.
          maxSteps: DEFAULT_MAX_AGENT_STEPS,
          extraTools,
          mutatingToolNames,
          budgetGuard,
          // Lease loss OR a cancel request both abort this same signal — see
          // @oxagen/agent-worker's worker.ts; this driver doesn't need to
          // know which.
          signal: io.signal,
          onStreamPart: (part) => io.onEvent("stream-part", part),
          onEvent: (e) => io.onEvent("coding-event", e),
        });

        const outcome = {
          text: result.text,
          steps: result.steps,
          usage: result.usage,
          stopReason: result.stopReason,
        };
        io.onEvent("run-result", outcome);
        return { result: outcome };
      },
    );
  };
}
