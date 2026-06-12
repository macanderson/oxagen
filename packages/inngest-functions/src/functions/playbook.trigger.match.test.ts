import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  insertEvents: vi.fn().mockResolvedValue(undefined),
  inngestSend: vi.fn().mockResolvedValue(undefined),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
    sendEvent: (name: string, payload: unknown) => Promise<void>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;
let capturedCreateFunctionArgs: unknown[] | null = null;

mocks.createFunction.mockImplementation(
  (opts: unknown, trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    capturedCreateFunctionArgs = [opts, trigger];
    return {};
  },
);

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.createFunction, send: mocks.inngestSend },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
});

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, insertEvents: mocks.insertEvents };
});

vi.mock("../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

// Import the module under test via dynamic import so that all vi.mock() calls
// above are registered BEFORE the module evaluates. Static import statements
// are hoisted to the top of the file and execute before mocks are wired, so
// we cannot use `import { ... }` here.
const { evaluatePropertyConditions } = await import("./playbook.trigger.match");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_EVENT = {
  nodeId: "neo4j-node-1",
  entityType: "Commit",
  propertiesSnapshot: {
    sha: "abc123",
    message: "fix: crash",
    git_branch: "main",
    author: "mac",
  },
  workspaceId: "ws-1",
  orgId: "org-1",
  naturalKey: "github:conn-1:abc123",
  isNew: true,
};

function makeStep(overrides: Partial<HandlerCtx["step"]> = {}): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── evaluatePropertyConditions unit tests ─────────────────────────────────────

describe("evaluatePropertyConditions", () => {
  const props = { name: "main", count: 5, active: true };

  it("returns true for empty conditions array (vacuous match)", () => {
    expect(evaluatePropertyConditions([], props)).toBe(true);
  });

  describe("eq operator", () => {
    it("matches a string property exactly", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "name", operator: "eq", toValue: "main" }],
          props,
        ),
      ).toBe(true);
    });

    it("rejects a non-matching string value", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "name", operator: "eq", toValue: "develop" }],
          props,
        ),
      ).toBe(false);
    });

    it("matches a number property using numeric equality", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "eq", toValue: 5 }],
          props,
        ),
      ).toBe(true);
    });

    it("rejects a wrong number", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "eq", toValue: 6 }],
          props,
        ),
      ).toBe(false);
    });

    it("returns false when toValue is undefined", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "name", operator: "eq" }],
          props,
        ),
      ).toBe(false);
    });

    it("returns false for missing property", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "nonexistent", operator: "eq", toValue: "x" }],
          props,
        ),
      ).toBe(false);
    });
  });

  describe("gt operator", () => {
    it("returns true when property > threshold", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "gt", toValue: 3 }],
          props,
        ),
      ).toBe(true);
    });

    it("returns false when property equals threshold", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "gt", toValue: 5 }],
          props,
        ),
      ).toBe(false);
    });

    it("returns false when property < threshold", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "gt", toValue: 10 }],
          props,
        ),
      ).toBe(false);
    });

    it("returns false when threshold is NaN (non-numeric toValue)", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "gt", toValue: "notanumber" }],
          props,
        ),
      ).toBe(false);
    });

    it("returns false when property coerces to NaN", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "name", operator: "gt", toValue: 3 }],
          props,
        ),
      ).toBe(false);
    });
  });

  describe("lt operator", () => {
    it("returns true when property < threshold", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "lt", toValue: 10 }],
          props,
        ),
      ).toBe(true);
    });

    it("returns false when property equals threshold", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "lt", toValue: 5 }],
          props,
        ),
      ).toBe(false);
    });

    it("returns false when property > threshold", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "lt", toValue: 2 }],
          props,
        ),
      ).toBe(false);
    });

    it("returns false when threshold is NaN", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "count", operator: "lt", toValue: "abc" }],
          props,
        ),
      ).toBe(false);
    });
  });

  describe("changed operator", () => {
    it("returns true when property is present and no previousProperties provided", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "name", operator: "changed" }],
          props,
        ),
      ).toBe(true);
    });

    it("returns false when property is missing (undefined)", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "missing_field", operator: "changed" }],
          props,
        ),
      ).toBe(false);
    });

    it("returns true when value changed from previous", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "name", operator: "changed" }],
          props,
          { name: "develop" },
        ),
      ).toBe(true);
    });

    it("returns false when value is the same as previous", () => {
      expect(
        evaluatePropertyConditions(
          [{ property: "name", operator: "changed" }],
          props,
          { name: "main" },
        ),
      ).toBe(false);
    });
  });

  describe("multiple conditions (AND semantics)", () => {
    it("returns true when all conditions pass", () => {
      expect(
        evaluatePropertyConditions(
          [
            { property: "name", operator: "eq", toValue: "main" },
            { property: "count", operator: "gt", toValue: 3 },
          ],
          props,
        ),
      ).toBe(true);
    });

    it("returns false when any condition fails", () => {
      expect(
        evaluatePropertyConditions(
          [
            { property: "name", operator: "eq", toValue: "main" },
            { property: "count", operator: "gt", toValue: 10 }, // fails
          ],
          props,
        ),
      ).toBe(false);
    });
  });
});

// ── playbook.trigger.match Inngest function tests ─────────────────────────────

describe("playbook.trigger.match Inngest function", () => {
  const TRIGGER_ROW = {
    id: "plt-uuid-1",
    playbookId: "plb-uuid-1",
    pinnedVersionId: null as string | null,
    config: {
      entityType: "Commit",
      eventType: "node.created",
      propertyConditions: [
        { property: "git_branch", operator: "eq", toValue: "main" },
      ],
    },
  };

  const PLAYBOOK_ROW = {
    id: "plb-uuid-1",
    activeVersionId: "ver-uuid-1",
  };

  const MOCK_RUN = { id: "run-uuid-1", status: "pending" };

  // withSystemDb is called 3 times per trigger: (1) load-triggers, (2) load playbook
  // withTenantDb (via runInTenantScope) is called for the insert
  function setupHappyPath() {
    let systemCallCount = 0;
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      systemCallCount++;
      const call = systemCallCount;
      if (call === 1) {
        // load-triggers: returns a .select().from().where() chain
        return fn({
          select: () => ({
            from: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: TRIGGER_ROW.id,
                    playbookId: TRIGGER_ROW.playbookId,
                    pinnedVersionId: TRIGGER_ROW.pinnedVersionId,
                    config: TRIGGER_ROW.config,
                  },
                ]),
            }),
          }),
          query: {
            playbooks: {
              findFirst: vi.fn().mockResolvedValue(PLAYBOOK_ROW),
            },
          },
        });
      }
      // call 2+: dispatch-run — playbook lookup
      return fn({
        query: {
          playbooks: {
            findFirst: vi.fn().mockResolvedValue(PLAYBOOK_ROW),
          },
        },
      });
    });

    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        insert: (_table: unknown) => ({
          values: (_vals: unknown) => ({
            returning: vi.fn().mockResolvedValue([MOCK_RUN]),
          }),
        }),
      }),
    );

    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
  });

  it("registers with correct id and event trigger", () => {
    expect(capturedCreateFunctionArgs).not.toBeNull();
    const [opts, trigger] = capturedCreateFunctionArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({
      id: "playbook-trigger-match",
      retries: 3,
    });
    expect(trigger).toMatchObject({ event: "ingestion/entity.created" });
  });

  it("returns { evaluated: 0, matched: 0, dispatched: 0 } when no triggers exist", async () => {
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      }),
    );

    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(result).toEqual({ evaluated: 0, matched: 0, dispatched: 0 });
  });

  it("skips triggers with non-matching entityType", async () => {
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  id: "plt-2",
                  playbookId: "plb-2",
                  pinnedVersionId: null,
                  config: { entityType: "PullRequest", eventType: "node.created" },
                },
              ]),
          }),
        }),
      }),
    );

    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(result).toMatchObject({ evaluated: 0, matched: 0, dispatched: 0 });
  });

  it("dispatches a run when entityType matches and all conditions pass", async () => {
    setupHappyPath();
    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(result).toMatchObject({ evaluated: 1, matched: 1, dispatched: 1 });
  });

  it("does NOT dispatch when property condition fails (branch != main)", async () => {
    let systemCallCount = 0;
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      systemCallCount++;
      if (systemCallCount === 1) {
        return fn({
          select: () => ({
            from: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: TRIGGER_ROW.id,
                    playbookId: TRIGGER_ROW.playbookId,
                    pinnedVersionId: null,
                    config: {
                      entityType: "Commit",
                      eventType: "node.created",
                      propertyConditions: [
                        { property: "git_branch", operator: "eq", toValue: "main" },
                      ],
                    },
                  },
                ]),
            }),
          }),
        });
      }
      return fn({});
    });

    const eventOnDevelop = {
      ...BASE_EVENT,
      propertiesSnapshot: { ...BASE_EVENT.propertiesSnapshot, git_branch: "develop" },
    };

    const step = makeStep();
    const result = await capturedHandler!({ event: { data: eventOnDevelop }, step });
    expect(result).toMatchObject({ evaluated: 1, matched: 0, dispatched: 0 });
  });

  it("skips dispatch (but does not throw) when playbook has no active version", async () => {
    let systemCallCount = 0;
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      systemCallCount++;
      if (systemCallCount === 1) {
        return fn({
          select: () => ({
            from: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: TRIGGER_ROW.id,
                    playbookId: TRIGGER_ROW.playbookId,
                    pinnedVersionId: null,
                    config: {
                      entityType: "Commit",
                      eventType: "node.created",
                      propertyConditions: [],
                    },
                  },
                ]),
            }),
          }),
        });
      }
      // call 2: playbook lookup returns no activeVersionId
      return fn({
        query: {
          playbooks: {
            findFirst: vi.fn().mockResolvedValue({ id: "plb-1", activeVersionId: null }),
          },
        },
      });
    });

    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    // matched=1 but dispatched=0 because playbook had no active version
    expect(result).toMatchObject({ evaluated: 1, matched: 1, dispatched: 0 });
  });

  it("uses pinnedVersionId when set, instead of playbook activeVersionId", async () => {
    let systemCallCount = 0;
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      systemCallCount++;
      if (systemCallCount === 1) {
        return fn({
          select: () => ({
            from: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: TRIGGER_ROW.id,
                    playbookId: TRIGGER_ROW.playbookId,
                    pinnedVersionId: "pinned-ver-999",
                    config: { entityType: "Commit", eventType: "node.created" },
                  },
                ]),
            }),
          }),
        });
      }
      return fn({
        query: {
          playbooks: {
            findFirst: vi.fn().mockResolvedValue(PLAYBOOK_ROW),
          },
        },
      });
    });

    const insertReturning = vi.fn().mockResolvedValue([MOCK_RUN]);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        insert: (_table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            // Verify that playbookVersionId is the pinned version, not active
            expect(vals["playbookVersionId"]).toBe("pinned-ver-999");
            return { returning: insertReturning };
          },
        }),
      }),
    );

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(insertReturning).toHaveBeenCalledTimes(1);
  });

  it("records telemetry via insertEvents even when some triggers do not match", async () => {
    setupHappyPath();
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(mocks.insertEvents).toHaveBeenCalledTimes(1);
    const rows = mocks.insertEvents.mock.calls[0]![0] as Array<{ event_type: string }>;
    expect(rows.some((r) => r.event_type === "playbook_trigger.evaluated")).toBe(true);
    expect(rows.some((r) => r.event_type === "playbook_trigger.dispatched")).toBe(true);
  });

  it("does not throw when insertEvents fails (telemetry loss is non-fatal)", async () => {
    setupHappyPath();
    mocks.insertEvents.mockRejectedValueOnce(new Error("clickhouse down"));

    const step = makeStep();
    // Should resolve successfully despite telemetry failure
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(result).toMatchObject({ dispatched: 1 });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ telErr: expect.any(Error) }),
      expect.stringContaining("telemetry loss"),
    );
  });

  it("dispatches a run with source='event' and no startedByUserId", async () => {
    setupHappyPath();

    let capturedValues: Record<string, unknown> | undefined;
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        insert: (_table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            capturedValues = vals;
            return { returning: vi.fn().mockResolvedValue([MOCK_RUN]) };
          },
        }),
      }),
    );

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(capturedValues).toBeDefined();
    expect(capturedValues!["source"]).toBe("event");
    expect(capturedValues!["startedByUserId"]).toBeUndefined();
    expect(capturedValues!["status"]).toBe("pending");
  });

  it("sends playbook/run.execute inngest event after each dispatched run", async () => {
    setupHappyPath();
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: "playbook/run.execute",
      data: {
        runId: MOCK_RUN.id,
        orgId: BASE_EVENT.orgId,
        workspaceId: BASE_EVENT.workspaceId,
      },
    });
  });

  it("does NOT send playbook/run.execute when no triggers match", async () => {
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      }),
    );
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});
