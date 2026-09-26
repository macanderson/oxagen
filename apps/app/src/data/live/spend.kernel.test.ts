// The budgets read through the real kernel seam, with the kernel's invoke()
// faked: a get_spend_budget whose spend read failed throws (#3064), and the
// port answers the spend page's error row, which the Budgets tab renders as
// its error state (spend.test.tsx), never as a ceiling with nothing spent.
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, captureError } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  captureError: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError } = await import("@/data/read");
const { spend } = await import("./spend");

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
  invoke.mockReset();
  captureError.mockReset();
});

describe("spend.budgets through the kernel seam", () => {
  it("answers the spend error row when the handler's spend read fails (negative, #3064)", async () => {
    invoke.mockRejectedValue(new Error("counter down"));
    const read = await spend.budgets(ctx);
    // The seam records the failure's facts beside it (#3841): no tracer runs
    // and no region is set here, so both read null, and the request id is the
    // one the seam sent.
    expect(read).toEqual(
      readError("rollup_rebuild_in_progress", 504, {
        traceId: null,
        region: null,
        requestId: invoke.mock.calls[0]?.[2].requestId ?? "",
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      billingBudgetGet.name,
      {},
      expect.objectContaining({ workspaceId: ctx.workspaceId }),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
