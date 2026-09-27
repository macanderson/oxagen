// The interjections port (#3839, #3941): list_interjections with `open: true`
// through the kernel seam for the workspace (Fleet, the shell) or one run,
// walked to the end of its cursor under a bound, and with `open: false` for
// the Run page's one run, answered questions included. A refusal is passed
// through and an unmappable record reported once.
import { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
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
const { interjections } = await import("./interjections");

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

const item = {
  id: "inj_q8t1",
  runId: "tse_7k2m9q",
  agentKey: "acme.core.release-bot",
  question: "Which branch should the release cut from?",
  raisedAt: "2026-09-25T09:00:00.000Z",
  expiresAt: "2026-09-25T09:30:00.000Z",
  answeredAt: null,
  answer: null,
  answeredBy: null,
  kind: "question",
  raisedSeq: null,
  body: null,
  repository: null,
  path: null,
  receiptId: null,
};

const mapped = {
  id: "inj_q8t1",
  runId: "tse_7k2m9q",
  agentKey: "acme.core.release-bot",
  question: "Which branch should the release cut from?",
  raisedAt: "2026-09-25T09:00:00.000Z",
  expiresAt: "2026-09-25T09:30:00.000Z",
  answeredAt: null,
  answer: null,
  answeredBy: null,
  kind: "question",
  raisedSeq: null,
  body: null,
  repository: null,
  path: null,
  receiptId: null,
};

/** The same question answered, as `open: false` returns it. */
const answered = {
  ...item,
  answeredAt: "2026-09-25T09:04:00.000Z",
  answer: "main",
  answeredBy: "usr_marcusbell",
  receiptId: "rcp_01k6qw44",
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("interjections.open", () => {
  it("reads the workspace's open questions for Fleet", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [item], nextCursor: null }));
    expect(await interjections.open(ctx, { runId: null })).toEqual(
      readOk({ items: [mapped], more: false }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentInterjectionList,
      input: { open: true, limit: 100 },
      page: "fleet",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("narrows to one run for the Run page", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [], nextCursor: null }));
    await interjections.open(ctx, { runId: "tse_7k2m9q" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentInterjectionList,
      input: { runId: "tse_7k2m9q", open: true, limit: 100 },
      page: "run",
    });
  });

  it("walks every page the queue hands back into one list", async () => {
    kernelRead
      .mockResolvedValueOnce(readOk({ items: [item], nextCursor: "c2" }))
      .mockResolvedValueOnce(
        readOk({ items: [{ ...item, id: "inj_next" }], nextCursor: null }),
      );
    const out = await interjections.open(ctx, { runId: null });
    expect(out.ok && out.value.items.map((i) => i.id)).toEqual([
      "inj_q8t1",
      "inj_next",
    ]);
    expect(out.ok && out.value.more).toBe(false);
    expect(kernelRead).toHaveBeenNthCalledWith(2, ctx, {
      contract: agentInterjectionList,
      input: { open: true, limit: 100, cursor: "c2" },
      page: "fleet",
    });
  });

  it("stops at the page bound and says the count is short of the queue (negative)", async () => {
    kernelRead.mockImplementation(() =>
      Promise.resolve(readOk({ items: [item], nextCursor: "more" })),
    );
    const out = await interjections.open(ctx, { runId: null });
    expect(kernelRead).toHaveBeenCalledTimes(10);
    expect(out.ok && out.value.items).toHaveLength(10);
    expect(out.ok && out.value.more).toBe(true);
  });

  it("passes a refusal through without paging further (negative)", async () => {
    const denied = {
      ok: false as const,
      reason: "denied" as const,
      permission: "workspace.read",
    };
    kernelRead.mockResolvedValue(denied);
    expect(await interjections.open(ctx, { runId: null })).toEqual(denied);
    expect(kernelRead).toHaveBeenCalledOnce();
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [{ ...item, question: "" }], nextCursor: null }),
    );
    expect(await interjections.open(ctx, { runId: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("interjections.forRun", () => {
  it("reads one run's questions, answered or not, for the Run page", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [answered], nextCursor: null }),
    );
    expect(await interjections.forRun(ctx, "tse_7k2m9q")).toEqual(
      readOk({
        items: [
          {
            ...mapped,
            answeredAt: "2026-09-25T09:04:00.000Z",
            answer: "main",
            answeredBy: "usr_marcusbell",
            receiptId: "rcp_01k6qw44",
          },
        ],
        more: false,
      }),
    );
    expect(kernelRead).toHaveBeenCalledOnce();
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentInterjectionList,
      input: { runId: "tse_7k2m9q", open: false, limit: 100 },
      page: "run",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reads one page and says when the run holds more questions than it took", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [item], nextCursor: "c2" }));
    const out = await interjections.forRun(ctx, "tse_7k2m9q");
    expect(out.ok && out.value.more).toBe(true);
    expect(kernelRead).toHaveBeenCalledOnce();
  });

  it("passes a refusal through (negative)", async () => {
    const denied = {
      ok: false as const,
      reason: "denied" as const,
      permission: "run.read",
    };
    kernelRead.mockResolvedValue(denied);
    expect(await interjections.forRun(ctx, "tse_7k2m9q")).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        items: [{ ...answered, answeredBy: "7c9e6679-7425" }],
        nextCursor: null,
      }),
    );
    expect(await interjections.forRun(ctx, "tse_7k2m9q")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "interjections.forRun record_unmappable",
      }),
    );
  });
});
