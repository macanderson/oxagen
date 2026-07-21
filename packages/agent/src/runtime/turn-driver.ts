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
 * The sibling API agent enqueues exactly this JSON into `agent.agent_runs.spec`
 * (`packages/agent-runner/src/run-store.ts`'s `EnqueueRunInput.spec`):
 *
 * ```json
 * {
 *   "version": 1,
 *   "instruction": "<string>",
 *   "model": "<optional string>",
 *   "history": ["...optional ModelMessage[]..."],
 *   "toolPolicy": { "allowlist": ["cap", ...], "riskCeiling": "low|medium|high" }
 * }
 * ```
 *
 * `history` messages are validated only for a recognizable `role` — `content`
 * is treated as opaque. The `ai` SDK's `ModelMessage.content` is itself a
 * union of string | content-part arrays whose exact shape this driver has no
 * reason to duplicate; the engine is the thing that actually interprets it.
 * `toolPolicy` — and every field inside it — is optional: an absent
 * `allowlist` materializes every "agent"-surfaced capability the caller is
 * entitled to (`materializeTools`' own default), and an absent `riskCeiling`
 * applies no risk filter.
 *
 * `run.orgId`/`run.workspaceId`/`run.surface` ride on the `ClaimedRun` row,
 * not inside `spec` — v1 runs are always enqueued with `surface: "api-chat"`
 * (conversational chat turns dispatched to the durable worker instead of run
 * in-request).
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
 *   (`packages/handlers/src/budget.policy.read.ts`), and RunSpec v1 never
 *   captures the principal that enqueued the run (`run.orgId`/`run.workspaceId`
 *   ride on the `ClaimedRun` row; there is no `userId`). Follow-up: RunSpec v2
 *   must capture the enqueuing principal before a durable run can honor a
 *   member's own per-turn budget default — until then only an org/workspace
 *   ceiling or default governs a durable run, never a member override. The
 *   workspace-governance read fails open (read error/no governance ⇒
 *   unbounded) exactly like `chat.stream.ts`'s `readWorkspaceGovernance`.
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
import { z } from "zod";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen/kernel";
import {
  executeTurn,
  DEFAULT_AGENT_MODEL,
  DEFAULT_MAX_AGENT_STEPS,
  type PlatformSurface,
} from "@oxagen/agent-runner";
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
import {
  createPlatformAgentAi,
  createPlatformMemoryProvider,
} from "../adapters";

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
   * The run's persistent AGENT principal (iam.principals kind='agent',
   * agents.principalId) — present when this run was dispatched as a deployed
   * agent run rather than a bare conversational turn. When set together with
   * `humanPrincipal`, the driver threads `principalKind: "agent"` plus both
   * principals into the `CapabilityContext` it builds for this turn
   * (docs/specs/agent-rbac/spec.md §3.1/§3.4) — never minted here, always
   * supplied by whoever enqueued the run.
   */
  agentPrincipal?: {
    id: string;
    kind: "human" | "agent" | "service";
    orgId: string;
    workspaceId: string | null;
  } | null;
  /**
   * The invoking HUMAN principal this agent run acts on behalf of — the
   * delegation ceiling for effective-permission resolution. Present
   * whenever `agentPrincipal` is.
   */
  humanPrincipal?: {
    id: string;
    kind: "human" | "agent" | "service";
    orgId: string;
    workspaceId: string | null;
  } | null;
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
// RunSpec v1 — validated with a local zod schema. Non-strict: unknown keys
// are stripped, not rejected, so an additive future field on the enqueuing
// side doesn't fail an otherwise-valid v1 spec. The `version` literal is the
// real compatibility gate — checked explicitly in `parseRunSpec`, with its
// own error message, before the full schema even runs — this driver
// understands EXACTLY v1 and fails closed on anything else.
// ---------------------------------------------------------------------------

const toolPolicySchema = z.object({
  allowlist: z.array(z.string().min(1)).optional(),
  riskCeiling: z.enum(["low", "medium", "high"]).optional(),
});

// `content` is opaque on purpose — see the module doc's tool-name-translation
// note and the RunSpec v1 section above. `.passthrough()` keeps whatever
// shape the `ai` SDK's ModelMessage variant actually has instead of
// stripping fields this driver doesn't model.
const historyMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.unknown(),
  })
  .passthrough();

const runSpecV1Schema = z.object({
  version: z.literal(1),
  instruction: z.string().min(1, "instruction must not be empty"),
  model: z.string().min(1).optional(),
  history: z.array(historyMessageSchema).optional(),
  toolPolicy: toolPolicySchema.optional(),
});

export type RunSpecV1 = z.infer<typeof runSpecV1Schema>;

/**
 * Validate a claimed run's `spec` against RunSpec v1. Throws a plain `Error`
 * with a clear, human-readable message on ANY validation failure — including
 * an unrecognized `version` — because a thrown driver error is exactly what
 * the worker harness turns into `failRun`'s message
 * (`packages/agent-worker/src/terminal.ts`'s `decideTerminalAction`).
 */
export function parseRunSpec(raw: unknown): RunSpecV1 {
  if (raw === null || typeof raw !== "object") {
    throw new Error(
      `RunSpec validation failed: expected an object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== 1) {
    throw new Error(
      `RunSpec validation failed: unsupported version ${JSON.stringify(version)} — this driver only understands RunSpec v1`,
    );
  }
  const parsed = runSpecV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`RunSpec validation failed: ${issues}`);
  }
  return parsed.data;
}

/**
 * Build the `TurnDriver` the worker harness invokes for every claimed run.
 * Stateless factory — no per-run state lives on the returned closure; each
 * call gets its own tenant scope, capability context, and materialized tool
 * set derived from its own `ClaimedRun`.
 */
export function createPlatformTurnDriver(): TurnDriver {
  return async (run, io) => {
    const spec = parseRunSpec(run.spec);

    // Non-request context (no kernel/CapabilityHandler middleware has opened
    // a scope for us — this is a worker process claiming rows across every
    // org): open the tenant scope explicitly around the whole turn, mirroring
    // agent.repo.edit.ts's onRouteOutcome fire-and-forget re-entry pattern,
    // generalized to the entire turn instead of one callback.
    return runInTenantScope(
      { orgId: run.orgId, workspaceId: run.workspaceId },
      async () => {
        const ctx: CapabilityContext = {
          orgId: run.orgId,
          workspaceId: run.workspaceId,
          userId: null,
          apiKeyId: null,
          requestId: run.runId,
          surface: "runner",
          messageId: null,
          // Thread the agent-run principal pair when this run was dispatched
          // as a deployed agent run (docs/specs/agent-rbac/spec.md §3.1/§3.4)
          // — both principals are always already-resolved by whoever
          // enqueued the run; this driver never mints one. A bare
          // conversational turn (no agentPrincipal/humanPrincipal on the
          // claimed row) leaves principalKind unset, unchanged from before.
          ...(run.agentPrincipal && run.humanPrincipal
            ? {
                principalKind: "agent" as const,
                agentPrincipal: run.agentPrincipal,
                humanPrincipal: run.humanPrincipal,
              }
            : {}),
        };

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

        // Recall (Engram episodic memory), mirroring agent.repo.edit.ts's
        // createPlatformMemoryProvider call exactly: recallQuery = the turn's
        // instruction, telemetry keyed on this driver's own ctx/messageId
        // shape. The adapter is already fully self-swallowing (recallContext's
        // try/catch degrades to "" and emits its own loud
        // agent.memory.recall_failed telemetry on ANY failure — see
        // packages/agent/src/adapters/memory-provider.ts) — this driver adds
        // no second catch on top of that degradable-by-design contract.
        const memory = createPlatformMemoryProvider({
          recallQuery: spec.instruction,
          telemetry: {
            orgId: run.orgId,
            workspaceId: run.workspaceId,
            surface: "runner",
            messageId: run.runId,
          },
        });

        // Per-turn dollar budget (see module doc's follow-up note for exactly
        // what is and is not covered). Only the WORKSPACE/ORG governance half
        // of budget resolution applies to a durable run — `get_budget_policy`
        // keys on ctx.workspaceId alone, which every run has. The MEMBER's own
        // saved default (budget.policy.read) is never resolved: that handler
        // requires an authenticated ctx.userId, which this driver's ctx never
        // has (RunSpec v1 captures no enqueuing principal). Fail OPEN on any
        // governance-read error (no_handler, IAM deny, DB error, …) — a broken
        // or unregistered governance capability must never block a turn — same
        // fail-open contract as chat.stream.ts's readWorkspaceGovernance.
        const workspaceBudgetGovernance = await invoke(
          "get_budget_policy",
          {},
          ctx,
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
          memory,
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
