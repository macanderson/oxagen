// The runs port: one list_runs page through the kernel seam at the asked
// cursor, mapped into the Fleet view, with a refusal passed through and an
// unmappable record reported once.
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { runs } = await import("./runs");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
});

const run = {
  id: "tse_4f0a",
  source: "tacho",
  agentKey: null,
  operatorId: null,
  status: "live",
  turns: null,
  steps: 3,
  frames: 9,
  cost: null,
  taskRef: null,
  startedAt: "2026-09-15T08:55:00.000Z",
  sealedAt: null,
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("runs.list", () => {
  it("reads the newest page with no cursor and maps it", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [run], nextCursor: "c2" }));
    const read = await runs.list(ctx, { cursor: null });
    expect(read).toEqual(
      readOk({
        runs: [
          {
            id: "tse_4f0a",
            source: "tacho",
            agentKey: null,
            operatorId: null,
            status: "live",
            frames: 9,
            cost: null,
            taskRef: null,
            startedAt: "2026-09-15T08:55:00.000Z",
          },
        ],
        nextCursor: "c2",
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runList,
      input: {},
      page: "fleet",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes the cursor of a later page to list_runs", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [], nextCursor: null }));
    await runs.list(ctx, { cursor: "c2" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runList,
      input: { cursor: "c2" },
      page: "fleet",
    });
  });

  it("passes a refused read through (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "workspace.read",
    };
    kernelRead.mockResolvedValue(denied);
    expect(await runs.list(ctx, { cursor: null })).toEqual(denied);
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ runs: [{ ...run, id: "not-a-public-id" }], nextCursor: null }),
    );
    expect(await runs.list(ctx, { cursor: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
