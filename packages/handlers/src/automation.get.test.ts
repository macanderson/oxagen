import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  triggerRows: [] as unknown[],
  playbookRows: [] as unknown[],
  stepsRows: [] as unknown[],
  runsRows: [] as unknown[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const { schema } = real;
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: (_cols: unknown) => ({
          from: (table: unknown) => ({
            where: (_cond: unknown) => {
              if (table === schema.playbookTriggers) {
                return { limit: () => Promise.resolve(mocks.triggerRows) };
              }
              if (table === schema.playbooks) {
                return { limit: () => Promise.resolve(mocks.playbookRows) };
              }
              if (table === schema.playbookSteps) {
                return { orderBy: () => Promise.resolve(mocks.stepsRows) };
              }
              if (table === schema.playbookRuns) {
                return {
                  orderBy: () => ({
                    limit: () => Promise.resolve(mocks.runsRows),
                  }),
                };
              }
              throw new Error(
                `unexpected table passed to mocked tx.select: ${String(table)}`,
              );
            },
          }),
        }),
      };
      return fn(tx);
    },
  };
});

import { automationGetHandler } from "./automation.get";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

// Row shapes mirror what the handler selects:
//   trigger:  publicId, playbookId, triggerType, config, isEnabled  (playbookTriggers)
//   playbook: publicId, name, description, status, activeVersionId (playbooks)
//   step:     stepKey, name, stepType, config                      (playbookSteps)
//   run:      id, status, source, startedAt, completedAt, createdAt (playbookRuns)
const makeTrigger = (overrides: Record<string, unknown> = {}) => ({
  publicId: "plt_abc",
  playbookId: "plb_internal_uuid",
  triggerType: "schedule",
  config: { cronExpression: "0 0 * * *" },
  isEnabled: true,
  ...overrides,
});

const makePlaybook = (overrides: Record<string, unknown> = {}) => ({
  publicId: "plb_xyz",
  name: "Nightly sync",
  description: "Syncs data every night",
  status: "active",
  activeVersionId: "ver_1",
  ...overrides,
});

const makeStep = (overrides: Record<string, unknown> = {}) => ({
  stepKey: "fetch_context",
  name: "Fetch Context",
  stepType: "tool",
  config: { toolId: "tool_1" },
  ...overrides,
});

const makeRun = (overrides: Record<string, unknown> = {}) => ({
  id: "run_1",
  status: "completed",
  source: "schedule",
  startedAt: new Date("2026-07-01T00:00:00.000Z") as Date | null,
  completedAt: new Date("2026-07-01T00:01:00.000Z") as Date | null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  ...overrides,
});

describe("automationGetHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.triggerRows = [];
    mocks.playbookRows = [];
    mocks.stepsRows = [];
    mocks.runsRows = [];
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      automationGetHandler({ automation_id: "plt_abc" }, anonCtx),
    ).rejects.toThrow("automation.get requires an authenticated user");
  });

  // ── not found ─────────────────────────────────────────────────────────────

  it("throws not found when the trigger doesn't exist", async () => {
    mocks.triggerRows = [];
    await expect(
      automationGetHandler({ automation_id: "plt_missing" }, CTX),
    ).rejects.toThrow("automation.get: automation not found");
  });

  it("throws not found when the trigger exists but the playbook doesn't (deleted/dangling)", async () => {
    mocks.triggerRows = [makeTrigger()];
    mocks.playbookRows = [];
    await expect(
      automationGetHandler({ automation_id: "plt_abc" }, CTX),
    ).rejects.toThrow("automation.get: automation not found");
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("maps rows to the full contract output shape", async () => {
    mocks.triggerRows = [makeTrigger()];
    mocks.playbookRows = [makePlaybook()];
    mocks.stepsRows = [makeStep()];
    mocks.runsRows = [makeRun()];

    const result = await automationGetHandler(
      { automation_id: "plt_abc" },
      CTX,
    );

    expect(result.automation_id).toBe("plt_abc");
    expect(result.playbook_id).toBe("plb_xyz");
    expect(result.name).toBe("Nightly sync");
    expect(result.description).toBe("Syncs data every night");
    expect(result.status).toBe("active");
    expect(result.triggerType).toBe("schedule");
    expect(result.enabled).toBe(true);
    expect(result.triggerConfig).toEqual({ cronExpression: "0 0 * * *" });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toEqual({
      stepKey: "fetch_context",
      name: "Fetch Context",
      stepType: "tool",
      config: { toolId: "tool_1" },
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toEqual({
      id: "run_1",
      status: "completed",
      source: "schedule",
      startedAt: "2026-07-01T00:00:00.000Z",
      completedAt: "2026-07-01T00:01:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("returns an empty steps array when the playbook has no active version", async () => {
    mocks.triggerRows = [makeTrigger()];
    mocks.playbookRows = [makePlaybook({ activeVersionId: null })];
    mocks.runsRows = [];

    const result = await automationGetHandler(
      { automation_id: "plt_abc" },
      CTX,
    );
    expect(result.steps).toEqual([]);
  });

  it("null-safely converts runs with no startedAt/completedAt", async () => {
    mocks.triggerRows = [makeTrigger()];
    mocks.playbookRows = [makePlaybook()];
    mocks.stepsRows = [];
    mocks.runsRows = [
      makeRun({ startedAt: null, completedAt: null, status: "pending" }),
    ];

    const result = await automationGetHandler(
      { automation_id: "plt_abc" },
      CTX,
    );
    expect(result.runs[0]?.startedAt).toBeNull();
    expect(result.runs[0]?.completedAt).toBeNull();
    expect(result.runs[0]?.createdAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("maps isEnabled:false to enabled:false and status 'inactive'", async () => {
    mocks.triggerRows = [makeTrigger({ isEnabled: false })];
    mocks.playbookRows = [makePlaybook({ status: "draft" })];
    mocks.stepsRows = [];
    mocks.runsRows = [];

    const result = await automationGetHandler(
      { automation_id: "plt_abc" },
      CTX,
    );
    expect(result.enabled).toBe(false);
    expect(result.status).toBe("draft");
  });

  it("maps multiple steps and runs in order", async () => {
    mocks.triggerRows = [makeTrigger()];
    mocks.playbookRows = [makePlaybook()];
    mocks.stepsRows = [
      makeStep({ stepKey: "step_1", name: "First" }),
      makeStep({ stepKey: "step_2", name: "Second" }),
    ];
    mocks.runsRows = [
      makeRun({ id: "run_a" }),
      makeRun({ id: "run_b", status: "failed" }),
    ];

    const result = await automationGetHandler(
      { automation_id: "plt_abc" },
      CTX,
    );
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.stepKey).toBe("step_1");
    expect(result.steps[1]?.stepKey).toBe("step_2");
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]?.id).toBe("run_a");
    expect(result.runs[1]?.status).toBe("failed");
  });
});
