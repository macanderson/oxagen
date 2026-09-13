// Honesty guards: every field a wired method returns before its store exists
// (plan §3 ❌) accepts null, so a live adapter can say "not recorded" instead of
// inventing a zero, a false or an empty list, and the UI renders it as such.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { seed } from "../adapters/fixture/seed";
import { AgentDefinition, AgentDetail, AgentRow } from "./agents";
import { ApprovalItem } from "./approvals";
import { OntologyClass } from "./ontology";
import { RunDetail } from "./runs";
import {
  SpendByAgent,
  SpendByOperator,
  SpendDrill,
  SpendSummary,
} from "./spend";
import { SteeringRecord } from "./steering";
import { Connection } from "./tools";

const first = <T>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("the seed has rows here");
  return item;
};

type Row = Record<string, unknown>;
type Case = [
  contract: string,
  /** A dotted path into the row: `identity.replayGrade`. */
  field: string,
  gap: string,
  schema: z.ZodType,
  row: Row,
];

/** A copy of `row` with the value at `path` replaced, or removed when `value` is omitted. */
function withField(row: Row, path: string, ...value: [unknown?]): Row {
  const [head, ...rest] = path.split(".");
  if (head === undefined) throw new Error("empty field path");
  if (rest.length === 0) {
    const { [head]: _dropped, ...others } = row;
    return value.length ? { ...others, [head]: value[0] } : others;
  }
  return {
    ...row,
    [head]: withField(row[head] as Row, rest.join("."), ...value),
  };
}

function fieldAt(row: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((at, key) => (at as Row | undefined)?.[key], row);
}

function hasField(row: Row, path: string): boolean {
  const keys = path.split(".");
  const last = keys.pop() as string;
  const parent = keys.length ? fieldAt(row, keys.join(".")) : row;
  return typeof parent === "object" && parent !== null && last in parent;
}

const approval = first(seed.approvals);
const run = first(seed.runs);
const agent = first(seed.agents);
const operator = first(seed.spend.byOperator);
const byAgent = first(seed.spend.byAgent);
const drill = first(seed.spend.drills);
const definition = first(seed.definitions);
const connection = first(seed.connections);
const ontologyClass = first(seed.classes);
const record = first(seed.records);

const CASES: Case[] = [
  ["ApprovalItem", "policyVersionId", "G2", ApprovalItem, approval],
  ["ApprovalItem", "tainted", "taint", ApprovalItem, approval],
  ["ApprovalItem", "rules", "G2", ApprovalItem, approval],
  ["ApprovalItem", "taintSources", "taint", ApprovalItem, approval],
  ["ApprovalItem", "chain.trigger", "G1/G2", ApprovalItem, approval],
  ["RunDetail", "verdict", "G7", RunDetail, run],
  ["RunDetail", "provenSpend", "G7", RunDetail, run],
  ["RunDetail", "productiveRatio", "G7", RunDetail, run],
  ["RunDetail", "touched", "G6", RunDetail, run],
  ["AgentRow", "proven30d", "G7", AgentRow, agent],
  ["AgentRow", "productiveRatio", "G7", AgentRow, agent],
  ["AgentRow", "mandateIds", "G1", AgentRow, agent],
  ["AgentDetail", "identity.replayGrade", "G6", AgentDetail, agent],
  ["AgentDetail", "definition", "git", AgentDetail, agent],
  ["AgentDefinition", "path", "git", AgentDefinition, definition],
  ["AgentDefinition", "digest", "git", AgentDefinition, definition],
  ["AgentDefinition", "commitSha", "git", AgentDefinition, definition],
  ["AgentDefinition", "branches", "git", AgentDefinition, definition],
  ["Connection", "requiresMandate", "G1", Connection, connection],
  ["OntologyClass", "citedByAgents", "G10", OntologyClass, ontologyClass],
  ["OntologyClass", "provenRuns", "G7", OntologyClass, ontologyClass],
  ["OntologyClass", "driftFindings", "G4", OntologyClass, ontologyClass],
  ["SteeringRecord", "effect", "M3", SteeringRecord, record],
  ["SpendSummary", "proven", "G7", SpendSummary, seed.spend.summary],
  ["SpendSummary", "accepted", "G7", SpendSummary, seed.spend.summary],
  ["SpendSummary", "unproven", "G7", SpendSummary, seed.spend.summary],
  ["SpendSummary", "productiveRatio", "G7", SpendSummary, seed.spend.summary],
  ["SpendByOperator", "proven", "G7", SpendByOperator, operator],
  ["SpendByOperator", "productiveRatio", "G7", SpendByOperator, operator],
  ["SpendByAgent", "proven", "G7", SpendByAgent, byAgent],
  ["SpendByAgent", "perProvenRun", "G7", SpendByAgent, byAgent],
  ["SpendDrill", "wasted", "G7", SpendDrill, drill],
];

describe("fields not recorded until their store lands", () => {
  it.each(CASES)(
    "%s.%s parses as null (waits on %s)",
    (_contract, field, _gap, schema, row) => {
      expect(schema.safeParse(row).success).toBe(true);
      expect(hasField(row, field)).toBe(true);
      const parsed = schema.safeParse(withField(row, field, null));
      expect(parsed.success).toBe(true);
      expect(fieldAt(parsed.data, field)).toBeNull();
    },
  );

  it.each(CASES)(
    "%s.%s is still required: absent is not the same as not recorded (negative)",
    (_contract, field, _gap, schema, row) => {
      expect(schema.safeParse(withField(row, field)).success).toBe(false);
    },
  );

  it("keeps the git path shape when a definition path is recorded (negative)", () => {
    expect(
      AgentDefinition.safeParse({ ...definition, path: "agents/x.toml" })
        .success,
    ).toBe(false);
  });
});
