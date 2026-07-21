import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(
  async (_table: string, _rows: readonly Record<string, unknown>[]) => {},
);

vi.mock("./tenant", () => ({
  chInsert: (table: string, rows: readonly Record<string, unknown>[]) =>
    chInsert(table, rows),
}));

import {
  insertStellaOperationalEvents,
  type StellaOperationalEventRow,
} from "./stella-operational-events";

const RECEIVED_AT = new Date("2026-07-21T18:42:15.123Z");

const row: StellaOperationalEventRow = {
  schema: "stella.operational.v1",
  event_class: "execution_rollup",
  event_id: `evt_${"a".repeat(64)}`,
  enrollment_id: "enrollment-1",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-5",
  outcome: "completed",
  duration_ms: 1_250,
  input_tokens: 1_000,
  output_tokens: 250,
  cost_microusd: 4_200,
  tool_call_count: 3,
  changed_file_count: 2,
  produced_output: true,
};

beforeEach(() => {
  chInsert.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(RECEIVED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("insertStellaOperationalEvents", () => {
  it("projects only the operational allowlist and stamps received_at server-side", async () => {
    const hostileInput = {
      ...row,
      organization_id: "client-org-label",
      workspace_id: "client-workspace-label",
      org_id: "forged-org-id",
      received_at: "1999-01-01T00:00:00.000Z",
      payload_json: '{"prompt":"secret"}',
    } as unknown as StellaOperationalEventRow;

    await insertStellaOperationalEvents([hostileInput]);

    expect(chInsert).toHaveBeenCalledOnce();
    expect(chInsert).toHaveBeenCalledWith("stella_operational_events", [
      {
        ...row,
        received_at: RECEIVED_AT.toISOString(),
      },
    ]);
    const inserted = chInsert.mock.calls[0]?.[1]?.[0];
    expect(inserted).not.toHaveProperty("organization_id");
    expect(inserted).not.toHaveProperty("workspace_id");
    expect(inserted).not.toHaveProperty("org_id");
    expect(inserted).not.toHaveProperty("payload_json");
  });

  it("awaits and propagates a primary ClickHouse write failure", async () => {
    const failure = new Error("ClickHouse unavailable");
    chInsert.mockRejectedValueOnce(failure);

    await expect(insertStellaOperationalEvents([row])).rejects.toBe(failure);
  });
});
