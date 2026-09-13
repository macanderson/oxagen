// Honesty guards: every field a wired method returns before its store exists
// (plan §3 ❌) accepts null, so a live adapter can say "not recorded" instead of
// inventing a zero, a false or an empty list, and the UI renders it as such.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { seed } from "../adapters/fixture/seed";
import { AgentRow } from "./agents";
import { ApprovalItem } from "./approvals";
import { RunDetail } from "./runs";
import { SpendByOperator, SpendSummary } from "./spend";

const first = <T>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("the seed has rows here");
  return item;
};

type Case = [
  contract: string,
  field: string,
  gap: string,
  schema: z.ZodType,
  row: Record<string, unknown>,
];

const approval = first(seed.approvals);
const run = first(seed.runs);
const agent = first(seed.agents);
const operator = first(seed.spend.byOperator);

const CASES: Case[] = [
  ["ApprovalItem", "policyVersionId", "G2", ApprovalItem, approval],
  ["ApprovalItem", "tainted", "taint", ApprovalItem, approval],
  ["ApprovalItem", "rules", "G2", ApprovalItem, approval],
  ["ApprovalItem", "taintSources", "taint", ApprovalItem, approval],
  ["RunDetail", "provenSpend", "G7", RunDetail, run],
  ["RunDetail", "productiveRatio", "G7", RunDetail, run],
  ["AgentRow", "proven30d", "G7", AgentRow, agent],
  ["AgentRow", "productiveRatio", "G7", AgentRow, agent],
  ["AgentRow", "mandateIds", "G1", AgentRow, agent],
  ["SpendSummary", "proven", "G7", SpendSummary, seed.spend.summary],
  ["SpendSummary", "accepted", "G7", SpendSummary, seed.spend.summary],
  ["SpendSummary", "unproven", "G7", SpendSummary, seed.spend.summary],
  ["SpendSummary", "productiveRatio", "G7", SpendSummary, seed.spend.summary],
  ["SpendByOperator", "proven", "G7", SpendByOperator, operator],
  ["SpendByOperator", "productiveRatio", "G7", SpendByOperator, operator],
];

describe("fields not recorded until their store lands", () => {
  it.each(CASES)(
    "%s.%s parses as null (waits on %s)",
    (_contract, field, _gap, schema, row) => {
      expect(schema.safeParse(row).success).toBe(true);
      expect(field in row).toBe(true);
      const parsed = schema.safeParse({ ...row, [field]: null });
      expect(parsed.success).toBe(true);
      expect((parsed.data as Record<string, unknown>)[field]).toBeNull();
    },
  );

  it.each(CASES)(
    "%s.%s is still required: absent is not the same as not recorded (negative)",
    (_contract, field, _gap, schema, row) => {
      const { [field]: _dropped, ...rest } = row;
      expect(schema.safeParse(rest).success).toBe(false);
    },
  );
});
