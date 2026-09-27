// The per-agent budget an agent version's `config` carries (ADR-198).
//
// An agent version records its runtime, its toolbelt and a `config` object.
// One table in that object reaches the host bundle: `budget`
// (`per_run_micros`, `per_day_micros`). Before ADR-198 it was written in the
// agent's definition file; the migration that removed the file copied it into
// `config`, so this module reads `config` alone.
//
// The same migration copied a `containment` table. Nothing reads it now:
// whether an agent must run under the contained launcher is the runtime's
// setting (`agent.runtimes.containment_required`, ADR-204), and the migration
// that added that column carried each table's value onto the runtime.
//
// A present budget that does not hold its shape throws `conflict` with reason
// `invalid_agent_config`, and the host bundle suspends governed actions for
// that agent rather than guess a ceiling.
import { HandlerError } from "./handler-error";

export interface AgentVersionBudget {
  perRunMicros?: number;
  perDayMicros?: number;
}

function table(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalid(message: string): never {
  throw new HandlerError({
    code: "conflict",
    reason: "invalid_agent_config",
    message,
  });
}

/**
 * The `budget` table of a version's config, each ceiling a positive safe
 * integer in micros. Undefined when the config declares none.
 */
export function agentVersionBudget(
  config: unknown,
): AgentVersionBudget | undefined {
  const raw = table(config)?.["budget"];
  if (raw === undefined) return undefined;
  const budget = table(raw);
  if (!budget) invalid("The agent budget must be an object.");
  const out: AgentVersionBudget = {};
  for (const [key, target] of [
    ["per_run_micros", "perRunMicros"],
    ["per_day_micros", "perDayMicros"],
  ] as const) {
    const value = budget[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      invalid(`${key} must be a positive safe integer in micros.`);
    out[target] = value;
  }
  return out;
}
