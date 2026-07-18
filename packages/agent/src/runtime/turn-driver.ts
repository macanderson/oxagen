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
 * - **No memory/recall provider.** `RunCodingAgentOptions.memory` is omitted.
 *   Follow-up: wire a recall provider (Engram's context compiler — the
 *   `ContextRecallPort` spec.md maps in Phase 3) once a durable-run surface
 *   needs turn memory.
 * - **No budget guard.** `RunCodingAgentOptions.budgetGuard` is omitted —
 *   unbounded turn cost. Follow-up: needs billing wiring (resolve a
 *   `TurnBudgetPolicy` via `@oxagen/billing` + `budget.policy.read`, the same
 *   shape `chat.stream.ts` already resolves) plumbed through the RunSpec or
 *   workspace governance.
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
import {
  executeTurn,
  DEFAULT_MAX_AGENT_STEPS,
  type PlatformSurface,
} from "@oxagen/agent-runner";
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
        // credit-ledger reference_id); surface defaults to "agent" (same
        // default agent.repo.edit's sync capability uses — a backend-driven,
        // non-interactive turn, not the app/api chat surfaces).
        const ai = createPlatformAgentAi(ctx, run.runId);

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
