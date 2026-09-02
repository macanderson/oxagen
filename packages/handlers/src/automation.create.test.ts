import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  updateSet: vi.fn(),
  // Records every values() payload so tests can assert what the handler
  // actually wrote (e.g. the computed isEnabled), not just what the mock returned.
  insertedValues: [] as Record<string, unknown>[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: (_table: unknown) => ({
          // values() returns an object that is both thenable (for fire-and-forget inserts
          // that don't call .returning()) and exposes .returning() for inserts that do.
          values: (vals: unknown) => {
            mocks.insertedValues.push(vals as Record<string, unknown>);
            const returningFn = mocks.insertReturning;
            const thenable = {
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve(returningFn()).then(resolve),
              returning: returningFn,
            };
            return thenable;
          },
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

import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

const BASE_INPUT = {
  name: "My Automation",
  description: undefined as string | undefined,
  triggerType: "api" as const,
  triggerConfig: {},
  steps: [] as Array<{
    name: string;
    stepType:
      | "agent"
      | "tool"
      | "condition"
      | "webhook"
      | "prompt"
      | "human_input";
    config: Record<string, unknown>;
  }>,
  enabled: false,
};

// Sets up the full happy-path sequence using a call-count–based implementation:
//   insert call 1 → playbook row
//   insert call 2 → version row
//   insert call 3 → step row (no return needed)
//   insert call 4+ → trigger row
function setupHappyPath(triggerType = "api") {
  mocks.insertReturning.mockReset();
  mocks.updateSet.mockReset();
  mocks.insertedValues.length = 0;

  const responses: unknown[][] = [
    [{ id: "plb-uuid-1", publicId: "plb_abc" }], // call 1: playbook
    [{ id: "ver-uuid-1" }], // call 2: version
    [], // call 3: step
    [{ publicId: "plt_abc123", triggerType, isEnabled: true }], // call 4: trigger
  ];
  let callCount = 0;
  mocks.insertReturning.mockImplementation(() => {
    const row = responses[callCount] ?? [
      { publicId: "plt_abc123", triggerType, isEnabled: true },
    ];
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
            {
              property: "status",
              fromValue: "lead",
              toValue: "customer",
              operator: "eq" as const,
            },
          ],
        },
        steps: [],
        enabled: false,
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
        triggerConfig: {
          cronExpression: "0 9 * * 1",
          timezone: "America/New_York",
        },
        steps: [],
        enabled: false,
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
          {
            name: "Send Webhook",
            stepType: "webhook",
            config: { url: "https://example.com" },
          },
        ],
      },
      CTX,
    );
    // still 4 insert calls — the provided step replaces the default
    expect(mocks.insertReturning).toHaveBeenCalledTimes(4);
  });

  // ── enabled / human-origin gate ───────────────────────────────────────────

  // The trigger insert is the only one carrying a triggerType key; the playbook
  // insert is the only one carrying a visibility key. These helpers assert what
  // the handler actually wrote, independent of what the mock returns.
  function triggerInsert(): Record<string, unknown> {
    const row = mocks.insertedValues.find((v) => "triggerType" in v);
    if (!row) throw new Error("no trigger insert recorded");
    return row;
  }
  function playbookInsert(): Record<string, unknown> {
    const row = mocks.insertedValues.find((v) => "visibility" in v);
    if (!row) throw new Error("no playbook insert recorded");
    return row;
  }

  // setupHappyPath returns isEnabled:true from the trigger insert; for the
  // forced-disable cases re-stub it to echo isEnabled:false (what the DB
  // would actually return given the forced-off insert).
  function setupHappyPathDisabled() {
    setupHappyPath();
    const responses: unknown[][] = [
      [{ id: "plb-uuid-1", publicId: "plb_abc" }],
      [{ id: "ver-uuid-1" }],
      [],
      [{ publicId: "plt_abc123", triggerType: "api", isEnabled: false }],
    ];
    let callCount = 0;
    mocks.insertReturning.mockImplementation(() => {
      const row = responses[callCount] ?? [
        { publicId: "plt_abc123", triggerType: "api", isEnabled: false },
      ];
      callCount++;
      return Promise.resolve(row);
    });
  }

  it("enables when surface=api, messageId=null, enabled=true (human-origin)", async () => {
    // CTX has surface='api' and messageId=null — human-origin
    const result = await automationCreateHandler(
      { ...BASE_INPUT, enabled: true },
      CTX,
    );
    expect(triggerInsert().isEnabled).toBe(true);
    expect(playbookInsert().status).toBe("active");
    expect(result.enabled).toBe(true);
    expect(result.status).toBe("active");
  });

  it("forces disabled when surface=api but messageId set (in-chat agent call)", async () => {
    setupHappyPathDisabled();
    const agentCtx = makeCTX({ surface: "api", messageId: "msg_123" });
    const result = await automationCreateHandler(
      { ...BASE_INPUT, enabled: true },
      agentCtx,
    );
    expect(triggerInsert().isEnabled).toBe(false);
    expect(playbookInsert().status).toBe("draft");
    expect(result.enabled).toBe(false);
    expect(result.status).toBe("inactive");
  });

  it("forces disabled when surface=mcp (AI-origin)", async () => {
    setupHappyPathDisabled();
    const mcpCtx = makeCTX({ surface: "mcp" });
    const result = await automationCreateHandler(
      { ...BASE_INPUT, enabled: true },
      mcpCtx,
    );
    expect(triggerInsert().isEnabled).toBe(false);
    expect(result.enabled).toBe(false);
  });

  it("forces disabled when surface=runner (AI-origin)", async () => {
    setupHappyPathDisabled();
    const runnerCtx = makeCTX({ surface: "runner" });
    const result = await automationCreateHandler(
      { ...BASE_INPUT, enabled: true },
      runnerCtx,
    );
    expect(triggerInsert().isEnabled).toBe(false);
    expect(result.enabled).toBe(false);
  });

  it("enables when surface=app, messageId=null, enabled=true (human-origin)", async () => {
    const appCtx = makeCTX({ surface: "app", messageId: null });
    const result = await automationCreateHandler(
      { ...BASE_INPUT, enabled: true },
      appCtx,
    );
    expect(triggerInsert().isEnabled).toBe(true);
    expect(result.enabled).toBe(true);
  });

  it("forces disabled when surface=app but messageId set (in-chat agent via app surface)", async () => {
    setupHappyPathDisabled();
    const appAgentCtx = makeCTX({ surface: "app", messageId: "msg_456" });
    const result = await automationCreateHandler(
      { ...BASE_INPUT, enabled: true },
      appAgentCtx,
    );
    expect(triggerInsert().isEnabled).toBe(false);
    expect(playbookInsert().status).toBe("draft");
    expect(result.enabled).toBe(false);
    expect(result.status).toBe("inactive");
  });

  it("stays disabled when enabled input is false even for human-origin call", async () => {
    setupHappyPathDisabled();
    const result = await automationCreateHandler(
      { ...BASE_INPUT, enabled: false },
      CTX,
    );
    expect(triggerInsert().isEnabled).toBe(false);
    expect(playbookInsert().status).toBe("draft");
    expect(result.enabled).toBe(false);
    expect(result.status).toBe("inactive");
  });

  // ── cross-field trigger validation ────────────────────────────────────────

  it("throws when triggerType=event and entityType is missing", async () => {
    await expect(
      automationCreateHandler(
        {
          ...BASE_INPUT,
          triggerType: "event",
          triggerConfig: { eventType: "node.updated" as const },
        },
        CTX,
      ),
    ).rejects.toThrow(
      "automation.create: triggerType='event' requires triggerConfig.entityType and triggerConfig.eventType",
    );
  });

  it("throws when triggerType=event and eventType is missing", async () => {
    await expect(
      automationCreateHandler(
        {
          ...BASE_INPUT,
          triggerType: "event",
          triggerConfig: { entityType: "Contact" },
        },
        CTX,
      ),
    ).rejects.toThrow(
      "automation.create: triggerType='event' requires triggerConfig.entityType and triggerConfig.eventType",
    );
  });

  it("throws when triggerType=schedule and cronExpression is missing", async () => {
    await expect(
      automationCreateHandler(
        {
          ...BASE_INPUT,
          triggerType: "schedule",
          triggerConfig: { timezone: "America/New_York" },
        },
        CTX,
      ),
    ).rejects.toThrow(
      "automation.create: triggerType='schedule' requires triggerConfig.cronExpression",
    );
  });

  it("returns enabled output field on success (default false, happy path)", async () => {
    const result = await automationCreateHandler(BASE_INPUT, CTX);
    expect(result).toHaveProperty("enabled");
    expect(typeof result.enabled).toBe("boolean");
  });
});
