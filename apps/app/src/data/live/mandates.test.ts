// The mandates port: one kernel read on the workspace ctx, narrowed to an
// agent when the caller names one, mapped into the view model, with a refusal
// passed through and an unmappable record reported once.
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorityOutput,
  MANDATE_ID,
  mandateListOutput,
  mandateOutput,
} from "@/test/mandate-outputs";

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
const { mandates } = await import("./mandates");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "billing",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("mandates.list", () => {
  it("reads the workspace's mandates and maps them", async () => {
    kernelRead.mockResolvedValue(readOk(mandateListOutput()));
    const read = await mandates.list(ctx, { agentId: null });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: mandateList,
      input: { limit: 100 },
      page: "mandates",
    });
    expect(read.ok && read.value.mandates.map((m) => m.id)).toEqual([
      MANDATE_ID,
    ]);
  });

  it("narrows the read to one agent when the caller names one", async () => {
    kernelRead.mockResolvedValue(readOk(mandateListOutput([])));
    await mandates.list(ctx, { agentId: "agt_invoicebot" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: mandateList,
      input: { agentId: "agt_invoicebot", limit: 100 },
      page: "mandates",
    });
  });

  it("asks for the contract's largest page, since it takes no cursor", async () => {
    kernelRead.mockResolvedValue(readOk(mandateListOutput([])));
    await mandates.list(ctx, { agentId: null });
    // 100 is the contract's maximum; asking for more is refused at the input.
    expect(mandateList.input.safeParse({ limit: 100 }).success).toBe(true);
    expect(mandateList.input.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("passes a denial through as the mandate ledger's own refusal (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "org.billing",
    } as const;
    kernelRead.mockResolvedValue(denied);
    expect(await mandates.list(ctx, { agentId: null })).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports a record the view model refuses once, and reads no further (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        mandateListOutput([
          mandateOutput({
            authority: [authorityOutput({ measure: "" })],
          }),
        ]),
      ),
    );
    const read = await mandates.list(ctx, { agentId: null });
    expect(read).toEqual({
      ok: false,
      reason: "error",
      code: "record_unmappable",
      status: 502,
    });
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      source: "app",
      orgId: ctx.orgId,
      context: "mandates.list record_unmappable",
    });
  });
});
