import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  assertOrgRole: async () => {
    if (gate.refuse)
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Member";
  },
}));

import { createOpenContextPrHandler } from "./context.pr.open";
import { createGetContextPrHandler } from "./context.pr.get";
import { createMergeContextPrHandler } from "./context.pr.merge";
import { createProposeRecordHandler } from "./context.proposal.create";
import { createListRecordsHandler } from "./context.records.list";
import { parseChecked } from "./context.steering.checks";
import {
  AUTHOR,
  REVIEWER,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const LINEAGE = "ctx.release.no-reread-changelog";
const PATH = `.oxagen/rules/${LINEAGE}.toml`;
const BRANCH = `context/${LINEAGE}`;

const proposalInput = (over: Record<string, unknown> = {}) =>
  contextProposalCreate.input.parse({
    record: {
      lineageId: LINEAGE,
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      statement:
        "Do not re-read CHANGELOG.md more than once in a run; cache the first read.",
    },
    rationale: "682 duplicate tool calls across 212 runs.",
    support: {
      runs: ["run_1", "run_2"],
      agents: ["a-intel.core.cc"],
      recordIds: ["cta_1"],
      evidenceLinks: ["fnd_01K5RT6C"],
    },
    ...over,
  });

async function proposed(h: Harness, over: Record<string, unknown> = {}) {
  const { proposalId } = await createProposeRecordHandler(h)(
    proposalInput(over),
    ctx(),
  );
  return proposalId;
}

beforeEach(() => {
  gate.refuse = false;
});

describe("open_context_pr", () => {
  it("branches from the production branch, commits the single stamped file, opens the PR and passes the six checks", async () => {
    const h = harness();
    const proposalId = await proposed(h);
    const out = await createOpenContextPrHandler(h)({ proposalId }, ctx());

    expect(h.github.branches).toEqual([{ branch: BRANCH, from: "main" }]);
    expect(h.github.commits).toEqual([
      { path: PATH, branch: BRANCH, message: `steering: propose ${LINEAGE}` },
    ]);
    const committed = h.github.files.get(`${BRANCH}:${PATH}`)!;
    const parsed = parseChecked(committed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.set_id).toBe("a-intel.platform");
      expect(parsed.file.record[0]).toMatchObject({
        lineage_id: LINEAGE,
        kind: "rule",
        origin: "user",
        sharing_scope: "workspace",
        status: "active",
        steering: { force: "should" },
      });
    }
    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.pulls[0]).toMatchObject({
      title: `Context PR: ${LINEAGE}`,
      head: BRANCH,
      base: "main",
    });
    expect(h.github.pulls[0]!.body).toContain("682 duplicate tool calls");
    expect(h.github.pulls[0]!.body).toContain("`cta_1`");
    expect(h.github.pulls[0]!.body).toContain("`fnd_01K5RT6C`");
    expect(h.github.pulls[0]!.body).toContain(out.record!.recordHash);

    expect(out.status).toBe("checks_passed");
    expect(out.governanceMode).toBe("team");
    expect(out.pr).toMatchObject({
      number: 519,
      repository: "a-intel/platform",
      baseRef: "main",
      branch: BRANCH,
      headSha: "head1",
      path: PATH,
    });
    expect(out.checks.map((c) => [c.name, c.status])).toEqual([
      ["schema", "passed"],
      ["lineage_uniqueness", "passed"],
      ["record_hash", "passed"],
      ["secret_pii_scan", "passed"],
      ["conflict_against_active", "passed"],
      ["constraint_effect", "passed"],
    ]);
    expect(
      out.checks.every(
        (c) =>
          c.detailsUrl?.startsWith("https://github.com/") &&
          c.startedAt &&
          c.completedAt,
      ),
    ).toBe(true);
    expect(h.github.checkRuns.map((c) => c.conclusion)).toEqual(
      Array(6).fill("success"),
    );
    expect(h.github.checkRuns[0]).toMatchObject({
      name: "Oxagen · Schema",
      headSha: "head1",
    });
    expect(out.onMerge).toEqual({
      publishes: { lineageId: LINEAGE, path: PATH },
      bundleVersion: { current: 0, afterMerge: 1 },
      review:
        "team: an org Owner or Admin, or a workspace Owner, other than the author merges",
    });
    expect(() => contextPrOpen.output.parse(out)).not.toThrow();
  });

  it("records each check's outcome on the row before the next one starts, so a poll sees the state machine move", async () => {
    const h = harness();
    const proposalId = await proposed(h);
    const seen: string[] = [];
    const store = h.store;
    const original = store.updateProposal.bind(store);
    store.updateProposal = async (id, patch) => {
      const row = await original(id, patch);
      const glyph = {
        pending: ".",
        running: "r",
        passed: "P",
        failed: "F",
      } as const;
      seen.push(
        `${row.status}:${row.checks.map((c) => glyph[c.status]).join("")}`,
      );
      return row;
    };
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    // One check at a time, in order: running, then its outcome, then the next.
    expect(seen.slice(0, 5)).toEqual([
      "pr_open:......",
      "checks_running:......",
      "checks_running:r.....",
      "checks_running:P.....",
      "checks_running:Pr....",
    ]);
    expect(seen.at(-2)).toBe("checks_running:PPPPPP");
    expect(seen.at(-1)).toBe("checks_passed:PPPPPP");
  });

  it("leaves a failing proposal in checks_failed with every problem named", async () => {
    const h = harness();
    const proposalId = await proposed(h, {
      record: {
        ...proposalInput().record,
        statement: "Ask marcus@a-intel.example before merging.",
      },
    });
    const out = await createOpenContextPrHandler(h)({ proposalId }, ctx());
    expect(out.status).toBe("checks_failed");
    const scan = out.checks.find((c) => c.name === "secret_pii_scan")!;
    expect(scan.status).toBe("failed");
    expect(scan.summary).toContain("email address in statement");
    expect(out.checks.filter((c) => c.status === "passed")).toHaveLength(5);
    expect(
      h.github.checkRuns.filter((c) => c.conclusion === "failure"),
    ).toHaveLength(1);
    expect(h.github.pulls).toHaveLength(1);
  });

  it("checks the file as it sits on the branch: a later edit fails the hash on a re-run, on the same PR", async () => {
    const h = harness();
    const proposalId = await proposed(h);
    const open = createOpenContextPrHandler(h);
    const first = await open({ proposalId }, ctx());
    expect(first.status).toBe("checks_passed");

    const edited = h.github.files
      .get(`${BRANCH}:${PATH}`)!
      .replace("cache the first read", "cache every read");
    h.github.files.set(`${BRANCH}:${PATH}`, edited);
    const second = await open({ proposalId }, ctx());
    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.commits).toHaveLength(1);
    expect(second.pr?.number).toBe(first.pr?.number);
    expect(second.status).toBe("checks_failed");
    expect(second.checks.find((c) => c.name === "record_hash")).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("does not match the file's"),
    });
    expect(h.github.checkRuns).toHaveLength(12);
  });

  it("refuses a second PR on a lineage that has one open, a merged or rejected proposal, and a workspace with no repository", async () => {
    const h = harness();
    const open = createOpenContextPrHandler(h);
    const a = await proposed(h);
    const b = await proposed(h);
    await open({ proposalId: a }, ctx());
    await expect(open({ proposalId: b }, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "lineage_pr_open",
    });
    expect(h.github.pulls).toHaveLength(1);

    const rejected = h.store.proposals.find((p) => p.publicId === b)!;
    await h.store.updateProposal(rejected.id, { status: "rejected" });
    await expect(open({ proposalId: b }, ctx())).rejects.toMatchObject({
      reason: "proposal_rejected",
    });

    const bare = harness();
    bare.github.repository = null;
    const c = await proposed(bare);
    await expect(
      createOpenContextPrHandler(bare)({ proposalId: c }, ctx()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_repository_missing",
    });
    expect(bare.store.proposals[0]!.status).toBe("proposed");
  });

  it("reads the governance mode from governance.toml and refuses one it cannot read", async () => {
    const regulated = harness({
      [`main:.oxagen/rules/governance.toml`]: 'mode = "regulated"\n',
    });
    const a = await proposed(regulated);
    const out = await createOpenContextPrHandler(regulated)(
      { proposalId: a },
      ctx(),
    );
    expect(out.governanceMode).toBe("regulated");
    expect(out.onMerge.review).toContain("regulated:");

    const broken = harness({
      [`main:.oxagen/rules/governance.toml`]: 'mode = "anarchy"\n',
    });
    const b = await proposed(broken);
    await expect(
      createOpenContextPrHandler(broken)({ proposalId: b }, ctx()),
    ).rejects.toMatchObject({
      reason: "governance_unreadable",
    });
    expect(broken.github.pulls).toHaveLength(0);
  });

  it("records the checks on the proposal even when GitHub refuses the check run (a non-App token)", async () => {
    const h = harness();
    h.github.checksRefused = true;
    const a = await proposed(h);
    const out = await createOpenContextPrHandler(h)({ proposalId: a }, ctx());
    expect(out.status).toBe("checks_passed");
    expect(
      out.checks.every((c) => c.detailsUrl === null && c.status === "passed"),
    ).toBe(true);
  });

  it("is refused for a role the gate excludes, before GitHub is touched", async () => {
    const h = harness();
    const a = await proposed(h);
    gate.refuse = true;
    await expect(
      createOpenContextPrHandler(h)({ proposalId: a }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(h.github.branches).toHaveLength(0);
  });
});

describe("get_context_pr", () => {
  it("answers the proposal before its PR, with the steering version from the ledger, and 404s an unknown id", async () => {
    const h = harness();
    const a = await proposed(h);
    const get = createGetContextPrHandler(h);
    const before = await get({ proposalId: a }, ctx());
    expect(before).toMatchObject({
      status: "proposed",
      pr: null,
      record: null,
      body: null,
      checks: [],
      merged: null,
    });
    expect(before.onMerge.bundleVersion).toEqual({ current: 0, afterMerge: 1 });
    await expect(get({ proposalId: "prp_nope" }, ctx())).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("merge_context_pr", () => {
  async function opened(h: Harness, over: Record<string, unknown> = {}) {
    const id = await proposed(h, over);
    await createOpenContextPrHandler(h)({ proposalId: id }, ctx());
    return id;
  }

  it("is refused before every check passed, and touches nothing", async () => {
    const h = harness();
    const id = await proposed(h);
    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "checks_not_passed",
    });
    const failing = await proposed(h, {
      record: {
        ...proposalInput().record,
        lineageId: "ctx.other",
        statement: "Email marcus@a-intel.example.",
      },
    });
    await createOpenContextPrHandler(h)({ proposalId: failing }, ctx());
    await expect(
      merge({ proposalId: failing }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ reason: "checks_not_passed" });
    expect(h.github.merges).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("team mode: the author cannot merge their own PR; an Admin can", async () => {
    const h = harness();
    const id = await opened(h);
    const merge = createMergeContextPrHandler(h);
    h.roleOf.set(AUTHOR, { org: null, workspace: "Owner" });
    await expect(
      merge({ proposalId: id }, ctx({ userId: AUTHOR })),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "separation_of_duties",
    });
    h.roleOf.set("u_member", { org: null, workspace: "Member" });
    await expect(
      merge({ proposalId: id }, ctx({ userId: "u_member" })),
    ).rejects.toMatchObject({ reason: "org_role_required" });
    expect(h.github.merges).toHaveLength(0);
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
  });

  it("regulated mode: refused without the named approver (an org Owner/Admin other than the author)", async () => {
    const h = harness({
      "main:.oxagen/rules/governance.toml": 'mode = "regulated"\n',
    });
    const id = await opened(h);
    const merge = createMergeContextPrHandler(h);
    h.roleOf.set("u_wsowner", { org: null, workspace: "Owner" });
    await expect(
      merge({ proposalId: id }, ctx({ userId: "u_wsowner" })),
    ).rejects.toMatchObject({ reason: "org_role_required" });
    h.roleOf.set(AUTHOR, { org: "Admin", workspace: null });
    await expect(
      merge({ proposalId: id }, ctx({ userId: AUTHOR })),
    ).rejects.toMatchObject({ reason: "separation_of_duties" });
    await expect(
      merge({ proposalId: id }, ctx({ userId: null, apiKeyId: "key_1" })),
    ).rejects.toMatchObject({ reason: "no_principal" });
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(h.store.ledger[0]).toMatchObject({
      approverUserId: REVIEWER,
      policyVersion: "governance:regulated",
    });
    expect(out.promotionEvent.seq).toBe(1);
  });

  it("solo mode: the author merges", async () => {
    const h = harness({
      "main:.oxagen/rules/governance.toml": 'mode = "solo"\n',
    });
    const id = await opened(h);
    const out = await createMergeContextPrHandler(h)(
      { proposalId: id },
      ctx({ userId: AUTHOR }),
    );
    expect(out.status).toBe("merged");
  });

  it("merges on GitHub, publishes the record, appends the promotion event, bumps the steering version and emits steering.published", async () => {
    const h = harness();
    const id = await opened(h);
    const out = await createMergeContextPrHandler(h)(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );

    expect(h.github.merges).toEqual([
      { number: 519, commitTitle: `steering: publish ${LINEAGE} (#519)` },
    ]);
    expect(out).toMatchObject({
      status: "merged",
      record: { lineageId: LINEAGE, version: 1, path: PATH },
      mergedCommit: "merge519",
      promotionEvent: { seq: 1 },
      bundleVersion: { before: 0, after: 1 },
    });
    expect(() => contextPrMerge.output.parse(out)).not.toThrow();

    const record = h.store.records[0]!;
    expect(record).toMatchObject({
      slug: LINEAGE,
      status: "active",
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      commitSha: "merge519",
      path: PATH,
      version: 1,
    });
    expect(record.publishedAt).toBeInstanceOf(Date);
    expect(h.store.versions[0]!.body).toBe(h.github.files.get(`main:${PATH}`));
    expect(h.store.ledger).toHaveLength(1);
    expect(h.store.ledger[0]).toMatchObject({
      seq: 1,
      prev: null,
      approverUserId: REVIEWER,
      policyVersion: "governance:team",
    });
    expect(h.events).toEqual([
      expect.objectContaining({
        eventType: "steering.published",
        actorUserId: REVIEWER,
        capability: "merge_context_pr",
        outcome: "success",
      }),
    ]);

    // The registry now lists it, the PR view shows the promotion event, and a second merge is refused.
    const listed = await createListRecordsHandler(h)(
      { limit: 50, offset: 0 },
      ctx(),
    );
    expect(listed.records.map((r) => [r.lineageId, r.kind, r.commit])).toEqual([
      [LINEAGE, "rule", "merge519"],
    ]);
    const view = await createGetContextPrHandler(h)({ proposalId: id }, ctx());
    expect(view.status).toBe("merged");
    expect(view.merged).toMatchObject({
      commit: "merge519",
      byUserId: REVIEWER,
      promotionEventId: h.store.ledger[0]!.publicId,
      recordId: record.publicId,
    });
    expect(view.onMerge.bundleVersion).toEqual({ current: 1, afterMerge: 1 });
    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ reason: "already_merged" });
  });

  it("a second publication on the same lineage is a new version and the next link in the chain", async () => {
    const h = harness();
    const first = await opened(h);
    await createMergeContextPrHandler(h)(
      { proposalId: first },
      ctx({ userId: REVIEWER }),
    );
    const second = await opened(h, {
      record: {
        ...proposalInput().record,
        statement: "Cache the first CHANGELOG.md read; never re-read it.",
      },
    });
    const out = await createMergeContextPrHandler(h)(
      { proposalId: second },
      ctx({ userId: REVIEWER }),
    );
    expect(out.record.version).toBe(2);
    expect(out.promotionEvent.seq).toBe(2);
    expect(out.bundleVersion).toEqual({ before: 1, after: 2 });
    expect(h.store.records).toHaveLength(1);
    expect(h.store.ledger[1]!.prev).toBe(h.store.ledger[0]!.chainDigest);
  });

  it("publishes nothing when GitHub refuses the merge", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.mergeRefusedWith = "At least 1 approving review is required";
    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "github_refused",
    });
    expect(h.store.records).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.store.proposals[0]!.status).toBe("checks_passed");
  });
});
