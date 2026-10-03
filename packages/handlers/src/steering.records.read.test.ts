import { describe, expect, it, vi } from "vitest";
import { steeringRecordsGet } from "@oxagen/oxagen/contracts/steering.records.get";
import { steeringRecordsList } from "@oxagen/oxagen/contracts/steering.records.list";

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async () => "Member",
}));

import { createAppendRecordHandler } from "./steering.records.append";
import { createGetRecordHandler } from "./steering.records.get";
import { createListRecordsHandler } from "./steering.records.list";
import { createOpenSteeringPrHandler } from "./steering.pr.open";
import { createMergeSteeringPrHandler } from "./steering.pr.merge";
import { createProposeRecordHandler } from "./steering.proposal.create";
import {
  REVIEWER,
  SCOPE,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

async function publish(
  h: Harness,
  lineageId: string,
  kind: "rule" | "constraint" | "fact",
  effect?: "require" | "forbid",
) {
  const { proposalId } = await createProposeRecordHandler(h)(
    {
      record: {
        lineageId,
        kind,
        force: kind === "constraint" ? "must" : "should",
        ...(effect ? { constraintEffect: effect } : {}),
        sharingScope: "workspace",
        statement: `About ${lineageId}.`,
      },
      rationale: "because",
      support: { runs: [], agents: [], recordIds: [], evidenceLinks: [] },
    },
    ctx(),
  );
  await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
  await createMergeSteeringPrHandler(h)(
    { proposalId },
    ctx({ userId: REVIEWER }),
  );
  return proposalId;
}

describe("list_records", () => {
  it("lists the published registry with its classification, filtered by kind, scope, status and lineage", async () => {
    const h = harness();
    await publish(h, "ctx.a.rule", "rule");
    await publish(h, "ctx.a.forbid", "constraint", "forbid");
    // A record published through publish_steering_record carries no commit or
    // path — that path writes no PR, so nothing merges it — but it always
    // carries a real classification now (#3302): the contract requires
    // kind and force on every call, even though the DB-level NOT NULL is a
    // deliberate follow-up migration (see `20260920150000`'s comment).
    h.store.records.push({
      ...h.store.records[0]!,
      id: "direct-publish",
      publicId: "ctr_directpublish00000000000",
      slug: "ctx.direct-publish",
      kind: "memory",
      force: "info",
      constraintEffect: null,
      statement: "Published directly, outside a steering PR.",
      commitSha: null,
      path: null,
      publishedAt: null,
    });
    const list = createListRecordsHandler(h);
    const all = await list(steeringRecordsList.input.parse({}), ctx());
    expect(all.total).toBe(3);
    expect(all.records.find((r) => r.lineageId === "ctx.a.rule")?.label).toBe(
      "Rule",
    );
    expect(() => steeringRecordsList.output.parse(all)).not.toThrow();
    const directPublish = all.records.find(
      (r) => r.lineageId === "ctx.direct-publish",
    )!;
    expect(directPublish).toMatchObject({
      kind: "memory",
      force: "info",
      commit: null,
      path: null,
      publishedAt: null,
    });
    const constraints = await list(
      steeringRecordsList.input.parse({ kind: "constraint" }),
      ctx(),
    );
    expect(
      constraints.records.map((r) => [r.lineageId, r.constraintEffect]),
    ).toEqual([["ctx.a.forbid", "forbid"]]);
    const one = await list(
      steeringRecordsList.input.parse({ lineageId: "ctx.a.rule" }),
      ctx(),
    );
    expect(one.total).toBe(1);
    expect(one.records[0]).toMatchObject({
      kind: "rule",
      force: "should",
      status: "active",
      version: 1,
      path: ".oxagen/rules/ctx.a.rule.toml",
    });
    const other = await list(
      steeringRecordsList.input.parse({}),
      ctx({ workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e02" }),
    );
    expect(other).toEqual({ records: [], total: 0 });
  });

  // #4572 item 1: a record carried no price, so the card could not show one.
  // list_mcp_servers prices a provider's 5,200 tokens at 48,000 micros per
  // 1,000 as 249,600 micros (agent.mcp.list.test.ts). A record of the same
  // size costs the same.
  describe("the weekly price", () => {
    const PRICE = {
      perThousandMicros: 48_000n,
      currency: "USD",
      requests: 400,
      since: new Date("2026-09-20T00:00:00Z"),
    };

    /** A record whose line is 20,800 bytes: 5,200 tokens. */
    async function withLargeRecord() {
      const h = harness();
      await publish(h, "ctx.a.rule", "rule");
      h.store.records.push({
        ...h.store.records[0]!,
        id: "large",
        publicId: "ctr_large000000000000000000",
        slug: "ctx.big",
        kind: "memory",
        force: "info",
        constraintEffect: null,
        // `- ` and ` (memory; ctx.big)` add 20 bytes.
        statement: "a".repeat(20_780),
      });
      return h;
    }

    it("prices each record's line at the workspace's weekly price, as list_mcp_servers prices a provider", async () => {
      const h = await withLargeRecord();
      const weeklyPrice = vi.fn(async () => PRICE);
      const list = createListRecordsHandler({ ...h, weeklyPrice });
      const out = await list(steeringRecordsList.input.parse({}), ctx());
      expect(weeklyPrice).toHaveBeenCalledOnce();
      expect(weeklyPrice).toHaveBeenCalledWith({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
      });
      const big = out.records.find((r) => r.lineageId === "ctx.big");
      expect(big).toMatchObject({
        contextTokens: 5_200,
        weeklyPrice: { micros: "249600", currency: "USD", basis: "estimated" },
      });
      // `- About ctx.a.rule. (rule; ctx.a.rule)` is 38 bytes: 10 tokens.
      const rule = out.records.find((r) => r.lineageId === "ctx.a.rule");
      expect(rule).toMatchObject({
        contextTokens: 10,
        weeklyPrice: { micros: "480", currency: "USD", basis: "estimated" },
      });
      expect(() => steeringRecordsList.output.parse(out)).not.toThrow();
    });

    it("leaves a record the assembler drops with no tokens and no price (negative)", async () => {
      const h = await withLargeRecord();
      h.store.records.push({
        ...h.store.records[0]!,
        id: "unclassified",
        publicId: "ctr_unclassified000000000000",
        slug: "ctx.unclassified",
        // The column is NOT NULL since 20261004000000, so a record the
        // assembler drops is one with no statement.
        statement: null,
      });
      const weeklyPrice = async () => PRICE;
      const list = createListRecordsHandler({ ...h, weeklyPrice });
      const out = await list(steeringRecordsList.input.parse({}), ctx());
      const dropped = out.records.find(
        (r) => r.lineageId === "ctx.unclassified",
      );
      expect(dropped).toMatchObject({ contextTokens: null, weeklyPrice: null });
    });

    it("lists every record with its tokens and no price when the week has none or the read fails (negative)", async () => {
      const h = await withLargeRecord();
      for (const weeklyPrice of [
        async () => null,
        async () => {
          throw new Error("price book down");
        },
      ]) {
        const list = createListRecordsHandler({ ...h, weeklyPrice });
        const out = await list(steeringRecordsList.input.parse({}), ctx());
        expect(out.total).toBe(2);
        const rows = out.records.map((r) => [
          r.lineageId,
          r.contextTokens,
          r.weeklyPrice,
        ]);
        expect(rows).toEqual([
          ["ctx.a.rule", 10, null],
          ["ctx.big", 5_200, null],
        ]);
      }
    });
  });
});

describe("get_record", () => {
  it("answers a published record by id or lineage with its versions and the PR that published it", async () => {
    const h = harness();
    const proposalId = await publish(h, "ctx.a.rule", "rule");
    const get = createGetRecordHandler(h);
    const byLineage = await get({ recordId: "ctx.a.rule" }, ctx());
    expect(byLineage.source).toBe("published");
    if (byLineage.source !== "published") throw new Error("published");
    expect(byLineage.record.lineageId).toBe("ctx.a.rule");
    expect(byLineage.versions).toEqual([
      expect.objectContaining({ version: 1, isLatest: true }),
    ]);
    expect(byLineage.proposalId).toBe(proposalId);
    expect(byLineage.prUrl).toBe(
      "https://github.com/a-intel/platform/pull/519",
    );
    expect(byLineage.record.id).not.toBeNull();
    const byId = await get({ recordId: byLineage.record.id ?? "" }, ctx());
    expect(byId).toEqual(byLineage);
    expect(() => steeringRecordsGet.output.parse(byId)).not.toThrow();
  });

  it("answers an appended record by cta_ id with its provenance and proposal, and 404s the rest", async () => {
    const h = harness();
    const appended = await createAppendRecordHandler(h)(
      {
        kind: "record_proposal",
        lineageId: "ctx.triage.reproduce-first",
        statement: "Reproduce before labelling.",
        sharingScope: "workspace",
        sourceRefs: ["frame:run_1/3"],
        evidenceLinks: [],
        proposal: { kind: "rule", force: "should", rationale: "why" },
      },
      ctx(),
    );
    const out = await createGetRecordHandler(h)(
      { recordId: appended.recordId },
      ctx(),
    );
    expect(out).toEqual({
      source: "appended",
      record: expect.objectContaining({
        id: appended.recordId,
        kind: "record_proposal",
        recordHash: appended.recordHash,
        sourceRefs: ["frame:run_1/3"],
        proposalId: appended.proposalId,
      }),
    });
    expect(() => steeringRecordsGet.output.parse(out)).not.toThrow();
    await expect(
      createGetRecordHandler(h)({ recordId: "cta_nope" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createGetRecordHandler(h)({ recordId: "ctx.nope" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createGetRecordHandler(h)(
        { recordId: appended.recordId },
        ctx({ workspaceId: `${SCOPE.workspaceId.slice(0, -1)}9` }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
