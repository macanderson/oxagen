// The steering port: three kernel reads on the workspace ctx, each mapped into
// its view model, with a refusal passed through and an unmappable record
// reported once.
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextPrOutput,
  proposalOutput,
  recordOutput,
  recordsOutput,
} from "@/test/steering-outputs";

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
const { steering } = await import("./steering");

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

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "steering.read",
} as const;

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("steering.records", () => {
  it("reads one page of the records in force, of every kind, and maps them", async () => {
    kernelRead.mockResolvedValue(readOk(recordsOutput(undefined, 1)));
    const read = await steering.records(ctx, { kind: null, offset: 0 });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextRecordsList,
      input: { status: "active", limit: 50, offset: 0 },
      page: "steering",
    });
    expect(read.ok && read.value.records.map((r) => r.id)).toEqual([
      "ctr_7k2m9q4x8r1t5v3w6y0z2a",
    ]);
  });

  it("asks for the kind and the offset the page names", async () => {
    kernelRead.mockResolvedValue(readOk(recordsOutput([], 60)));
    const read = await steering.records(ctx, { kind: "rule", offset: 50 });
    expect(kernelRead.mock.calls[0]?.[1]).toMatchObject({
      input: { status: "active", limit: 50, offset: 50, kind: "rule" },
    });
    expect(read).toEqual(readOk({ records: [], total: 60 }));
  });

  it("passes a denial through without mapping (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await steering.records(ctx, { kind: null, offset: 0 })).toEqual(
      DENIED,
    );
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk(recordsOutput([recordOutput({ id: "ctr_" })])),
    );
    expect(await steering.records(ctx, { kind: null, offset: 0 })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      orgId: ctx.orgId,
      context: "steering.records record_unmappable",
    });
  });
});

describe("steering.proposals", () => {
  it("reads one page of proposals and maps them", async () => {
    kernelRead.mockResolvedValue(
      readOk({ proposals: [proposalOutput()], total: 1 }),
    );
    const read = await steering.proposals(ctx, { offset: 100 });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextProposalList,
      input: { limit: 50, offset: 100 },
      page: "steering",
    });
    expect(read.ok && read.value.proposals[0]?.status).toBe("checks_passed");
  });

  it("passes an error through (negative)", async () => {
    const down = readError("record_index_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await steering.proposals(ctx, { offset: 0 })).toEqual(down);
    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("steering.contextPr", () => {
  it("reads one proposal's Context PR", async () => {
    kernelRead.mockResolvedValue(readOk(contextPrOutput()));
    const read = await steering.contextPr(ctx, "prp_01k5ru4a");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextPrGet,
      input: { proposalId: "prp_01k5ru4a" },
      page: "steering",
    });
    expect(read.ok && read.value.onMerge.bundleVersion).toEqual({
      current: 41,
      afterMerge: 42,
    });
  });

  it("passes a missing proposal through as its 404 (negative)", async () => {
    const missing = readError("not_found", 404);
    kernelRead.mockResolvedValue(missing);
    expect(await steering.contextPr(ctx, "prp_missing")).toEqual(missing);
  });
});
