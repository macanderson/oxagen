/**
 * graph.telemetry unit tests — the witness for #2615's graph.telemetry.ts slice.
 *
 * `emitGraphDeletionTelemetry` used to hardcode `execution_step_id: null` on
 * every row, exactly like the skill-load producer #2597/#2616 fixed. This
 * asserts the row now carries `ctx.executionStepId` when the caller supplies
 * one (a delete that happened inside a run), and stays truthfully null when
 * the caller does not (a delete with no run behind it) — the same rule
 * #2616 established for `CapabilityContext`, restated here for the local
 * `GraphTelemetryContext` slice.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertToolInvocation: vi.fn(),
}));

mocks.insertToolInvocation.mockResolvedValue(undefined);
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertToolInvocation: mocks.insertToolInvocation,
  };
});

import { emitGraphDeletionTelemetry } from "./graph.telemetry";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertToolInvocation.mockResolvedValue(undefined);
});

describe("emitGraphDeletionTelemetry", () => {
  it("writes the run's executionStepId through into execution_step_id", async () => {
    emitGraphDeletionTelemetry(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        surface: "runner",
        messageId: "msg_1",
        executionStepId: "step-abc",
      },
      { capability: "graph.node.delete", latencyMs: 12, succeeded: true },
    );

    // insertToolInvocation is fired-and-forgotten (void ...catch), so let
    // the microtask queue drain before asserting on the mock.
    await Promise.resolve();

    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const row = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(row.execution_step_id).toBe("step-abc");
  });

  it("records a truthful null when the delete has no run behind it", async () => {
    emitGraphDeletionTelemetry(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        surface: "api",
        messageId: null,
        // executionStepId omitted — a direct API call, no run to attribute to.
      },
      { capability: "graph.edge.delete", latencyMs: 4, succeeded: true },
    );

    await Promise.resolve();

    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const row = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(row.execution_step_id).toBeNull();
  });
});
