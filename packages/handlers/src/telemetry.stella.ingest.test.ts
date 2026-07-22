import type { CapabilityContext } from "@oxagen/oxagen";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertStellaOperationalEvents: vi.fn(),
  loggerError: vi.fn(),
  apiKeyFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...original,
    withTenantDb: mocks.withTenantDb,
  };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...original,
    insertStellaOperationalEvents: mocks.insertStellaOperationalEvents,
  };
});

vi.mock("./logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn() },
}));

import { telemetryStellaIngest } from "@oxagen/oxagen/contracts/telemetry.stella.ingest";
import { telemetryStellaIngestHandler } from "./telemetry.stella.ingest";

const CONTEXT: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: null,
  apiKeyId: "aky_stella",
  requestId: "req_stella",
  surface: "api",
  messageId: null,
};

const EVENT_ID = `evt_${"a".repeat(64)}`;
const SECOND_EVENT_ID = `evt_${"b".repeat(64)}`;
const ENROLLMENT_ID = "enrollment-1";
const PROTECTED_SCOPE = {
  purpose: "stella_operational_telemetry_v1",
  enrollment_id: ENROLLMENT_ID,
};

function scriptApiKey(
  scope: unknown,
  enrollmentId: string | null = ENROLLMENT_ID,
  enrolledAt: Date | null = new Date("2026-07-21T00:00:00Z"),
): void {
  mocks.apiKeyFindFirst.mockResolvedValue(
    scope === undefined
      ? undefined
      : {
          scope,
          stellaTelemetryEnrollmentId: enrollmentId,
          stellaTelemetryEnrolledAt: enrolledAt,
        },
  );
}

const makeInput = () =>
  telemetryStellaIngest.input.parse({
    schema: "stella.operational.batch.v1",
    events: [
      {
        schema: "stella.operational.v1",
        event_class: "execution_rollup",
        event_id: EVENT_ID,
        enrollment_id: ENROLLMENT_ID,
        organization_id: "client-org-compatibility-label",
        workspace_id: "client-workspace-compatibility-label",
        provider: "anthropic",
        model: "claude/sonnet",
        outcome: "completed",
        duration_ms: 1234,
        input_tokens: 101,
        output_tokens: 202,
        cost_microusd: 303,
        tool_call_count: 4,
        changed_file_count: 5,
        produced_output: true,
      },
    ],
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertStellaOperationalEvents.mockResolvedValue(undefined);
  mocks.subscriptionFindFirst.mockResolvedValue({
    id: "sub_enterprise",
    status: "active",
    plan: { tier: "enterprise" },
  });
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: {
          apiKeys: { findFirst: mocks.apiKeyFindFirst },
          subscriptions: { findFirst: mocks.subscriptionFindFirst },
        },
      }),
  );
  scriptApiKey(PROTECTED_SCOPE);
});

describe("telemetryStellaIngestHandler", () => {
  it("denies an org with no active subscription despite a forged Enterprise plan slug", async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(undefined);

    await expect(
      telemetryStellaIngestHandler(makeInput(), CONTEXT),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
  });

  it.each(["canceled", "past_due"])(
    "denies an org whose Enterprise subscription is %s",
    async (status) => {
      mocks.subscriptionFindFirst.mockResolvedValue({
        id: "sub_stale",
        status,
        plan: { tier: "enterprise" },
      });

      await expect(
        telemetryStellaIngestHandler(makeInput(), CONTEXT),
      ).rejects.toMatchObject({ code: "authz_denied" });
      expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
    },
  );

  it("denies an active non-Enterprise subscription", async () => {
    mocks.subscriptionFindFirst.mockResolvedValue({
      id: "sub_build",
      status: "active",
      plan: { tier: "build" },
    });

    await expect(
      telemetryStellaIngestHandler(makeInput(), CONTEXT),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary", { environment: "production" }],
    ["wrong purpose", { purpose: "general", enrollment_id: ENROLLMENT_ID }],
    [
      "malformed protected",
      {
        purpose: "stella_operational_telemetry_v1",
        enrollment_id: ENROLLMENT_ID,
        extra: true,
      },
    ],
  ])("denies an Enterprise org with %s API-key scope", async (_name, scope) => {
    scriptApiKey(scope);

    await expect(
      telemetryStellaIngestHandler(makeInput(), CONTEXT),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
  });

  it("denies when the authenticated API-key row is no longer active", async () => {
    scriptApiKey(undefined);

    await expect(
      telemetryStellaIngestHandler(makeInput(), CONTEXT),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
  });

  it("denies a historical marker-only key without server-owned enrollment provenance", async () => {
    scriptApiKey(PROTECTED_SCOPE, null, null);

    await expect(
      telemetryStellaIngestHandler(makeInput(), CONTEXT),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
  });

  it("denies when the server-owned enrollment binding differs from the scope marker", async () => {
    scriptApiKey(PROTECTED_SCOPE, "different-server-enrollment");

    await expect(
      telemetryStellaIngestHandler(makeInput(), CONTEXT),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
  });

  it("denies a batch whose enrollment does not match the protected key binding", async () => {
    const input = makeInput();
    const event = input.events.at(0);
    if (!event) throw new Error("test fixture must contain an event");
    event.enrollment_id = "different-enrollment";

    await expect(
      telemetryStellaIngestHandler(input, CONTEXT),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.insertStellaOperationalEvents).not.toHaveBeenCalled();
  });

  it("projects only closed operational fields and omits client tenant labels", async () => {
    await telemetryStellaIngestHandler(makeInput(), CONTEXT);

    expect(mocks.insertStellaOperationalEvents).toHaveBeenCalledWith([
      {
        schema: "stella.operational.v1",
        event_class: "execution_rollup",
        event_id: EVENT_ID,
        enrollment_id: ENROLLMENT_ID,
        provider: "anthropic",
        model: "claude/sonnet",
        outcome: "completed",
        duration_ms: 1234,
        input_tokens: 101,
        output_tokens: 202,
        cost_microusd: 303,
        tool_call_count: 4,
        changed_file_count: 5,
        produced_output: true,
      },
    ]);

    const rows = mocks.insertStellaOperationalEvents.mock.calls[0]?.[0];
    expect(rows?.[0]).not.toHaveProperty("organization_id");
    expect(rows?.[0]).not.toHaveProperty("workspace_id");
  });

  it("awaits the primary ClickHouse write before resolving", async () => {
    let releaseWrite: (() => void) | undefined;
    mocks.insertStellaOperationalEvents.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );

    let isSettled = false;
    const invocation = telemetryStellaIngestHandler(makeInput(), CONTEXT).then(
      (result) => {
        isSettled = true;
        return result;
      },
    );

    await vi.waitFor(() => {
      expect(mocks.insertStellaOperationalEvents).toHaveBeenCalledTimes(1);
    });
    expect(isSettled).toBe(false);

    if (!releaseWrite)
      throw new Error("writer should expose its release callback");
    releaseWrite();
    await expect(invocation).resolves.toEqual({
      accepted: 1,
      event_ids: [EVENT_ID],
    });
  });

  it("logs and propagates primary writer failures", async () => {
    const failure = new Error("clickhouse unavailable");
    mocks.insertStellaOperationalEvents.mockRejectedValueOnce(failure);

    await expect(
      telemetryStellaIngestHandler(makeInput(), CONTEXT),
    ).rejects.toBe(failure);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      {
        err: failure,
        orgId: CONTEXT.orgId,
        workspaceId: CONTEXT.workspaceId,
        accepted: 1,
      },
      "telemetry.stella.ingest: append failed",
    );
  });

  it("returns the exact accepted and event_ids contract shape", async () => {
    const input = makeInput();
    const firstEvent = input.events.at(0);
    if (!firstEvent) throw new Error("test fixture must contain an event");
    input.events.push({ ...firstEvent, event_id: SECOND_EVENT_ID });

    const result = await telemetryStellaIngestHandler(input, CONTEXT);

    expect(result).toEqual({
      accepted: 2,
      event_ids: [EVENT_ID, SECOND_EVENT_ID],
    });
    expect(telemetryStellaIngest.output.parse(result)).toEqual(result);
    expect(result).not.toHaveProperty("inserted");
    expect(result).not.toHaveProperty("duplicate");
  });
});
