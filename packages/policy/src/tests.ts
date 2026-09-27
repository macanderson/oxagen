/**
 * Runs a steering repo's policy tests, `policy/*.tests.jsonl` (lane S12).
 *
 * Each line names an agent, a tool version, the facts of one call, and the
 * decision the author expects. The runner decides the call from the
 * compiled set exactly as the gateway would, and a test passes when the
 * decision matches and nothing errored. A publish whose tests fail stops.
 *
 * ```jsonl
 * {"name":"refund over limit","principal":"a-intel.core.release-bot","tool":"billing__create_refund@3","context":{"args":{"amount":64000}},"expect":"require_approval"}
 * ```
 *
 * `context.time` sets the clock: a weekday is Tuesday 2026-09-22, and any
 * other day is Saturday 2026-09-26, at the given UTC hour. Without it the
 * clock is `now`.
 */
import { z } from "zod";
import type { CedarDecision, CedarRuntime } from "@oxagen/tacho/policy";
import type { CompiledPolicySet } from "./compile";
import { decideToolCall, type ToolCallInput } from "./evaluate";

const TOOL = /^(?<action>[^@\s]+)(?:@(?<version>\d+))?$/;

const contextSchema = z
  .object({
    args: z.record(z.unknown()).optional(),
    taint: z.object({ tainted: z.boolean(), sources: z.array(z.string()) }).strict().optional(),
    time: z
      .object({ hour_utc: z.number().int().min(0).max(23), weekday: z.boolean() })
      .strict()
      .optional(),
    rate: z
      .object({ calls_last_hour: z.number().int().nonnegative(), calls_last_minute: z.number().int().nonnegative() })
      .strict()
      .optional(),
    run: z
      .object({ prior_calls: z.array(z.string()), prior_reads: z.array(z.string()) })
      .strict()
      .optional(),
    operator: z.object({ role: z.string().min(1) }).strict().optional(),
    tier: z.enum(["observe", "harness", "gateway", "contained"]).optional(),
    budget: z.object({ remaining_cents: z.number().int() }).strict().optional(),
    mandate: z.object({ remaining_cents: z.number().int() }).strict().optional(),
    approval: z.object({ granted: z.boolean(), approvers: z.number().int().nonnegative() }).strict().optional(),
    harness_tool: z.string().min(1).optional(),
    skill: z.string().min(1).optional(),
  })
  .strict();

const lineSchema = z
  .object({
    name: z.string().min(1),
    principal: z.string().min(1),
    tool: z.string().regex(TOOL, 'The tool is "<server>__<tool>" with an optional "@<version>".'),
    context: contextSchema.optional(),
    expect: z.enum(["allow", "deny", "require_approval"]),
  })
  .strict();

export interface PolicyTestResult {
  name: string;
  /** The line in the file, from 1. */
  line: number;
  expect: CedarDecision;
  actual: CedarDecision;
  /** The rules that decided. */
  reasons: string[];
  passed: boolean;
  errors: string[];
}

export interface PolicyTestRun {
  results: PolicyTestResult[];
  /** Lines that could not run. */
  errors: { line: number; message: string }[];
  /** Every line ran and every test passed. */
  passed: boolean;
}

export interface PolicyTestOptions {
  runtime: CedarRuntime;
  policy: CompiledPolicySet;
  /** The clock for a test that sets no `context.time`, as epoch ms. */
  now: number;
}

const TUESDAY = Date.UTC(2026, 8, 22);
const SATURDAY = Date.UTC(2026, 8, 26);

function clock(time: { hour_utc: number; weekday: boolean } | undefined, now: number): number {
  if (time === undefined) return now;
  return (time.weekday ? TUESDAY : SATURDAY) + time.hour_utc * 3_600_000;
}

function parseLine(text: string): { value?: z.output<typeof lineSchema>; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: `The line is not JSON: ${(e as Error).message}` };
  }
  const parsed = lineSchema.safeParse(json);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join(" "),
    };
  }
  return { value: parsed.data };
}

/** Runs every test in one `*.tests.jsonl` file against the compiled set. */
export function runPolicyTests(jsonl: string, options: PolicyTestOptions): PolicyTestRun {
  const results: PolicyTestResult[] = [];
  const errors: { line: number; message: string }[] = [];
  jsonl.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim().length === 0) return;
    const { value, error } = parseLine(raw);
    if (value === undefined) {
      errors.push({ line, message: error ?? "The line could not be read." });
      return;
    }
    const match = TOOL.exec(value.tool);
    const action = match?.groups?.["action"] ?? value.tool;
    const version = match?.groups?.["version"];
    if (!options.policy.principals.some((p) => p.name === value.principal)) {
      errors.push({ line, message: `The workspace declares no agent named ${value.principal}.` });
      return;
    }
    if (!Object.hasOwn(options.policy.tools, action) && !action.startsWith("builtin__")) {
      errors.push({ line, message: `The workspace imported no tool named ${action}.` });
      return;
    }
    const c = value.context ?? {};
    const call: ToolCallInput = {
      runtime: options.runtime,
      policy: options.policy,
      agent: value.principal,
      action,
      now: clock(c.time, options.now),
      ...(version !== undefined ? { version: Number(version) } : {}),
      ...(c.args !== undefined ? { args: c.args } : {}),
      ...(c.taint !== undefined ? { taint: c.taint } : {}),
      ...(c.rate !== undefined ? { rate: c.rate } : {}),
      ...(c.run !== undefined ? { run: c.run } : {}),
      ...(c.operator !== undefined ? { operator_role: c.operator.role } : {}),
      ...(c.tier !== undefined ? { tier: c.tier } : {}),
      ...(c.budget !== undefined ? { budget_remaining_cents: c.budget.remaining_cents } : {}),
      ...(c.mandate !== undefined ? { mandate_remaining_cents: c.mandate.remaining_cents } : {}),
      ...(c.approval !== undefined ? { approval: c.approval } : {}),
      ...(c.harness_tool !== undefined ? { harness_tool: c.harness_tool } : {}),
      ...(c.skill !== undefined ? { skill: c.skill } : {}),
    };
    const verdict = decideToolCall(call);
    results.push({
      name: value.name,
      line,
      expect: value.expect,
      actual: verdict.decision,
      reasons: verdict.reasons,
      passed: verdict.decision === value.expect && verdict.errors.length === 0,
      errors: verdict.errors,
    });
  });
  return { results, errors, passed: errors.length === 0 && results.every((r) => r.passed) };
}
