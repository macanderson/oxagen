/**
 * createFunction adapter - bridges provider-agnostic DurableFunction
 * definitions to Inngest-native function objects.
 *
 * Returns an array because a single abstract definition may produce multiple
 * Inngest functions (primary + optional on-failure companion).
 */
import { NonRetriableError as InngestNonRetriableError } from "inngest";
import type {
  DurableFunctionConfig,
  DurableFunctionTrigger,
  DurableFunctionHandler,
  DurableFunction,
  StepContext,
  EventPayload,
} from "@oxagen/functions";
import { INNGEST_APP_ID } from "./app-id";
import { inngest } from "./inngest";

/**
 * Wraps an Inngest step object into the abstract StepContext interface.
 */
function adaptStep(inngestStep: {
  run: (name: string, fn: () => unknown) => Promise<unknown>;
  sendEvent: (label: string, event: unknown) => Promise<unknown>;
  waitForEvent: (label: string, opts: unknown) => Promise<unknown>;
  sleep: (label: string, duration: string | Date) => Promise<unknown>;
}): StepContext {
  return {
    run<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      return inngestStep.run(name, fn) as Promise<T>;
    },
    async sendEvent(
      label: string,
      event: EventPayload | EventPayload[],
    ): Promise<void> {
      await inngestStep.sendEvent(label, event);
    },
    waitForEvent<T>(
      label: string,
      opts: { event: string; timeout: string; match?: string },
    ) {
      return inngestStep.waitForEvent(
        label,
        opts,
      ) as Promise<EventPayload<T> | null>;
    },
    async sleep(label: string, duration: string | Date): Promise<void> {
      await inngestStep.sleep(label, duration);
    },
  };
}

/**
 * Wraps a DurableFunctionHandler so that:
 * 1. The Inngest step object is adapted to StepContext.
 * 2. NonRetriableError from @oxagen/functions is translated to
 *    Inngest's native NonRetriableError for runtime instanceof checks.
 */
function wrapHandler(handler: DurableFunctionHandler) {
  return async (ctx: {
    event: { data: unknown; name?: string };
    events?: Array<{ data: unknown; name?: string }>;
    step: Parameters<typeof adaptStep>[0];
    runId?: string;
  }) => {
    const step = adaptStep(ctx.step);
    const toPayload = (
      e: { data: unknown; name?: string } | undefined,
    ): EventPayload => ({
      name: e?.name ?? "",
      data: (e?.data ?? {}) as Record<string, unknown>,
    });
    const event = toPayload(ctx.event);
    // Inngest supplies `ctx.events` (the full batch) for batchEvents functions;
    // for non-batched runs it is absent, so expose a single-element array so
    // batch-aware handlers can always read `ctx.events`.
    const events = (ctx.events ?? [ctx.event]).map(toPayload);
    try {
      return await handler({ event, events, step, runId: ctx.runId });
    } catch (err: unknown) {
      if (
        err !== null &&
        err !== undefined &&
        typeof err === "object" &&
        "isNonRetriable" in err &&
        (err as { isNonRetriable: unknown }).isNonRetriable === true
      ) {
        const original = err as unknown as Error;
        throw new InngestNonRetriableError(original.message, {
          cause: original.cause,
        });
      }
      throw err;
    }
  };
}

/**
 * The largest `batchEvents.maxSize` Inngest's plan accepts. Inngest checks it
 * when the app syncs, and one function over it fails the sync for every
 * function in the app. Production ran without `cost.run-rollup` for that
 * reason: `cost.findings` asked for 100, the sync answered 400, and every
 * `cost/run.sealed` event arrived with no function to run.
 */
export const MAX_BATCH_SIZE = 5;

/**
 * The longest `batchEvents.timeout` Inngest accepts, in seconds. Inngest
 * checks it at sync alongside `maxSize`, and one function over it fails the
 * sync for the whole app the same way. `cost.findings` asked for `5m`, the
 * sync answered 400 with "The batch timeout for function 'cost.findings'
 * cannot be longer than 30 seconds", and `deploy api.oxagen.sh` stayed red on
 * every push to main while the functions went unregistered.
 */
export const MAX_BATCH_TIMEOUT_SECONDS = 30;

/**
 * Seconds in one `<number><unit>` component of an Inngest duration, or `null`
 * for a unit `TimeStr` does not admit.
 *
 * Total over every input, `undefined` included, because a capture group is
 * optional to the type checker however certain the pattern is — which is what
 * keeps this free of a cast that would outlive the reason for it.
 */
function componentSeconds(
  digits: string | undefined,
  unit: string | undefined,
): number | null {
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  switch (unit) {
    case "w":
      return value * 604_800;
    case "d":
      return value * 86_400;
    case "h":
      return value * 3_600;
    case "m":
      return value * 60;
    case "s":
      return value;
    default:
      return null;
  }
}

/**
 * Seconds in an Inngest duration string, composites included (`"30s"`,
 * `"5m"`, `"15m15s"`, `"1d"`).
 *
 * Every unit `TimeStr` admits is parsed, not just the single-component
 * `<number><unit>` shape, because a value this cannot read is forwarded
 * unchecked — so a spelling it does not know is a hole in the guard rather
 * than a gap in its coverage. `15m15s` is the one the SDK's own doc comment
 * advertises, and it is 915 seconds.
 *
 * The SDK is of two minds about which spellings reach this field.
 * `InngestFunction.d.ts` types `batchEvents.timeout` as `TimeStrBatch`
 * (`` `${number}s` ``, seconds only) while the doc comment directly above it
 * says "Expects a time string such as 1s, 60s or 15m15s". This repository's
 * own `DurableFunctionConfig.batchEvents.timeout` is a plain `string`, so
 * neither constrains what a caller can write. Reading the wider vocabulary
 * costs nothing and covers both readings.
 *
 * Returns `null` when the string is not entirely components, so a genuinely
 * unrecognised spelling is still passed through to Inngest rather than
 * rejected here — the sync is the authority on the format, and a guard that
 * refuses what Inngest would have accepted is worse than one that lets
 * Inngest answer. Nothing this returns can be a false rejection: a sum over
 * the limit is a duration Inngest refuses whatever the spelling.
 */
function batchTimeoutSeconds(timeout: string): number | null {
  const text = timeout.trim();
  if (text === "") return null;
  let total = 0;
  let consumed = 0;
  for (const [component, digits, unit] of text.matchAll(/(\d+)([wdhms])/g)) {
    const seconds = componentSeconds(digits, unit);
    if (seconds === null) return null;
    total += seconds;
    consumed += component.length;
  }
  // Every character has to belong to a component; otherwise this is a
  // spelling the parser cannot prove anything about.
  return consumed === text.length ? total : null;
}

/**
 * Translates abstract DurableFunctionConfig into Inngest-native config.
 */
function buildInngestConfig(
  config: DurableFunctionConfig,
  idOverride?: string,
) {
  const inngestConfig: Record<string, unknown> = {
    id: idOverride ?? config.id,
  };
  if (config.retries !== undefined) {
    inngestConfig.retries = config.retries;
  }
  if (config.concurrency) {
    inngestConfig.concurrency = config.concurrency;
  }
  if (config.cancelOn) {
    inngestConfig.cancelOn = config.cancelOn;
  }
  if (config.timeouts) {
    inngestConfig.timeouts = config.timeouts;
  }
  if (config.batchEvents) {
    if (config.batchEvents.maxSize > MAX_BATCH_SIZE) {
      throw new Error(
        `${config.id}: batchEvents.maxSize ${config.batchEvents.maxSize} is over Inngest's limit of ${MAX_BATCH_SIZE}, and the sync would refuse every function in the app`,
      );
    }
    const seconds = batchTimeoutSeconds(config.batchEvents.timeout);
    if (seconds !== null && seconds > MAX_BATCH_TIMEOUT_SECONDS) {
      throw new Error(
        `${config.id}: batchEvents.timeout ${config.batchEvents.timeout} is over Inngest's limit of ${MAX_BATCH_TIMEOUT_SECONDS}s, and the sync would refuse every function in the app`,
      );
    }
    // Inngest-native shape: { maxSize, timeout, key? }.
    inngestConfig.batchEvents = config.batchEvents;
  }
  if (config.debounce) {
    // Inngest-native shape: { period, key?, timeout? }.
    inngestConfig.debounce = config.debounce;
  }
  return inngestConfig;
}

/**
 * Translates abstract DurableFunctionTrigger into Inngest-native trigger.
 *
 * A trigger with neither an event name nor a cron expression is rejected here.
 * Passing `{ cron: undefined }` through to Inngest registers a function nothing
 * can ever fire, and the SDK's own complaint arrives at dev-server sync time
 * with no clue which definition produced it.
 */
function buildInngestTrigger(trigger: DurableFunctionTrigger) {
  if ("event" in trigger && trigger.event) {
    return { event: trigger.event };
  }
  if (!trigger.cron) {
    throw new Error(
      "createFunction: trigger must specify either `event` or `cron`, " +
        `got ${JSON.stringify(trigger)}`,
    );
  }
  return { cron: trigger.cron };
}

/**
 * Creates provider-native Inngest functions from an abstract durable function
 * definition. Returns an array of DurableFunction objects that are also valid
 * Inngest function values (can be passed directly to inngestServe).
 *
 * If config.onFailure is provided, a companion on-failure function is
 * registered alongside the primary function.
 */
export function createFunction(
  config: DurableFunctionConfig,
  trigger: DurableFunctionTrigger,
  handler: DurableFunctionHandler,
): DurableFunction[] {
  const results: DurableFunction[] = [];

  // Primary function
  const inngestConfig = buildInngestConfig(config);
  const inngestTrigger = buildInngestTrigger(trigger);
  const wrappedHandler = wrapHandler(handler);

  const primaryFn = inngest.createFunction(
    inngestConfig as Parameters<typeof inngest.createFunction>[0],
    inngestTrigger as Parameters<typeof inngest.createFunction>[1],
    wrappedHandler as Parameters<typeof inngest.createFunction>[2],
  );

  // Augment the Inngest function with DurableFunction introspection
  // properties. CRITICAL: do NOT assign `id` here — Inngest's InngestFunction
  // exposes `id` as a METHOD (serve()/getConfig() call `this.id(appPrefix)`),
  // and assigning an own `id` string shadows that method, so the moment the
  // dev server syncs (`PUT /api/inngest`) serve throws "this.id is not a
  // function". The abstract id is read from `config.id` instead. `config` and
  // `trigger` are inert to Inngest (getConfig reads `this.opts`, never these).
  const primaryDurable = Object.assign(primaryFn, {
    config,
    trigger,
  }) as unknown as DurableFunction;

  results.push(primaryDurable);

  // On-failure companion function
  if (config.onFailure) {
    const companionId = `${config.id}.on-failure`;
    const failureConfig = buildInngestConfig({ id: companionId });
    const failureTrigger = {
      event: "inngest/function.failed",
      // The failed event names the function by its app-prefixed id. Matching
      // the bare id never fired, so no companion ran before this was fixed.
      if: `event.data.function_id == '${INNGEST_APP_ID}-${config.id}'`,
    };
    const wrappedFailureHandler = wrapHandler(config.onFailure);

    const failureFn = inngest.createFunction(
      failureConfig as Parameters<typeof inngest.createFunction>[0],
      failureTrigger as Parameters<typeof inngest.createFunction>[1],
      wrappedFailureHandler as Parameters<typeof inngest.createFunction>[2],
    );

    const failureTriggerAbstract: DurableFunctionTrigger = {
      event: "inngest/function.failed",
    };

    // Same rule as the primary fn: never assign `id` (it shadows Inngest's
    // id() method and breaks serve). Abstract id is read from config.id.
    const failureDurable = Object.assign(failureFn, {
      config: { id: companionId },
      trigger: failureTriggerAbstract,
    }) as unknown as DurableFunction;

    results.push(failureDurable);
  }

  return results;
}
