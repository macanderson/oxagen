import { parse } from "smol-toml";
import { HandlerError } from "./handler-error";

export interface DefinitionBudget {
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

/** Validate every declared ceiling before a writer or a bundle uses it. */
export function definitionBudget(doc: unknown): DefinitionBudget | undefined {
  const raw = table(doc)?.["budget"];
  if (raw === undefined) return undefined;
  const budget = table(raw);
  if (!budget)
    throw new HandlerError({
      code: "conflict",
      reason: "invalid_definition_budget",
      message: "The definition budget must be a TOML table.",
    });
  const out: DefinitionBudget = {};
  for (const [key, target] of [
    ["per_run_micros", "perRunMicros"],
    ["per_day_micros", "perDayMicros"],
  ] as const) {
    const value = budget[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      throw new HandlerError({
        code: "conflict",
        reason: "invalid_definition_budget",
        message: `${key} must be a positive safe integer in micros.`,
      });
    out[target] = value;
  }
  return out;
}

/**
 * `[containment] required = true`: the agent runs only under the contained
 * launcher (ADR-152). The host's hook refuses a session the launcher did not
 * start. `required = false` and an absent table both state no requirement.
 */
export function definitionContainment(
  doc: unknown,
): { required: true } | undefined {
  const raw = table(doc)?.["containment"];
  if (raw === undefined) return undefined;
  const containment = table(raw);
  const required = containment?.["required"];
  if (
    !containment ||
    typeof required !== "boolean" ||
    Object.keys(containment).some((key) => key !== "required")
  )
    throw new HandlerError({
      code: "conflict",
      reason: "invalid_definition_source",
      message:
        "The definition containment table takes one key, required, a boolean.",
    });
  return required ? { required: true } : undefined;
}

/** Parse the complete source, including tables after the identity header. */
export function parseAgentDefinitionSource(
  source: string,
): Record<string, unknown> {
  let doc: Record<string, unknown>;
  try {
    doc = parse(source);
  } catch {
    throw new HandlerError({
      code: "conflict",
      reason: "invalid_definition_source",
      message:
        "The agent definition is invalid TOML. Correct it before publishing.",
    });
  }
  definitionBudget(doc);
  definitionContainment(doc);
  if (
    doc["tools"] !== undefined &&
    (!Array.isArray(doc["tools"]) ||
      !doc["tools"].every((tool: unknown) => typeof tool === "string"))
  )
    throw new HandlerError({
      code: "conflict",
      reason: "invalid_definition_source",
      message: "The definition tools must be a list of strings.",
    });
  return doc;
}
