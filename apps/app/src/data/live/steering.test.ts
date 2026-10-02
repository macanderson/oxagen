// The steering port: kernel reads on the workspace ctx, each mapped into its
// view model, with a refusal passed through and an unmappable record reported
// once.
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { contextSteeringDeliveries } from "@oxagen/oxagen/contracts/context.steering.deliveries";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextPrOutput,
  LINEAGE,
  proposalOutput,
  RECORD_PATH,
  recordGetOutput,
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
  wsRole: "member",
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

describe("steering.record", () => {
  it("reads the record the lineage names and maps it", async () => {
    kernelRead.mockResolvedValue(readOk(recordGetOutput()));
    const read = await steering.record(ctx, "ctx.release.no-reread-changelog");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextRecordsGet,
      input: { recordId: "ctx.release.no-reread-changelog" },
      page: "steering",
    });
    expect(read.ok && read.value.provenance?.commit).toContain("4d5e6f7a8b9c");
    expect(read.ok && read.value.effect).toEqual({ rendered: 214, cited: 37 });
  });

  // DoD 4: the file is the backing, and a record the mirror has no row for
  // still reads. Deleting the row leaves `id` null and changes nothing else.
  it("reads a record the registry holds no row for", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        recordGetOutput({
          record: { ...recordOutput(), id: null, updatedAt: null },
        }),
      ),
    );
    const read = await steering.record(ctx, "ctx.release.no-reread-changelog");
    expect(read.ok && read.value.record.id).toBeNull();
    expect(read.ok && read.value.record.statement).toContain("CHANGELOG.md");
  });

  // An appended record carries a lineage too, and is not in force. Answering
  // this route with one would show an unpublished sentence as a governed rule.
  it("answers not-found for an appended record (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ source: "appended", record: {}, provenance: {} }),
    );
    expect(await steering.record(ctx, "ctx.appended.thing")).toEqual(
      readError("not_found", 404),
    );
  });

  it("passes a denial through without mapping (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await steering.record(ctx, "ctx.anything")).toEqual(DENIED);
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk(recordGetOutput({ record: { ...recordOutput(), lineageId: "" } })),
    );
    expect(await steering.record(ctx, "ctx.anything")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      orgId: ctx.orgId,
      context: "steering.record record_unmappable",
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

  // #4693: Rows per page under the Proposals list sets the page size.
  it("reads the page size the caller names", async () => {
    kernelRead.mockResolvedValue(readOk({ proposals: [], total: 0 }));
    await steering.proposals(ctx, { offset: 20, limit: 10 });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextProposalList,
      input: { limit: 10, offset: 20 },
      page: "steering",
    });
  });

  it("passes an error through (negative)", async () => {
    const down = readError("record_index_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await steering.proposals(ctx, { offset: 0 })).toEqual(down);
    expect(captureError).not.toHaveBeenCalled();
  });

  // #3395: the record page asks whether a change is already open on ONE
  // lineage. Without the filter it would have to guess from the first page of
  // every proposal in the workspace.
  it("narrows to one lineage when the caller names one", async () => {
    kernelRead.mockResolvedValue(readOk({ proposals: [], total: 0 }));
    await steering.proposals(ctx, { offset: 0, lineage: "ctx.a.b" });
    expect(kernelRead.mock.calls[0]?.[1]).toMatchObject({
      input: { limit: 50, offset: 0, lineageId: "ctx.a.b" },
    });
  });

  it("sends no lineage when the caller names none", async () => {
    kernelRead.mockResolvedValue(readOk({ proposals: [], total: 0 }));
    await steering.proposals(ctx, { offset: 0 });
    // Asserted whole rather than field by field: an exact input is the only
    // way to say `lineageId` was not sent, rather than merely not checked.
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextProposalList,
      input: { limit: 50, offset: 0 },
      page: "steering",
    });
  });

  it("narrows to one state when the Proposals filter names one", async () => {
    kernelRead.mockResolvedValue(readOk({ proposals: [], total: 0 }));
    await steering.proposals(ctx, { offset: 0, limit: 25, state: "merged" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextProposalList,
      input: { limit: 25, offset: 0, state: "merged" },
      page: "steering",
    });
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

describe("steering.deliveries", () => {
  it("reads recent manifest counts and validates the result", async () => {
    const value = { runs: [], undelivered: [], scanned: 0, truncated: false };
    kernelRead.mockResolvedValue(readOk(value));
    expect(await steering.deliveries(ctx)).toEqual(readOk(value));
    expect(kernelRead).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        contract: contextSteeringDeliveries,
        input: { days: 7, limit: 50 },
        page: "steering",
      }),
    );
  });
  it("carries a cut record's manifest id as a ref, not a public id", async () => {
    const row = { runs: 3, lastReason: "budget", lastSeen: "2026-09-22" };
    kernelRead.mockResolvedValue(
      readOk({
        runs: [],
        undelivered: [{ recordId: "ctx.release", ...row }],
        scanned: 3,
        truncated: false,
      }),
    );
    expect(await steering.deliveries(ctx)).toEqual(
      readOk({
        runs: [],
        undelivered: [{ recordRef: "ctx.release", ...row }],
        scanned: 3,
        truncated: false,
      }),
    );
  });
  it("preserves a refusal and reports malformed output", async () => {
    const refused = {
      ok: false,
      reason: "denied",
      permission: "steering.read",
    } as const;
    kernelRead.mockResolvedValueOnce(refused);
    expect(await steering.deliveries(ctx)).toEqual(refused);
    kernelRead.mockResolvedValueOnce(readOk({ scanned: -1 }));
    expect(await steering.deliveries(ctx)).toMatchObject({
      ok: false,
      reason: "error",
      code: "record_unmappable",
    });
  });
});

describe("steering.freshness", () => {
  const AT = "2026-09-28T14:02:00Z";
  const HEAD = "4d5e6f7a8b9c";

  it("reads the workspace's freshness and renames it for the panel", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        steeringVersion: 12,
        headCommit: HEAD,
        headCommits: [HEAD],
        publishedAt: AT,
        repository: "acme/platform",
        provider: "github",
        defaultBranch: "main",
        policy: { autoSync: true, blockStaleRuns: false },
        sync: {
          status: "problems",
          headSha: HEAD,
          requestedAt: AT,
          syncedAt: AT,
          error: null,
          findings: [
            {
              level: "warning",
              path: RECORD_PATH,
              lineageId: LINEAGE,
              code: "unknown_key",
              message: "The record names a key the schema does not know.",
            },
          ],
        },
      }),
    );
    const read = await steering.freshness(ctx);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: contextSteeringFreshness,
      input: {},
      page: "steering",
    });
    expect(read).toEqual(
      readOk({
        version: 12,
        headCommit: HEAD,
        publishedAt: AT,
        repository: "acme/platform",
        defaultBranch: "main",
        gates: { autoSync: true, blockStaleRuns: false },
        sync: {
          status: "problems",
          headSha: HEAD,
          syncedAt: AT,
          error: null,
          findings: [
            {
              level: "warning",
              path: RECORD_PATH,
              lineage: LINEAGE,
              message: "The record names a key the schema does not know.",
            },
          ],
        },
      }),
    );
  });

  it("passes a denial through without mapping (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await steering.freshness(ctx)).toEqual(DENIED);
    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("steering.hub", () => {
  const MAIN = {
    bindingId: "rpb_0a1b2c",
    role: "main",
    fullName: "acme/platform",
  };
  /** Answers each contract the hub reads with what the case hands it. */
  function answer(
    by: Partial<
      Record<"repos" | "tree" | "open" | "merged" | "closed", unknown>
    >,
  ) {
    const route = (call: {
      contract: unknown;
      input: { state?: string };
    }): unknown => {
      if (call.contract === repositoryList)
        return by.repos ?? readOk({ repositories: [MAIN] });
      if (call.contract === repositoryTreeGet)
        return (
          by.tree ??
          readOk({
            fullName: "acme/platform",
            governancePath: ".oxagen/rules/governance.toml",
            governanceMode: "regulated",
          })
        );
      if (call.contract === contextProposalList) {
        const key = call.input.state;
        const totals: Record<string, number> = {
          open: 9,
          merged: 4,
          closed: 2,
        };
        if (key === undefined) throw new Error("the hub counts by state");
        return (
          (isStateKey(key) ? by[key] : undefined) ??
          readOk({ proposals: [], total: totals[key] })
        );
      }
      throw new Error("not a hub read");
    };
    // A throw inside the executor rejects, as the kernel's refusal would.
    kernelRead.mockImplementation(
      (
        _ctx: unknown,
        call: { contract: unknown; input: { state?: string } },
      ) =>
        new Promise((resolve) => {
          resolve(route(call));
        }),
    );
  }
  const isStateKey = (key: string): key is "open" | "merged" | "closed" =>
    key === "open" || key === "merged" || key === "closed";

  it("reads governance.toml off the main repository and counts the proposals in each state", async () => {
    answer({});
    const read = await steering.hub(ctx);
    expect(read).toEqual(
      readOk({
        governance: {
          state: "read",
          repository: "acme/platform",
          path: ".oxagen/rules/governance.toml",
          mode: "regulated",
        },
        proposalsWaiting: 9,
        states: { open: 9, merged: 4, closed: 2 },
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: repositoryTreeGet,
      input: { bindingId: "rpb_0a1b2c" },
      page: "steering",
    });
    for (const state of ["open", "merged", "closed"]) {
      expect(kernelRead).toHaveBeenCalledWith(ctx, {
        contract: contextProposalList,
        input: { limit: 1, offset: 0, state },
        page: "steering",
      });
    }
  });

  it("says unbound when no repository is the main one, and reads no tree", async () => {
    answer({
      repos: readOk({ repositories: [{ ...MAIN, role: "linked" }] }),
    });
    const read = await steering.hub(ctx);
    expect(read.ok && read.value.governance).toEqual({ state: "unbound" });
    expect(
      kernelRead.mock.calls.some((call: unknown[]) => {
        const arg = call[1];
        return (
          typeof arg === "object" &&
          arg !== null &&
          "contract" in arg &&
          arg.contract === repositoryTreeGet
        );
      }),
    ).toBe(false);
  });

  it("says unread with the code when GitHub refuses the tree (negative)", async () => {
    answer({ tree: readError("github_not_connected", 409) });
    const read = await steering.hub(ctx);
    expect(read.ok && read.value.governance).toEqual({
      state: "unread",
      code: "github_not_connected",
    });
  });

  it("says unread on a denied repository list (negative)", async () => {
    answer({ repos: DENIED });
    const read = await steering.hub(ctx);
    expect(read.ok && read.value.governance).toEqual({
      state: "unread",
      code: "denied",
    });
  });

  it("prints no waiting count and no filter counts when the open count fails (negative)", async () => {
    answer({ open: readError("record_index_unavailable", 503) });
    const read = await steering.hub(ctx);
    expect(read.ok && read.value.proposalsWaiting).toBeNull();
    expect(read.ok && read.value.states).toBeNull();
  });

  it("prints no filter counts when the closed count fails, and keeps the waiting count (negative)", async () => {
    answer({ closed: readError("record_index_unavailable", 503) });
    const read = await steering.hub(ctx);
    expect(read.ok && read.value.states).toBeNull();
    expect(read.ok && read.value.proposalsWaiting).toBe(9);
  });
});
