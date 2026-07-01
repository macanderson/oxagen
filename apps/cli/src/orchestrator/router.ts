/**
 * The model router (deliverable 2).
 *
 * The rules, in order (see `routing-policy.json -> routingRules`):
 *
 *   1. Trivial work (complexity <= routing.trivialMaxComplexity) stays on the
 *      coordinator — no dispatch, no switch cost.
 *   2. Above trivial, dispatch to a worker. Code work has a Sonnet-5 floor
 *      (routing.defaultCodeWorker); non-code work may use the cheap basic worker.
 *   3. Among capable models, the cheapest wins.
 *   4. Only upgrade to a stronger-than-cheapest model when the quality gain,
 *      weighted by task value, beats the token cost of switching mid-turn.
 *   5. Prompt length feeds that switch cost: a longer prompt is more expensive to
 *      re-send, so a marginal gain stops being worth it.
 *
 * Capability is a curated 0..1 `quality` per model; cost is the rate card's
 * output price (which dominates coding-agent spend). Both are derived from Group
 * 1's registry + rate card so there is no second pricing table.
 */
import { cloudModel, cloudModelIds, roles } from "../runtime/registry.js";
import { getCoordinator } from "../runtime/config.js";
import { rateFor } from "../agent/rate-card.js";
import {
  complexityAtMost,
  getDefaultCodeWorker,
  getDefaultTaskValue,
  getExpectedContextTokens,
  getSwitchCostTokenBudget,
  getTrivialMaxComplexity,
  getValueTokenScale,
} from "./config.js";
import { defaultLogSink, type LogSink } from "./logging.js";
import type { Complexity, Router, RoutingDecision, RoutingTask, WorkerTier } from "./types.js";

/**
 * Curated 0..1 code-quality ranking per worker registry id. Gates which models
 * are *capable* at a given complexity. Kept small and explicit; new cloud models
 * added to `models.json` fall back to {@link DEFAULT_WORKER_QUALITY}.
 */
const WORKER_QUALITY: Record<string, number> = {
  haiku: 0.55,
  "sonnet-5": 0.8,
  opus: 0.93,
  "openai-most-capable-coding-model": 0.95,
};

/** Quality assumed for a worker id with no curated entry (conservative mid-tier). */
const DEFAULT_WORKER_QUALITY = 0.7;

/** Minimum worker quality required at each complexity (above trivial only). */
const REQUIRED_QUALITY: Record<Exclude<Complexity, "trivial" | "low">, number> = {
  medium: 0.5,
  high: 0.75,
  very_high: 0.9,
};

/** Quality of a worker id. */
function qualityOf(id: string): number {
  return WORKER_QUALITY[id] ?? DEFAULT_WORKER_QUALITY;
}

/** Relative cost weight of a worker id — the rate card's output price per 1M. */
function costOf(id: string): number {
  const entry = cloudModel(id);
  return entry ? rateFor(entry.slug).outputPer1M : rateFor(id).outputPer1M;
}

/**
 * The worker candidate set: every cloud model except the judge default (the
 * judge must differ from the worker, so routing never picks it as a worker).
 * Sorted cheapest first. Built from the registry so it stays data-driven.
 */
function workerTiers(): WorkerTier[] {
  const judgeId = roles().judgeModels.default;
  return cloudModelIds()
    .filter((id) => id !== judgeId)
    .map((id) => ({ id, quality: qualityOf(id), cost: costOf(id) }))
    .sort((a, b) => a.cost - b.cost);
}

/** Options for constructing a {@link ModelRouter}. */
export interface RouterOptions {
  /** Log sink for routing decisions. Defaults to the debug JSONL stream. */
  log?: LogSink;
}

/** The default, config-driven {@link Router}. */
export class ModelRouter implements Router {
  private readonly log: LogSink;

  constructor(opts: RouterOptions = {}) {
    this.log = opts.log ?? defaultLogSink;
  }

  route(task: RoutingTask): RoutingDecision {
    const trivialMax = getTrivialMaxComplexity();

    // Rule 1 — trivial work stays on the coordinator.
    if (complexityAtMost(task.complexity, trivialMax)) {
      const decision: RoutingDecision = {
        model: getCoordinator(),
        isCoordinator: true,
        reason: "trivial, no dispatch",
        workerModelRecorded: null,
      };
      this.log({
        kind: "route",
        complexity: task.complexity,
        promptTokens: task.promptTokens,
        selected: decision.model,
        coordinator: true,
        reason: decision.reason,
      });
      return decision;
    }

    const decision = this.selectWorker(task);
    this.log({
      kind: "route",
      complexity: task.complexity,
      promptTokens: task.promptTokens,
      selected: decision.model,
      coordinator: false,
      reason: decision.reason,
    });
    return decision;
  }

  estimateSwitchCost(fromModel: string, toModel: string, promptTokens: number): number {
    // No switch, no cost. Otherwise the whole prompt plus the ambient working
    // context is re-sent to the new model — the token cost the router weighs.
    if (fromModel === toModel) return 0;
    return promptTokens + getExpectedContextTokens();
  }

  /** Pick the cheapest capable worker, upgrading only when it clears switch cost. */
  private selectWorker(task: RoutingTask): RoutingDecision {
    const required = REQUIRED_QUALITY[task.complexity as keyof typeof REQUIRED_QUALITY] ?? 0.5;

    // Code work has a hard floor at the default code worker (Sonnet 5): its
    // capability sets the minimum bar, so haiku never takes code work.
    const codeFloor = task.writesCode ? qualityOf(getDefaultCodeWorker()) : 0;
    const bar = Math.max(required, codeFloor);

    const eligible = workerTiers().filter((t) => t.quality >= bar);
    if (eligible.length === 0) {
      // Nothing meets the bar — fall back to the strongest available worker so a
      // hard task is never dropped, and say so in the reason.
      const strongest = workerTiers().sort((a, b) => b.quality - a.quality)[0];
      const model = strongest?.id ?? getDefaultCodeWorker();
      return {
        model,
        isCoordinator: false,
        reason: `no worker meets required quality ${bar.toFixed(2)}; using strongest available`,
        workerModelRecorded: model,
      };
    }

    // Rule 3 — cheapest capable is the baseline.
    const baseline = eligible[0]!;

    // Rules 4 + 5 — consider upgrading to a stronger eligible model, but only
    // when the value of the extra quality beats the switch cost (which grows with
    // prompt length). Strongest-first so a worthwhile upgrade lands on the best.
    const value = task.taskValue ?? getDefaultTaskValue();
    const scale = getValueTokenScale();
    const budget = getSwitchCostTokenBudget();

    let chosen = baseline;
    let reason = task.writesCode
      ? "cheapest capable code worker"
      : "cheapest capable worker";

    for (const cand of [...eligible].sort((a, b) => b.quality - a.quality)) {
      if (cand.quality <= baseline.quality) break; // no more upgrades to weigh
      const gain = cand.quality - baseline.quality;
      const benefit = gain * value * scale;
      const switchCost = this.estimateSwitchCost(baseline.id, cand.id, task.promptTokens);
      // A switch within budget is cheap and passes on any positive-value gain;
      // an over-budget switch must be justified by benefit clearing the full cost.
      const worthIt = switchCost <= budget ? benefit > 0 : benefit >= switchCost;
      if (worthIt) {
        chosen = cand;
        reason =
          `upgrade to ${cand.id}: quality gain ${gain.toFixed(2)} worth ` +
          `~${Math.round(benefit)} tok vs switch cost ${switchCost} tok`;
        break;
      }
    }

    return {
      model: chosen.id,
      isCoordinator: false,
      reason,
      workerModelRecorded: chosen.id,
    };
  }
}

/** Convenience factory for the default router. */
export function createRouter(opts: RouterOptions = {}): ModelRouter {
  return new ModelRouter(opts);
}
