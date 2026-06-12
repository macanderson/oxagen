import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: (_table: unknown) => ({
          values: (_vals: unknown) => ({
            returning: mocks.insertReturning,
          }),
        }),
        update: (_table: unknown) => ({
          set: (_vals: unknown) => ({
            where: mocks.updateSet,
          }),
        }),
      }),
  };
});

import { automationCreateHandler } from "./automation.create";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const BASE_INPUT = {
  name: "My Automation",
  description: undefined as string | undefined,
  triggerType: "api" as const,
  triggerConfig: {},
  steps: [] as Array<{
    name: string;
    stepType: "agent" | "tool" | "condition" | "webhook" | "prompt" | "human_input";
    config: Record<string, unknown>;
  }>,
};

// Sets up the full happy-path sequence using a call-count–based implementation:
//   insert call 1 → playbook row
//   insert call 2 → version row
//   insert call 3 → step row (no return needed)
//   insert call 4+ → trigger row
function setupHappyPath(triggerType = "api") {
  mocks.insertReturning.mockReset();
  mocks.updateSet.mockReset();

  const responses: unknown[][] = [
    [{ id: "plb-uuid-1", publicId: "plb_abc" }], // call 1: playbook
    [{ id: "ver-uuid-1" }],                       // call 2: version
    [],                                             // call 3: step
    [{ publicId: "plt_abc123", triggerType, isEnabled: true }], // call 4: trigger
  ];
  let callCount = 0;
  mocks.insertReturning.mockImplementation(() => {
    const row = responses[callCount] ?? [{ publicId: "plt_abc123", triggerType, isEnabled: true }];
    callCount++;
    return Promise.resolve(row);
  });
  mocks.updateSet.mockResolvedValue([]);
}

describe("automationCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => setupHappyPath());

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(automationCreateHandler(BASE_INPUT, anonCtx)).rejects.toThrow(
      "automation.create requires an authenticated user",
    );
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns automation_id, playbook_id, name, status, and triggerType on success", async () => {
    const result = await automationCreateHandler(BASE_INPUT, CTX);
    expect(result.automation_id).toBe("plt_abc123");
    expect(result.playbook_id).toBe("plb_abc");
    expect(result.name).toBe("My Automation");
    expect(result.status).toBe("active");
    expect(result.triggerType).toBe("api");
  });

  it("inserts playbook, version, step, and trigger — four insert calls total", async () => {
    await automationCreateHandler(BASE_INPUT, CTX);
    // 1 playbook + 1 version + 1 default step + 1 trigger
    expect(mocks.insertReturning).toHaveBeenCalledTimes(4);
  });

  it("sets activeVersionId on the playbook — update is called once", async () => {
    await automationCreateHandler(BASE_INPUT, CTX);
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
  });

  it("throws when playbook insert returns no row", async () => {
    mocks.insertReturning.mockReset();
    mocks.insertReturning.mockResolvedValueOnce([]); // playbook → empty
    await expect(automationCreateHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.create: playbook insert returned no row",
    );
  });

  it("throws when version insert returns no row", async () => {
    mocks.insertReturning.mockReset();
    mocks.insertReturning
      .mockResolvedValueOnce([{ id: "plb-uuid-1", publicId: "plb_abc" }]) // playbook ok
      .mockResolvedValueOnce([]); // version → empty
    await expect(automationCreateHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.create: version insert returned no row",
    );
  });

  it("throws when trigger insert returns no row", async () => {
    mocks.insertReturning.mockReset();
    mocks.updateSet.mockReset();
    mocks.insertReturning
      .mockResolvedValueOnce([{ id: "plb-uuid-1", publicId: "plb_abc" }]) // playbook
      .mockResolvedValueOnce([{ id: "ver-uuid-1" }]) // version
      .mockResolvedValueOnce([]) // step
      .mockResolvedValueOnce([]); // trigger → empty
    mocks.updateSet.mockResolvedValue([]);
    await expect(automationCreateHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.create: trigger insert returned no row",
    );
  });

  it("passes the automation name through from input", async () => {
    const result = await automationCreateHandler(
      { ...BASE_INPUT, name: "Scheduled Report" },
      CTX,
    );
    expect(result.name).toBe("Scheduled Report");
  });

  it("accepts an event triggerType with config", async () => {
    setupHappyPath("event");
    const result = await automationCreateHandler(
      {
        name: "Contact Status Watcher",
        triggerType: "event",
        triggerConfig: {
          entityType: "Contact",
          eventType: "node.updated",
          propertyConditions: [
            { property: "status", fromValue: "lead", toValue: "customer", operator: "eq" as const },
          ],
        },
        steps: [],
      },
      CTX,
    );
    expect(result.triggerType).toBe("event");
    expect(result.automation_id).toBe("plt_abc123");
  });

  it("accepts a schedule triggerType with cronExpression", async () => {
    setupHappyPath("schedule");
    const result = await automationCreateHandler(
      {
        name: "Monday Morning Report",
        triggerType: "schedule",
        triggerConfig: { cronExpression: "0 9 * * 1", timezone: "America/New_York" },
        steps: [],
      },
      CTX,
    );
    expect(result.triggerType).toBe("schedule");
    expect(result.automation_id).toBe("plt_abc123");
  });

  it("uses provided steps instead of the default agent step", async () => {
    await automationCreateHandler(
      {
        ...BASE_INPUT,
        steps: [
          { name: "Send Webhook", stepType: "webhook", config: { url: "https://example.com" } },
        ],
      },
      CTX,
    );
    // still 4 insert calls — the provided step replaces the default
    expect(mocks.insertReturning).toHaveBeenCalledTimes(4);
  });
});
