import {
  hashCanonicalJson,
  promptPatchSchema,
  type LifecycleEvent,
  type LifecycleEventEnvelope,
  type LifecycleInvocationReceipt,
} from "@oxagen/agent-artifacts";
import {
  invoke as kernelInvoke,
  type InvokeOptions,
} from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { CompiledLifecyclePlan } from "./compile";
import { mapLifecycleInput } from "./input-map";
import { applyPromptPatch, type LifecyclePrompt } from "./prompt-patch";

type InvokeFn = (
  name: string,
  input: unknown,
  context: CapabilityContext,
  options: InvokeOptions,
) => Promise<unknown>;

export class LifecycleDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LifecycleDispatchError";
  }
}

function shouldRun(
  when: "success" | "failure" | "always" | undefined,
  status: LifecycleEventEnvelope["turn"]["status"],
): boolean {
  if (!when || when === "always") return true;
  if (when === "success") return status === "succeeded";
  return status === "failed" || status === "rejected" || status === "cancelled";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // An ALREADY-aborted signal never dispatches another "abort" event, so the
    // listener below would never fire and the call would run out its full
    // timeout. Reject up front instead.
    if (signal?.aborted) {
      reject(
        new LifecycleDispatchError("lifecycle_cancelled", "turn was cancelled"),
      );
      return;
    }
    const timer = setTimeout(
      () =>
        reject(
          new LifecycleDispatchError(
            "lifecycle_timeout",
            `timed out after ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    const onAbort = () =>
      reject(
        new LifecycleDispatchError("lifecycle_cancelled", "turn was cancelled"),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

export async function dispatchLifecycleEvent(options: {
  plan: CompiledLifecyclePlan;
  event: LifecycleEvent;
  envelope: LifecycleEventEnvelope;
  context: CapabilityContext;
  prompt?: LifecyclePrompt;
  signal?: AbortSignal;
  invoke?: InvokeFn;
}): Promise<{
  prompt?: LifecyclePrompt;
  receipts: LifecycleInvocationReceipt[];
}> {
  if (options.envelope.event !== options.event) {
    throw new LifecycleDispatchError(
      "lifecycle_event_mismatch",
      "envelope event does not match dispatch event",
    );
  }
  let prompt = options.prompt;
  const receipts: LifecycleInvocationReceipt[] = [];
  const invocations = options.plan.byEvent.get(options.event) ?? [];
  const invoke = options.invoke ?? kernelInvoke;

  for (const invocation of invocations) {
    if (!shouldRun(invocation.when, options.envelope.turn.status)) continue;
    const input = mapLifecycleInput(invocation, options.envelope);
    const inputHash = hashCanonicalJson(input);
    const idempotencyKey = hashCanonicalJson({
      turnId: options.envelope.turn.id,
      invocationId: invocation.id,
      event: invocation.event,
    });
    const started = new Date();
    const beforeHash = prompt ? hashCanonicalJson(prompt) : undefined;
    let attempts = 0;
    let output: unknown;
    let error: unknown;
    const maxAttempts =
      invocation.on_error === "retry" ? (invocation.max_attempts ?? 1) : 1;
    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        output = await withTimeout(
          invoke(invocation.capability, input, options.context, {
            execution: {
              kind: "lifecycle",
              event: invocation.event,
              invocationId: invocation.id,
              idempotencyKey,
              depth: 0,
            },
          }),
          invocation.timeout_ms,
          options.signal,
        );
        error = undefined;
        break;
      } catch (caught) {
        error = caught;
        // A cancelled turn must not keep retrying: every further attempt would
        // burn another full timeout_ms before failing the same way.
        if (options.signal?.aborted) break;
      }
    }

    if (error === undefined && invocation.apply_as === "prompt_patch") {
      if (!prompt)
        throw new LifecycleDispatchError(
          "prompt_patch_without_prompt",
          invocation.id,
        );
      promptPatchSchema.parse(output);
      prompt = applyPromptPatch(prompt, output);
    }
    const finished = new Date();
    const continued =
      error !== undefined &&
      !invocation.required &&
      invocation.on_error !== "block";
    receipts.push({
      schemaVersion: 1,
      turnId: options.envelope.turn.id,
      invocationId: invocation.id,
      event: invocation.event,
      capability: invocation.capability,
      idempotencyKey,
      attempts,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      outcome:
        error === undefined ? "succeeded" : continued ? "continued" : "blocked",
      inputHash,
      ...(output !== undefined
        ? { outputHash: hashCanonicalJson(output) }
        : {}),
      ...(beforeHash ? { promptBeforeHash: beforeHash } : {}),
      ...(invocation.apply_as === "prompt_patch" && output !== undefined
        ? { patchHash: hashCanonicalJson(output) }
        : {}),
      ...(prompt ? { promptAfterHash: hashCanonicalJson(prompt) } : {}),
      ...(error instanceof Error
        ? { errorCode: "code" in error ? String(error.code) : error.name }
        : {}),
    });
    if (error !== undefined && !continued) {
      throw new LifecycleDispatchError(
        "lifecycle_invocation_blocked",
        `${invocation.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ...(prompt ? { prompt } : {}), receipts };
}
