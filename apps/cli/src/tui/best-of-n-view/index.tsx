/**
 * Launch best-of-N with live visibility.
 *
 * TTY → the multi-lane {@link BestOfNApp} (watch the candidates race + selection).
 * Non-TTY / --json → the same {@link BestOfNEvent}s as JSONL on stdout, ending
 * with a machine-readable result envelope. One event source, two renderings.
 */
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import {
  runBestOfN,
  type BestOfNOptions,
  type BestOfNResult,
  type BestOfNEvent,
} from "../../agent/best-of-n.js";
import {
  buildSolveUsageSummary,
  formatSolveRollup,
  type SolveUsageTotals,
} from "../../agent/solve-usage.js";
import { resultEnvelope } from "./envelope.js";
import { BestOfNApp } from "./app.js";

export interface LaunchBestOfNOptions extends Omit<BestOfNOptions, "onEvent"> {
  /** Force the headless JSONL stream regardless of TTY. */
  headless?: boolean;
  /**
   * Snapshot of the aggregated model-call usage for this run — read once the
   * race settles (all candidate turns, pipeline judges, and the selector have
   * completed by then). Feeds the `usage` block on the result envelope and
   * the one-shot-format roll-up line, so solve runs report cost/tokens
   * instead of null. Wire it to a `createSolveUsageAccumulator` fed by
   * `createMeteredAi`'s `onMetrics` (see `commands/solve.ts`).
   */
  usageTotals?: () => SolveUsageTotals;
}

export async function launchBestOfN(
  opts: LaunchBestOfNOptions,
): Promise<BestOfNResult> {
  const headless = opts.headless || !process.stdout.isTTY;
  const startedAt = Date.now();

  if (headless) {
    const emit = (o: unknown): void =>
      void process.stdout.write(JSON.stringify(o) + "\n");
    const result = await runBestOfN({
      ...opts,
      onEvent: (e: BestOfNEvent) => emit(e),
    });
    const usage = opts.usageTotals
      ? buildSolveUsageSummary(
          opts.usageTotals(),
          result,
          Date.now() - startedAt,
        )
      : undefined;
    emit(resultEnvelope(result, usage));
    // Human-readable roll-up in the one-shot `--verbose` format, AFTER the
    // envelope so strict JSONL consumers that stop at the result line are
    // unaffected (the bench adapter skips non-JSON lines either way).
    if (usage) process.stdout.write(formatSolveRollup(usage) + "\n");
    return result;
  }

  // Live multi-lane view. Defer the run one macrotask so the app's useEffect
  // subscribes to the emitter before the first events fire (no lost frames).
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);
  const { waitUntilExit } = render(
    <BestOfNApp
      emitter={emitter}
      total={opts.candidates}
      prompt={opts.prompt}
    />,
  );

  const result = await new Promise<BestOfNResult>((resolve, reject) => {
    setImmediate(() => {
      runBestOfN({
        ...opts,
        onEvent: (e: BestOfNEvent) => emitter.emit("event", e),
      }).then((r) => {
        emitter.emit("done", r);
        resolve(r);
      }, reject);
    });
  });

  await waitUntilExit();

  // Same cost roll-up the headless stream gets, printed once the live view has
  // torn down so it lands cleanly below the final frame.
  if (opts.usageTotals) {
    const usage = buildSolveUsageSummary(
      opts.usageTotals(),
      result,
      Date.now() - startedAt,
    );
    process.stdout.write("\n" + formatSolveRollup(usage) + "\n");
  }
  return result;
}
