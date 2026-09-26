// runs.list sends Fleet's filters, search, order and offset to list_runs and
// maps the total back (#3837). A query that sets none of them sends what it
// sent before they existed. runs.test.ts holds the rest of the runs port.
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
const { readOk } = await import("@/data/read");
const { runs } = await import("./runs");
const { toRunListInput } = await import("./mappers/run-list-input");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("runs.list with the list controls", () => {
  it("sends the filters, the search, the order and the offset", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [], nextCursor: null }));
    await runs.list(ctx, {
      cursor: null,
      limit: 25,
      status: ["live", "halted"],
      tier: ["gateway"],
      replayGrade: ["fork", "not_recorded"],
      query: "  deploy  ",
      sort: { key: "cost", dir: "asc" },
      offset: 50,
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runList,
      input: {
        limit: 25,
        status: ["live", "halted"],
        tier: ["gateway"],
        replayGrade: ["fork", "not_recorded"],
        query: "deploy",
        sort: { key: "cost", dir: "asc" },
        offset: 50,
      },
      page: "fleet",
    });
    // The contract accepts what the adapter sends.
    const sent: unknown = Reflect.get(kernelRead.mock.calls[0]?.[1], "input");
    expect(runList.input.safeParse(sent).success).toBe(true);
  });

  it("leaves out every control at its default", () => {
    expect(
      toRunListInput({
        cursor: null,
        status: [],
        tier: [],
        replayGrade: [],
        query: "   ",
        sort: { key: "started", dir: "desc" },
        offset: 0,
        pullRequests: "any",
      }),
    ).toEqual({ limit: 100 });
  });

  it("asks for the total only when the caller does", () => {
    expect(toRunListInput({ cursor: null, count: true })).toEqual({
      limit: 100,
      count: true,
    });
    expect(toRunListInput({ cursor: null, count: false })).toEqual({
      limit: 100,
    });
  });

  it("keeps an oldest-first order, which is not the default", () => {
    expect(
      toRunListInput({ cursor: null, sort: { key: "started", dir: "asc" } }),
    ).toEqual({ limit: 100, sort: { key: "started", dir: "asc" } });
  });

  it("maps the total and its bound, and null past the bound", async () => {
    kernelRead.mockResolvedValue(
      readOk({ runs: [], nextCursor: null, total: 279, totalBound: 10_000 }),
    );
    const counted = await runs.list(ctx, { cursor: null });
    expect(counted).toEqual(
      readOk({ runs: [], nextCursor: null, total: 279, totalBound: 10_000 }),
    );

    kernelRead.mockResolvedValue(
      readOk({ runs: [], nextCursor: null, total: null, totalBound: 10_000 }),
    );
    const past = await runs.list(ctx, { cursor: null });
    expect(past.ok && past.value.total).toBeNull();
  });

  it("leaves the total out when the read did not count", async () => {
    kernelRead.mockResolvedValue(readOk({ runs: [], nextCursor: null }));
    const read = await runs.list(ctx, { cursor: null, pullRequests: "with" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).not.toHaveProperty("total");
      expect(read.value).not.toHaveProperty("totalBound");
    }
    expect(captureError).not.toHaveBeenCalled();
  });
});
