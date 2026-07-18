/**
 * Partitioned tool dispatch (agent-engine v2 Phase 0 — Stella driver
 * semantics; see docs/specs/agent-engine-v2/plan.md).
 *
 * The AI SDK executes every tool call in a step the moment its args finish
 * streaming — unawaited and uncapped, mutating or not (ai@7
 * `execute-tools-from-stream.ts`: "we don't await the tool execution here";
 * same behavior in ai@6 `run-tools-transformation.ts`).
 * Two parallel `write_file`/`bash` calls can therefore interleave their side
 * effects in the workspace. This wrapper restores deterministic dispatch
 * without giving up read parallelism, mirroring stella-core's driver
 * (consecutive read-only calls run concurrently under a cap; every mutating
 * call is an exclusive barrier):
 *
 * - Non-mutating tools take a SHARED grant — at most
 *   {@link MAX_CONCURRENT_TOOL_CALLS} run at once.
 * - Mutating tools take an EXCLUSIVE grant — they wait for everything in
 *   flight, run alone, then release.
 * - Grants are strictly FIFO in call-arrival order, so a call issued after a
 *   pending mutation queues behind it: the step's side effects land in the
 *   order the model emitted them.
 *
 * A tool that blocks on a human (an approval-gated capability, `ask_user`)
 * holds its grant while it waits, so later calls in the same step queue behind
 * it. That is the barrier working as intended: effects the model requested
 * AFTER a human-gated call must not land before the human decides.
 */
import type { ToolSet } from "ai";
import { MUTATING_TOOL_NAMES } from "./loop-driver";

/** Max non-mutating tool executions in flight at once (Stella's driver cap). */
export const MAX_CONCURRENT_TOOL_CALLS = 8;

export interface DispatchGuardOptions {
  /**
   * Tool names to serialize behind the exclusive barrier IN ADDITION to the
   * built-in workspace mutators ({@link MUTATING_TOOL_NAMES}: bash,
   * write_file, edit_file). Callers that materialize capability tools pass
   * their mutating capability aliases here (see
   * `MaterializedTools.mutatingToolNames` in @oxagen/agent).
   */
  mutatingToolNames?: Iterable<string>;
  /** Shared-slot cap (default {@link MAX_CONCURRENT_TOOL_CALLS}). */
  maxConcurrent?: number;
}

type Waiter = { exclusive: boolean; grant: () => void };

/**
 * A fair (FIFO) shared/exclusive gate. Not exported — the only consumer is
 * {@link wrapToolsWithDispatchGuard}; tests drive it through the wrapper so
 * they cover the real seam.
 */
class DispatchGate {
  private sharedActive = 0;
  private exclusiveActive = false;
  private readonly queue: Waiter[] = [];

  constructor(private readonly maxShared: number) {}

  acquire(exclusive: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({
        exclusive,
        grant: () => resolve(this.makeRelease(exclusive)),
      });
      this.pump();
    });
  }

  private makeRelease(exclusive: boolean): () => void {
    let released = false; // a double-release must not corrupt the counters
    return () => {
      if (released) return;
      released = true;
      if (exclusive) this.exclusiveActive = false;
      else this.sharedActive--;
      this.pump();
    };
  }

  /**
   * Grant from the queue head only — head-of-line blocking is what makes the
   * gate fair and what turns an exclusive waiter into a barrier for every
   * call that arrived after it.
   */
  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.exclusive) {
        if (this.sharedActive > 0 || this.exclusiveActive) return;
        this.exclusiveActive = true;
      } else {
        if (this.exclusiveActive || this.sharedActive >= this.maxShared) return;
        this.sharedActive++;
      }
      this.queue.shift();
      head.grant();
    }
  }
}

type ToolExecute = (input: unknown, options: unknown) => PromiseLike<unknown>;

/**
 * Wrap `tools` so their `execute` closures dispatch through one shared gate.
 * Wrap AFTER extraTools are merged (mutating MCP/capability tools must fence
 * too) and BEFORE the speculation layer, so cache hits bypass the gate while
 * speculative prefetches — real filesystem reads — count against the shared
 * cap like any other read.
 */
export function wrapToolsWithDispatchGuard(
  tools: ToolSet,
  opts: DispatchGuardOptions = {},
): ToolSet {
  const gate = new DispatchGate(
    opts.maxConcurrent ?? MAX_CONCURRENT_TOOL_CALLS,
  );
  const mutating = new Set<string>(MUTATING_TOOL_NAMES);
  for (const name of opts.mutatingToolNames ?? []) mutating.add(name);

  const out: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const exec = toolDef.execute as ToolExecute | undefined;
    if (!exec) {
      out[name] = toolDef;
      continue;
    }
    const exclusive = mutating.has(name);
    out[name] = {
      ...toolDef,
      execute: async (input: unknown, options: unknown) => {
        const release = await gate.acquire(exclusive);
        try {
          return await exec(input, options);
        } finally {
          // Tools resolve error strings by contract, but MCP extras can
          // throw — a leaked grant would wedge every later call.
          release();
        }
      },
    };
  }
  return out;
}
