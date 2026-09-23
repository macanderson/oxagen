import { describe, expect, it, vi } from "vitest";
import { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async () => "Member",
}));

import { createAppendRecordHandler } from "./context.records.append";
import { createGetRecordHandler } from "./context.records.get";
import { createListRecordsHandler } from "./context.records.list";
import { createOpenContextPrHandler } from "./context.pr.open";
import { createMergeContextPrHandler } from "./context.pr.merge";
import { createProposeRecordHandler } from "./context.proposal.create";
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
  await createOpenContextPrHandler(h)({ proposalId }, ctx());
  await createMergeContextPrHandler(h)(
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
    // A record published through publish_context_record carries no commit or
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
      statement: "Published directly, outside a Context PR.",
      commitSha: null,
      path: null,
      publishedAt: null,
    });
    const list = createListRecordsHandler(h);
    const all = await list(contextRecordsList.input.parse({}), ctx());
    expect(all.total).toBe(3);
    expect(all.records.find((r) => r.lineageId === "ctx.a.rule")?.label).toBe(
      "Ctx A Rule",
    );
    expect(() => contextRecordsList.output.parse(all)).not.toThrow();
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
      contextRecordsList.input.parse({ kind: "constraint" }),
      ctx(),
    );
    expect(
      constraints.records.map((r) => [r.lineageId, r.constraintEffect]),
    ).toEqual([["ctx.a.forbid", "forbid"]]);
    const one = await list(
      contextRecordsList.input.parse({ lineageId: "ctx.a.rule" }),
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
      contextRecordsList.input.parse({}),
      ctx({ workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e02" }),
    );
    expect(other).toEqual({ records: [], total: 0 });
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
    expect(() => contextRecordsGet.output.parse(byId)).not.toThrow();
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
    expect(() => contextRecordsGet.output.parse(out)).not.toThrow();
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
