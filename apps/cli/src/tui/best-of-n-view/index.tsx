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
import { BestOfNApp } from "./app.js";

export interface LaunchBestOfNOptions extends Omit<BestOfNOptions, "onEvent"> {
  /** Force the headless JSONL stream regardless of TTY. */
  headless?: boolean;
}

function resultEnvelope(result: BestOfNResult): Record<string, unknown> {
  return {
    type: "result",
    winnerId: result.selection.winnerId,
    reasoning: result.selection.reasoning,
    ranking: result.selection.ranking,
    winnerFiles: result.winner?.changedFiles ?? [],
    candidates: result.candidates.map((c) => ({
      id: c.id,
      model: c.model,
      changedFiles: c.changedFiles,
      steps: c.steps,
      failed: c.failed ?? false,
    })),
  };
}

export async function launchBestOfN(opts: LaunchBestOfNOptions): Promise<BestOfNResult> {
  const headless = opts.headless || !process.stdout.isTTY;

  if (headless) {
    const emit = (o: unknown): void => void process.stdout.write(JSON.stringify(o) + "\n");
    const result = await runBestOfN({ ...opts, onEvent: (e: BestOfNEvent) => emit(e) });
    emit(resultEnvelope(result));
    return result;
  }

  // Live multi-lane view. Defer the run one macrotask so the app's useEffect
  // subscribes to the emitter before the first events fire (no lost frames).
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);
  const { waitUntilExit } = render(
    <BestOfNApp emitter={emitter} total={opts.candidates} prompt={opts.prompt} />,
  );

  const result = await new Promise<BestOfNResult>((resolve, reject) => {
    setImmediate(() => {
      runBestOfN({ ...opts, onEvent: (e: BestOfNEvent) => emitter.emit("event", e) }).then(
        (r) => {
          emitter.emit("done", r);
          resolve(r);
        },
        reject,
      );
    });
  });

  await waitUntilExit();
  return result;
}
