/**
 * The context of one Cedar request: the agent policy spec's `Call` type,
 * plus `harness_tool` and `skill`.
 *
 * The gateway and the hook fill it from different facts. The gateway knows
 * the run's taint, rate, and prior calls. The hook knows only the call in
 * hand, so it sends those parts empty. Both build it here, so the two never
 * disagree on a part's shape.
 */
import type { Context } from "@cedar-policy/cedar-wasm/nodejs";
import type { CedarToolClass } from "./builtins";

/** A Cedar type an argument can take in `policy/schema.cedarschema`. */
export const CEDAR_ARG_TYPES = [
  "String",
  "Long",
  "Bool",
  "Set<String>",
  "Set<Long>",
] as const;
export type CedarArgType = (typeof CEDAR_ARG_TYPES)[number];

/** An argument value Cedar can hold, after it is checked against its type. */
export type CedarArgValue = string | number | boolean | string[] | number[];

/** The enforcement tier the run is on (ADR-095). */
export type CallTier = "observe" | "harness" | "gateway" | "contained";

/** The budget a request reads when no budget is known: Cedar's largest Long. */
export const UNLIMITED_CENTS = Number.MAX_SAFE_INTEGER;

export interface CallContextInput {
  tool: { name: string } & CedarToolClass;
  args?: Record<string, CedarArgValue>;
  taint?: { tainted: boolean; sources: string[] };
  /** The clock, as epoch ms. The context reads its UTC hour and weekday. */
  now: number;
  rate?: { calls_last_hour: number; calls_last_minute: number };
  run?: { prior_calls: string[]; prior_reads: string[] };
  operator_role?: string;
  tier: CallTier;
  budget_remaining_cents?: number;
  mandate_remaining_cents?: number;
  approval?: { granted: boolean; approvers: number };
  harness_tool?: string;
  skill?: string;
}

/** The request context, in Cedar's JSON form. */
export type CallContext = Context;

/** The UTC hour and whether the day is Monday to Friday. */
export function clockContext(now: number): { hour_utc: number; weekday: boolean } {
  const date = new Date(now);
  const day = date.getUTCDay();
  return { hour_utc: date.getUTCHours(), weekday: day >= 1 && day <= 5 };
}

export function callContext(input: CallContextInput): CallContext {
  return {
    tool: {
      name: input.tool.name,
      version: input.tool.version,
      risk: input.tool.risk,
      side_effect: input.tool.side_effect,
      egress: input.tool.egress,
      impacts: [...input.tool.impacts],
    },
    args: input.args ?? {},
    taint: input.taint ?? { tainted: false, sources: [] },
    time: clockContext(input.now),
    rate: input.rate ?? { calls_last_hour: 0, calls_last_minute: 0 },
    run: input.run ?? { prior_calls: [], prior_reads: [] },
    operator: { role: input.operator_role ?? "developer" },
    tier: input.tier,
    budget: { remaining_cents: input.budget_remaining_cents ?? UNLIMITED_CENTS },
    ...(input.mandate_remaining_cents !== undefined
      ? { mandate: { remaining_cents: input.mandate_remaining_cents } }
      : {}),
    approval: input.approval ?? { granted: false, approvers: 0 },
    ...(input.harness_tool !== undefined ? { harness_tool: input.harness_tool } : {}),
    ...(input.skill !== undefined ? { skill: input.skill } : {}),
  };
}

function isLong(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function argValue(value: unknown, type: CedarArgType): CedarArgValue | undefined {
  switch (type) {
    case "String":
      return typeof value === "string" ? value : undefined;
    case "Long":
      return isLong(value) ? value : undefined;
    case "Bool":
      return typeof value === "boolean" ? value : undefined;
    case "Set<String>":
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? (value as string[])
        : undefined;
    case "Set<Long>":
      return Array.isArray(value) && value.every(isLong) ? (value as number[]) : undefined;
  }
}

/**
 * The call's arguments as Cedar reads them: each one the schema types, and
 * nothing else. An argument the schema does not name is dropped, since no
 * rule can read it. An argument of the wrong type is an error, and the
 * caller denies the call: a rule such as `amount > 10000` must never pass
 * because the agent sent the amount as a string.
 */
export function typedArgs(
  raw: Readonly<Record<string, unknown>> | undefined,
  types: Readonly<Record<string, CedarArgType>>,
): { args: Record<string, CedarArgValue>; errors: string[] } {
  const args: Record<string, CedarArgValue> = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!Object.hasOwn(types, name) || value === undefined || value === null) continue;
    const type = types[name] as CedarArgType;
    const typed = argValue(value, type);
    if (typed === undefined) {
      errors.push(`Argument ${name} is not a ${type}.`);
    } else {
      args[name] = typed;
    }
  }
  return { args, errors };
}
