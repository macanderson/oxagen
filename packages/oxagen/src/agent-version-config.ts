// The per-agent limits an agent version's `config` carries (ADR-198).
//
// An agent version records its runtime, its toolbelt and a `config` object.
// Two tables in that object reach the host bundle: `budget`
// (`per_run_micros`, `per_day_micros`) and `containment` (`required`,
// ADR-152). Before ADR-198 they were written in the agent's definition file;
// the migration that removed the file copied both tables into `config`, so
// this module reads `config` alone.
//
// A present table that does not hold its shape throws `conflict` with reason
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

/**
 * `containment.required = true`: the agent runs only under the contained
 * launcher (ADR-152). Undefined when the config declares no containment or
 * declares it not required.
 */
export function agentVersionContainment(
  config: unknown,
): { required: true } | undefined {
  const raw = table(config)?.["containment"];
  if (raw === undefined) return undefined;
  const containment = table(raw);
  const required = containment?.["required"];
  if (
    !containment ||
    typeof required !== "boolean" ||
    Object.keys(containment).some((key) => key !== "required")
  )
    invalid("The agent containment takes one key, required, a boolean.");
  return required ? { required: true } : undefined;
}
