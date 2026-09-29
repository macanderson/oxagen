// stubs.test.ts: each function in the Shared contract exports with its final
// signature and throws until its lane builds it, and the names every lane shares
// match agent-work-spec.html. A lane that builds a stub deletes its case here.
import { describe, expect, it } from "vitest";
import {
  AUTONOMY_ACTION_TYPE,
  AUTONOMY_PRINCIPAL_TYPE,
  AUTONOMY_RESOURCE_TYPE,
  type AutonomyFacts,
  autonomyAllows,
} from "./autonomy/autonomy-allows";
import { NotBuiltError } from "./not-built";
import {
  CLAIM_STALE_MINUTES,
  WORK_ORDER_STATES,
  type WorkOrderFacts,
  evaluateWorkOrder,
} from "./plan/evaluate-work-order";
import {
  CLAIM_MODES,
  CLAIM_SOURCES,
  type Claim,
  GROUP_MAX_MINUTES,
  MAX_OPEN_WORK_ORDERS_DEFAULT,
  type PlanInput,
  planWorkOrders,
} from "./plan/plan-work-orders";
import {
  FIRST_MODEL_MIN_POSITIVE,
  RETENTION_MODES,
  TRAINING_LABEL_WINDOW_DAYS,
  type TrainingSetInput,
  exportTrainingSet,
} from "./training/export-training-set";
import { type TriageInput, triageItem } from "./triage/triage-item";
import {
  AUTONOMY_CAUSES,
  AUTONOMY_EVIDENCE_CHECK,
  AUTONOMY_LEVEL_NAMES,
  COLLECTOR_HEALTH,
  MEDIUM_RISK_FILES,
  MEDIUM_RISK_LINES,
  RECONCILE_INTERVAL_MINUTES,
  RISK_LEVELS,
  TRIAGE_DECISIONS_PER_MINUTE,
  TRIAGE_PREVIEW_CHECK,
  WORK_ACTIONS,
  WORK_MCP_TOOLS,
  WORK_OTLP_ATTRIBUTES,
  WORK_STEERING_CHECKS,
} from "./types";

const NOW = "2026-09-29T12:00:00Z";
const DIGEST = "sha256:0e5a9c2d7b41f83e6a0c9d1b5f27e4a8c3d60b9f1e2a7c54d8b0f3e6a19c2d7b" as const;

const claim: Claim = {
  repo: "aintel/billing-service",
  glob: "src/**",
  mode: "exclusive",
  source: "predicted",
};

describe("stubs", () => {
  it("triageItem rejects", async () => {
    const input: TriageInput = {
      item: {
        id: "wi_01K5ZQ4M8T2DXW",
        collector: "support-zendesk",
        title: "Invoice export fails",
        body: "The export button returns an error.",
        labels: ["Bug"],
      },
      priorities: { lineage: "aintel.work.priorities", hash: DIGEST, body: "1. Paying customers first." },
      openWork: [],
      fileTrees: [{ repo: "aintel/billing-service", paths: ["src/export.ts"] }],
      workflows: {},
      model: {
        complete: () => Promise.reject(new Error("The stub must not call the model.")),
      },
    };
    await expect(triageItem(input)).rejects.toBeInstanceOf(NotBuiltError);
    await expect(triageItem(input)).rejects.toThrow("triageItem is not built");
  });

  it("planWorkOrders throws", () => {
    const input: PlanInput = {
      tasks: [{ item: "wi_01K5ZQ4M8T2DXW", number: 481, priority: "P1", estimateMinutes: 45, claims: [claim] }],
      providerOrder: [],
      inFlight: [],
      targets: [{ target: "aintel.core.bug-fixer", maxOpenWorkOrders: 1, openWorkOrders: 0 }],
      noConflict: [],
      serialGroups: [],
    };
    expect(() => planWorkOrders(input)).toThrow(NotBuiltError);
  });

  it("evaluateWorkOrder throws", () => {
    const facts: WorkOrderFacts = {
      sentAt: null,
      claim: null,
      prLinked: false,
      items: 1,
      itemsClaimed: 0,
      acceptedAt: null,
      stoppedAt: null,
      collisions: [],
      parkedThreads: 0,
      leases: [{ claim, renewedAt: NOW }],
      now: NOW,
    };
    expect(() => evaluateWorkOrder(facts)).toThrow(NotBuiltError);
  });

  it("autonomyAllows throws", () => {
    const facts: AutonomyFacts = {
      operator: "priya",
      level: 2,
      verdict: "proven",
      risk: "low",
      lintPassed: true,
      closeSwitch: false,
      spentTodayUsd: 3.2,
      maxDailyUsd: 40,
    };
    expect(() => autonomyAllows({ label: "Documentation" }, "work.merge", facts)).toThrow(NotBuiltError);
  });

  it("exportTrainingSet throws", () => {
    const input: TrainingSetInput = {
      records: [],
      traces: [],
      consent: { consent: "own_model", approved_by: "mac" },
      now: NOW,
    };
    expect(() => exportTrainingSet(input)).toThrow(NotBuiltError);
  });
});

describe("shared names", () => {
  it("match the Shared contract", () => {
    expect(WORK_MCP_TOOLS).toEqual([
      "claim_dod_item",
      "hand_off_work_order",
      "return_work_order",
      "accept_work_order",
      "send_plan",
      "set_task_priority",
    ]);
    expect(Object.values(WORK_OTLP_ATTRIBUTES)).toEqual([
      "oxagen.work_item.id",
      "oxagen.work_order.id",
      "oxagen.stage.kind",
      "oxagen.done_record.digest",
    ]);
    expect(WORK_ACTIONS).toEqual(["work.send", "work.merge", "work.lock", "work.close"]);
    expect(WORK_STEERING_CHECKS).toEqual([TRIAGE_PREVIEW_CHECK, AUTONOMY_EVIDENCE_CHECK]);
    expect(TRIAGE_PREVIEW_CHECK).toBe("Triage preview");
    expect(AUTONOMY_EVIDENCE_CHECK).toBe("Autonomy evidence");
  });

  it("name the Cedar entity types and the autonomy levels", () => {
    expect(AUTONOMY_PRINCIPAL_TYPE).toBe("Oxagen::Operator");
    expect(AUTONOMY_ACTION_TYPE).toBe("Oxagen::Action");
    expect(AUTONOMY_RESOURCE_TYPE).toBe("Oxagen::WorkOrder");
    expect(AUTONOMY_LEVEL_NAMES).toEqual({ 0: "Suggest", 1: "Send", 2: "Merge proven", 3: "Autonomous" });
    expect(AUTONOMY_CAUSES).toContain("revert");
    expect(RISK_LEVELS).toEqual(["low", "medium", "high"]);
    expect([MEDIUM_RISK_LINES, MEDIUM_RISK_FILES]).toEqual([400, 20]);
  });

  it("fix the plan, work order, collector, and training limits", () => {
    expect(GROUP_MAX_MINUTES).toBe(120);
    expect(MAX_OPEN_WORK_ORDERS_DEFAULT).toBe(1);
    expect(CLAIM_MODES).toEqual(["exclusive", "shared"]);
    expect(CLAIM_SOURCES).toEqual(["predicted", "declared", "observed"]);
    expect(WORK_ORDER_STATES).toEqual([
      "queued",
      "sent",
      "in_progress",
      "pr_opened",
      "waiting_on_you",
      "accepted",
      "stopped",
    ]);
    expect(CLAIM_STALE_MINUTES).toBe(60);
    expect(COLLECTOR_HEALTH).toEqual(["healthy", "lagging", "failing", "paused"]);
    expect(RECONCILE_INTERVAL_MINUTES).toBe(15);
    expect(TRIAGE_DECISIONS_PER_MINUTE).toBe(60);
    expect(TRAINING_LABEL_WINDOW_DAYS).toBe(30);
    expect(FIRST_MODEL_MIN_POSITIVE).toBe(1000);
    expect(RETENTION_MODES).toEqual(["digest_only", "content_exact", "environment_restore"]);
  });
});
