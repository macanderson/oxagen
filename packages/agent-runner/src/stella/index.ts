/**
 * The Stella engine path — agent-engine v2 Phase C.
 *
 * `executeTurn` branches here when the engine flag resolves to `"stella"`.
 * Everything below this barrel is the adapter between the host's existing
 * ports and the sidecar's wire contract; nothing above it changes.
 *
 * ## Process-wide wiring
 *
 * The sidecar pool and the completion pricer are process-scoped rather than
 * per-call, because both are: a pool of OS processes is a property of the
 * worker, and pricing is a property of the deployment. They are injected
 * through {@link configureStellaEngine} rather than imported, which keeps
 * `@oxagen/agent-runner` free of a billing dependency (the same split
 * `RunCodingAgentOptions.budgetGuard` already makes) and lets a test drive the
 * whole path against a fake sidecar.
 *
 * Nothing is constructed until the first Stella turn: a deployment running the
 * TS engine — every deployment through Phase C — spawns no sidecar and pays
 * nothing for this module existing.
 */
import { buildCodingCorePrompt } from "@oxagen/agent-engine";
import type {
  RunCodingAgentOptions,
  RunCodingAgentResult,
} from "@oxagen/agent-engine";
import type { CompletionPricer } from "./provider-bridge";
import { runStellaTurn } from "./run-stella-turn";
import { SidecarPool } from "./sidecar-pool";

export {
  DEFAULT_ENGINE,
  ENGINE_ENV_VAR,
  isEngineChoice,
  resolveEngineChoice,
  UnknownEngineError,
  type EngineChoice,
} from "./engine-choice";
export {
  fromModelMessage,
  toCompletionMessages,
  toModelMessages,
  UnsupportedTurnContentError,
  UNKNOWN_TOOL_NAME,
} from "./message-mapping";
export { createEventMapper, type StellaEventMapper } from "./event-mapping";
export {
  BUILTIN_MUTATING_TOOLS,
  executeToolRequest,
  mutatingToolSet,
  toModelToolSet,
  toToolSchemas,
  UnknownToolError,
} from "./tool-mapping";
export {
  createProviderHandler,
  splitSystem,
  toCompletionUsage,
  toStellaFinishReason,
  type CompletionPricer,
  type ProviderBridgeOptions,
} from "./provider-bridge";
export {
  SidecarPool,
  StellaBinaryMissingError,
  type SidecarLease,
  type SidecarPoolOptions,
} from "./sidecar-pool";
export {
  buildBudgetSpec,
  runStellaTurn,
  StellaTurnAbortedError,
  stopReasonFor,
  sumUsage,
  type StellaTurnDeps,
} from "./run-stella-turn";

/**
 * The workspace-less chat default, resolved once.
 *
 * Held as a module constant for the reason `engine.ts` holds its own: the
 * system prompt is a prompt-cache prefix, and re-deriving it per turn risks a
 * byte differing between two turns that should share a cached prefix.
 */
const DEFAULT_SYSTEM = buildCodingCorePrompt();

interface StellaEngineWiring {
  pool?: SidecarPool;
  price?: CompletionPricer;
}

const wiring: StellaEngineWiring = {};

/**
 * Supply the process-wide Stella wiring. Call once at worker boot, before any
 * turn runs.
 *
 * A pool passed here replaces the lazily-created default, so a test can drive
 * the whole path without a real binary. Passing a `price` is what arms the
 * engine's own budget accounting — see `buildBudgetSpec` for why an unpriced
 * turn deliberately runs with the engine budget off.
 */
export function configureStellaEngine(next: StellaEngineWiring): void {
  if (next.pool !== undefined) wiring.pool = next.pool;
  if (next.price !== undefined) wiring.price = next.price;
}

/** The pool in use, created on first demand. Exposed for shutdown and tests. */
export function stellaSidecarPool(): SidecarPool {
  wiring.pool ??= new SidecarPool();
  return wiring.pool;
}

/**
 * Stop every sidecar this process started. Safe to call when none were.
 *
 * A worker's SIGTERM handler should await this: an orphaned `stella-serve`
 * holds a loopback port and a process slot with no one left to drive it.
 */
export async function shutdownStellaEngine(): Promise<void> {
  const pool = wiring.pool;
  wiring.pool = undefined;
  if (pool) await pool.shutdown();
}

/**
 * Run one turn on Stella, acquiring and releasing a sidecar slot around it.
 *
 * The slot is held for the whole turn and released in a `finally`, including
 * when the turn throws — a leaked slot permanently shrinks the worker's
 * concurrency, and the symptom (turns queueing behind nothing) points nowhere
 * near the cause.
 */
export async function runTurnOnStella(
  opts: RunCodingAgentOptions,
): Promise<RunCodingAgentResult> {
  const lease = await stellaSidecarPool().acquire(opts.signal);
  try {
    return await runStellaTurn(
      { ...opts, system: opts.system ?? DEFAULT_SYSTEM },
      { lease, price: wiring.price },
    );
  } finally {
    lease.release();
  }
}
