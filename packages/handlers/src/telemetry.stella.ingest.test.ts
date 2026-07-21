import type { CapabilityContext } from "@oxagen/oxagen";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertStellaOperationalEvents: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...original,
    insertStellaOperationalEvents: mocks.insertStellaOperationalEvents,
  };
});

vi.mock("./logger", () => ({
  logger: { error: mocks.loggerError },
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

const makeInput = () =>
  telemetryStellaIngest.input.parse({
    schema: "stella.operational.batch.v1",
    events: [
      {
        schema: "stella.operational.v1",
        event_class: "execution_rollup",
        event_id: EVENT_ID,
        enrollment_id: "enrollment-1",
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
});

describe("telemetryStellaIngestHandler", () => {
  it("projects only closed operational fields and omits client tenant labels", async () => {
    await telemetryStellaIngestHandler(makeInput(), CONTEXT);

    expect(mocks.insertStellaOperationalEvents).toHaveBeenCalledWith([
      {
        schema: "stella.operational.v1",
        event_class: "execution_rollup",
        event_id: EVENT_ID,
        enrollment_id: "enrollment-1",
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

    await Promise.resolve();
    expect(isSettled).toBe(false);

    releaseWrite?.();
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
