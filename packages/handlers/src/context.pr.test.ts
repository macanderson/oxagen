import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";

// The role gate reads iam.principal_role_assignments and the key's creator
// from auth.api_keys; the tests decide both.
const gate = vi.hoisted(() => ({
  refuse: false,
  keyCreator: "u_key_creator" as string | null,
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: {
    userId: string | null;
    apiKeyId: string | null;
  }) => c.userId ?? (c.apiKeyId ? gate.keyCreator : null),
  assertOrgRole: async (actor: { userId: string | null }) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
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
import { createDismissProposalHandler } from "./context.proposal.dismiss";
import { createProposeRecordHandler } from "./context.proposal.create";
import { createListRecordsHandler } from "./context.records.list";
import { stringify } from "smol-toml";
import { parseChecked } from "./context.steering.checks";
import { stampRecordObject } from "./context.steering.file";
import {
  AUTHOR,
  MemoryStore,
  REPO,
  REVIEWER,
  SCOPE,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const LINEAGE = "ctx.release.no-reread-changelog";
const PATH = `.oxagen/rules/${LINEAGE}.toml`;
const BRANCH = `context/${LINEAGE}`;
const GOVERNANCE = ".oxagen/rules/governance.toml";

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
  gate.keyCreator = "u_key_creator";
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
    const committed = (await h.github.readFile(REPO, PATH, BRANCH))!;
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

  it("opens the PR with the no-issue label and quotes every line of the statement, so the dod check passes and the block quote holds", async () => {
    const h = harness();
    const proposalId = await proposed(h, {
      record: {
        lineageId: LINEAGE,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: "Do not re-read CHANGELOG.md.\nCache the first read.\n",
      },
    });
    await createOpenContextPrHandler(h)({ proposalId }, ctx());

    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.pulls[0]!.labels).toEqual(["no-issue"]);
    expect(h.github.pulls[0]!.body).toContain(
      "> Do not re-read CHANGELOG.md.\n> Cache the first read.\n",
    );
    expect(h.github.pulls[0]!.body).not.toContain("\nCache the first read.");
  });

  it("records each check's outcome on the row before the next one starts, so a poll sees the state machine move", async () => {
    const h = harness();
    const proposalId = await proposed(h);
    const seen: string[] = [];
    const store = h.store;
    const original = store.updateProposal.bind(store);
    store.updateProposal = async (id, patch, from, guard) => {
      const row = await original(id, patch, from, guard);
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
    // The branch is recorded before GitHub is touched; then one check at a
    // time, in order: running, then its outcome, then the next.
    expect(seen.slice(0, 6)).toEqual([
      "proposed:",
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

  it("checks the file at the PR's current head: a later edit fails the hash on a re-run, on the same PR, with the check runs on the new head", async () => {
    const h = harness();
    const proposalId = await proposed(h);
    const open = createOpenContextPrHandler(h);
    const first = await open({ proposalId }, ctx());
    expect(first.status).toBe("checks_passed");
    expect(first.pr?.headSha).toBe("head1");

    const edited = (await h.github.readFile(REPO, PATH, BRANCH))!.replace(
      "cache the first read",
      "cache every read",
    );
    h.github.commit(BRANCH, PATH, edited);
    const second = await open({ proposalId }, ctx());
    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.commits).toHaveLength(1);
    expect(second.pr?.number).toBe(first.pr?.number);
    expect(second.pr?.headSha).toBe("head2");
    expect(second.status).toBe("checks_failed");
    expect(second.checks.find((c) => c.name === "record_hash")).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("does not match the file's"),
    });
    expect(h.github.checkRuns).toHaveLength(12);
    expect(h.github.checkRuns.slice(6).map((c) => c.headSha)).toEqual(
      Array(6).fill("head2"),
    );
  });

  it("a re-run on a branch edit that re-stamps the record passes and the row carries the file's identity", async () => {
    const h = harness();
    const proposalId = await proposed(h);
    const open = createOpenContextPrHandler(h);
    const first = await open({ proposalId }, ctx());
    // The author fixes the file on the branch and stamps it as Stella would;
    // only the provenance moves, the classification stays the proposal's.
    const committed = parseChecked(
      (await h.github.readFile(REPO, PATH, BRANCH))!,
    );
    if (!committed.ok) throw new Error(committed.reason);
    const raw = committed.file.raw[0]!;
    const moved = {
      ...raw,
      provenance: { source_kind: "proposal", source_uri: "oxagen:proposal/x" },
    };
    const restamped = { ...moved, ...stampRecordObject(moved) };
    h.github.commit(
      BRANCH,
      PATH,
      `${stringify({
        schema: "context-record/v0.1",
        set_id: committed.file.set_id,
        record: [restamped],
      })}\n`,
    );
    const second = await open({ proposalId }, ctx());
    expect(second.status).toBe("checks_passed");
    expect(second.pr?.headSha).toBe("head2");
    expect(second.record?.recordHash).toBe(restamped.record_hash);
    expect(second.record?.recordHash).not.toBe(first.record?.recordHash);
    expect(h.store.proposals[0]).toMatchObject({
      headSha: "head2",
      stampedRecordId: restamped.record_id,
      recordHash: restamped.record_hash,
    });
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
    await h.store.updateProposal(rejected.id, { status: "rejected" }, [
      "proposed",
    ]);
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

  it("fails the schema check when the branch changes a file besides the record, so nothing merges and the production branch keeps its governance file", async () => {
    const h = harness({ [`main:${GOVERNANCE}`]: 'mode = "team"\n' });
    const id = await proposed(h);
    const open = createOpenContextPrHandler(h);
    expect((await open({ proposalId: id }, ctx())).status).toBe(
      "checks_passed",
    );
    h.github.commit(BRANCH, GOVERNANCE, 'mode = "solo"\n');

    const out = await open({ proposalId: id }, ctx());
    expect(out.status).toBe("checks_failed");
    const schema = out.checks.find((c) => c.name === "schema")!;
    expect(schema.status).toBe("failed");
    expect(schema.summary).toContain(GOVERNANCE);
    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ reason: "checks_not_passed" });
    expect(h.github.merges).toHaveLength(0);
    expect(h.store.records).toHaveLength(0);
    expect(await h.github.readFile(REPO, GOVERNANCE, "main")).toBe(
      'mode = "team"\n',
    );
  });

  it("retries onto the PR GitHub opened when recording it failed: one PR, checked at the new head, and the row carries its number", async () => {
    const h = harness();
    const id = await proposed(h);
    const store = h.store;
    const update = store.updateProposal.bind(store);
    let fail = true;
    store.updateProposal = async (rowId, patch, from, guard) => {
      if (fail && patch.status === "pr_open") {
        fail = false;
        throw new Error("db blip");
      }
      return update(rowId, patch, from, guard);
    };
    const open = createOpenContextPrHandler(h);
    await expect(open({ proposalId: id }, ctx())).rejects.toThrow("db blip");
    expect(h.github.pulls).toHaveLength(1);
    expect(h.store.proposals[0]).toMatchObject({
      status: "proposed",
      prNumber: null,
      branch: BRANCH,
    });

    const out = await open({ proposalId: id }, ctx());
    expect(out.status).toBe("checks_passed");
    expect(out.pr).toMatchObject({ number: 519, headSha: "head2" });
    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.checkRuns).toHaveLength(6);
    expect(h.github.checkRuns.every((r) => r.headSha === "head2")).toBe(true);
  });

  it("adopts an open PR on the branch only when its body names the proposal: another proposal's orphan PR is refused, survives the first proposal's dismissal, and is adopted by its own retry", async () => {
    const h = harness();
    const open = createOpenContextPrHandler(h);
    const a = await proposed(h);
    const b = await proposed(h);

    // A records the branch, then GitHub fails to open the PR.
    const github = h.github;
    const openPr = github.openPullRequest.bind(github);
    let prFails = true;
    github.openPullRequest = async (repo, args) => {
      if (prFails) {
        prFails = false;
        throw new Error("GitHub API error 502: Bad Gateway");
      }
      return openPr(repo, args);
    };
    await expect(open({ proposalId: a }, ctx())).rejects.toThrow("502");
    expect(h.github.pulls).toHaveLength(0);

    // B opens PR 519, then recording it fails.
    const store = h.store;
    const update = store.updateProposal.bind(store);
    let rowFails = true;
    store.updateProposal = async (rowId, patch, from, guard) => {
      if (rowFails && patch.status === "pr_open") {
        rowFails = false;
        throw new Error("db blip");
      }
      return update(rowId, patch, from, guard);
    };
    await expect(open({ proposalId: b }, ctx())).rejects.toThrow("db blip");
    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.pulls[0]!.body).toContain(`Proposal \`${b}\``);

    await expect(open({ proposalId: a }, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "lineage_pr_open",
      message: expect.stringContaining("/pull/519"),
    });
    expect(h.store.proposals.find((p) => p.publicId === a)).toMatchObject({
      status: "proposed",
      prNumber: null,
    });
    expect(h.github.checkRuns).toHaveLength(0);

    await createDismissProposalHandler(h)(
      { proposalId: a, reason: "superseded" },
      ctx(),
    );
    expect(h.github.pulls[0]).toMatchObject({ number: 519, state: "open" });
    expect(h.github.deletedBranches).toEqual([]);

    const out = await open({ proposalId: b }, ctx());
    expect(out.status).toBe("checks_passed");
    expect(out.pr?.number).toBe(519);
    expect(h.github.pulls).toHaveLength(1);
  });

  it("stamps origin from who raised the proposal: an agent's proposal opened by a person is inferred, and its hash recomputes", async () => {
    const h = harness();
    const { proposalId } = await createProposeRecordHandler(h)(
      proposalInput(),
      ctx({ userId: null, apiKeyId: "key_1" }),
    );
    const out = await createOpenContextPrHandler(h)({ proposalId }, ctx());
    expect(out.status).toBe("checks_passed");
    expect(out.checks.find((c) => c.name === "record_hash")?.status).toBe(
      "passed",
    );
    const parsed = parseChecked((await h.github.readFile(REPO, PATH, BRANCH))!);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.file.record[0]).toMatchObject({
      origin: "inferred",
      record_hash: out.record?.recordHash,
    });
  });

  it("a re-run that records a newer head while an earlier run finishes wins: the earlier outcome is refused head_moved and nothing merges", async () => {
    const h = harness();
    const id = await proposed(h);
    const open = createOpenContextPrHandler(h);
    expect((await open({ proposalId: id }, ctx())).status).toBe(
      "checks_passed",
    );

    // Run A checks head1 and is held at its last write.
    const store = h.store;
    const update = store.updateProposal.bind(store);
    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => (releaseA = resolve));
    let parkA!: () => void;
    const aParked = new Promise<void>((resolve) => (parkA = resolve));
    let holdingA = true;
    store.updateProposal = async (rowId, patch, from, guard) => {
      if (
        holdingA &&
        (patch.status === "checks_passed" || patch.status === "checks_failed")
      ) {
        holdingA = false;
        parkA();
        await holdA;
      }
      return update(rowId, patch, from, guard);
    };
    // Run B, on the head pushed meanwhile, is held at its first check run.
    const github = h.github;
    const report = github.reportCheckRun.bind(github);
    let releaseB!: () => void;
    const holdB = new Promise<void>((resolve) => (releaseB = resolve));
    let parkB!: () => void;
    const bParked = new Promise<void>((resolve) => (parkB = resolve));
    let holdingB = true;
    github.reportCheckRun = async (repo, args) => {
      if (holdingB && args.headSha === "head2") {
        holdingB = false;
        parkB();
        await holdB;
      }
      return report(repo, args);
    };

    const runA = open({ proposalId: id }, ctx());
    await aParked;
    const edited = (await h.github.readFile(REPO, PATH, BRANCH))!.replace(
      "cache the first read",
      "cache every read",
    );
    h.github.commit(BRANCH, PATH, edited);
    const runB = open({ proposalId: id }, ctx());
    await bParked;
    releaseA();
    await expect(runA).rejects.toMatchObject({
      code: "conflict",
      reason: "head_moved",
    });
    releaseB();
    const out = await runB;
    expect(out.status).toBe("checks_failed");
    expect(out.pr?.headSha).toBe("head2");
    expect(h.store.proposals[0]).toMatchObject({
      status: "checks_failed",
      headSha: "head2",
    });
    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ reason: "checks_not_passed" });
    expect(h.github.merges).toHaveLength(0);
    expect(h.store.records).toHaveLength(0);
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

  it("under an API key acts as the key's creator, recorded as the updater, and refuses a key with no creator before GitHub", async () => {
    const h = harness();
    const a = await proposed(h);
    const KEY_CTX = ctx({ userId: null, apiKeyId: "key_1" });

    gate.keyCreator = null;
    await expect(
      createOpenContextPrHandler(h)({ proposalId: a }, KEY_CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(h.github.branches).toHaveLength(0);
    expect(h.store.proposals[0]!.status).toBe("proposed");

    gate.keyCreator = "u_key_creator";
    const out = await createOpenContextPrHandler(h)({ proposalId: a }, KEY_CTX);
    expect(out.status).toBe("checks_passed");
    expect(h.store.proposals[0]).toMatchObject({
      updatedById: "u_key_creator",
    });
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
      governanceMode: null,
      pr: null,
      record: null,
      body: null,
      checks: [],
      merged: null,
    });
    expect(before.onMerge.review).toBeNull();
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
      {
        number: 519,
        commitTitle: `steering: publish ${LINEAGE} (#519)`,
        sha: "head1",
      },
    ]);
    expect(h.github.deletedBranches).toEqual([BRANCH]);
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
    expect(h.store.versions[0]!.body).toBe(
      await h.github.readFile(REPO, PATH, "main"),
    );
    // The version carries its own classification, so a later promote of it
    // can restore what it says onto the record row (#3312).
    expect(h.store.versions[0]).toMatchObject({
      kind: "rule",
      force: "should",
      constraintEffect: null,
    });
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
    // The first merge deleted its branch, so the second branched from the
    // production branch that already held the squash: no add/add conflict.
    expect(h.github.branches).toEqual([
      { branch: BRANCH, from: "main" },
      { branch: BRANCH, from: "main" },
    ]);
    expect(h.github.deletedBranches).toEqual([BRANCH, BRANCH]);
    expect(h.github.pulls.map((p) => p.number)).toEqual([519, 520]);
  });

  it("is refused when the head moved after the checks passed, and publishes nothing", async () => {
    const h = harness();
    const id = await opened(h);
    const pushed = (await h.github.readFile(REPO, PATH, BRANCH))!.replace(
      "cache the first read",
      "see ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    );
    h.github.commit(BRANCH, PATH, pushed);
    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "head_moved",
      message: expect.stringContaining("head2"),
    });
    expect(h.github.merges).toHaveLength(0);
    expect(h.github.deletedBranches).toHaveLength(0);
    expect(h.store.records).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.store.proposals[0]!.status).toBe("checks_passed");
  });

  it("refuses base_moved on the merge and on a re-run once the PR is retargeted off the production branch, and publishes nothing", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.pulls[0]!.base = "staging";
    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "base_moved",
      message: expect.stringContaining("targets staging"),
    });
    await expect(
      createOpenContextPrHandler(h)({ proposalId: id }, ctx()),
    ).rejects.toMatchObject({ code: "conflict", reason: "base_moved" });
    expect(h.github.checkRuns).toHaveLength(6);
    expect(h.github.merges).toHaveLength(0);
    expect(h.github.deletedBranches).toHaveLength(0);
    expect(h.store.records).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.store.proposals[0]!.status).toBe("checks_passed");
  });

  it("resumes a merge GitHub already holds: the publication that failed lands on a retry with the same commit, once", async () => {
    const h = harness();
    const id = await opened(h);
    const store = h.store;
    const original = store.publishMerge.bind(store);
    let fail = true;
    store.publishMerge = async (input) => {
      if (fail) {
        fail = false;
        throw new Error("connection reset");
      }
      return original(input);
    };
    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");
    expect(h.github.merges).toHaveLength(1);
    expect(h.github.deletedBranches).toEqual([BRANCH]);
    expect(h.store.proposals[0]!.status).toBe("checks_passed");
    expect(h.store.records).toHaveLength(0);

    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(out.mergedCommit).toBe("merge519");
    expect(h.github.merges).toHaveLength(1);
    expect(h.store.ledger).toHaveLength(1);
    expect(h.store.records).toHaveLength(1);
    expect(h.store.versions[0]!.body).toBe(
      await h.github.readFile(REPO, PATH, "head1"),
    );
    // The publication carries GitHub's merge instant, not the retry's clock.
    // The harness clock advances on every reading, so a reading taken here is
    // necessarily later than the merge; that is what makes the line above a
    // claim rather than a restatement of "now".
    //
    // It deliberately does not say how much later. The previous form required
    // at least two readings between the merge and here, which was a count of
    // how often the code happens to look at the clock, not a fact about the
    // record. The resume path stopped looking: it takes `mergedAt` from the
    // pull request rather than reading the clock, which is the whole point of
    // this test, so the old assertion broke because the behaviour it guards
    // started working.
    const mergedAt = h.github.pulls[0]!.mergedAt!;
    expect(h.store.records[0]!.publishedAt).toEqual(mergedAt);
    expect(mergedAt.getTime()).toBeLessThan(h.now().getTime());
  });

  // Two Context PRs merging at once are two calls to GitHub, and GitHub can
  // land A before B while A's response comes back after B's. The branch that
  // performs the merge stamped the publication with its own clock, so A could
  // sort newest over the commit that descends from it, and a checkout at A
  // read as current while it lacked B's record.
  it("stamps a merge it performs with GitHub's merge time, not this call's clock", async () => {
    const h = harness();
    const id = await opened(h);
    const out = await createMergeContextPrHandler(h)(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );
    expect(out.status).toBe("merged");
    const mergedAt = h.github.pulls[0]!.mergedAt!;
    expect(h.store.records[0]!.publishedAt).toEqual(mergedAt);
    // Every clock reading after the merge is later, so the stamp can only be
    // GitHub's.
    expect(h.now().getTime()).toBeGreaterThan(mergedAt.getTime());
  });

  // The re-read that reports GitHub's merge instant can time out while two
  // Context PRs are merging at once. Stamping the earlier commit with this
  // call's later clock made `latestPublication` name an ancestor as the tip a
  // checkout must reach, so a checkout stopped there read as current while it
  // lacked the later record. The publication is refused instead, and the
  // merge GitHub already holds is resumed on the retry.
  it("refuses merge_time_unknown when the merged pull request cannot be re-read, and the retry publishes GitHub's instant", async () => {
    const h = harness();
    const id = await opened(h);
    const github = h.github;
    const read = github.getPullRequest.bind(github);
    // The first read is the head check before the merge; the second is the
    // re-read for the merge instant.
    let calls = 0;
    github.getPullRequest = async (repo, number) => {
      calls += 1;
      if (calls > 1) throw new Error("GitHub API error 502");
      return read(repo, number);
    };
    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "merge_time_unknown",
    });
    // The merge landed on GitHub; only the publication was refused.
    expect(h.github.merges).toHaveLength(1);
    expect(h.store.records).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    // The proposal is still mergeable, which is what makes the refusal safe
    // to retry.
    expect(h.store.proposals[0]!.status).toBe("checks_passed");

    github.getPullRequest = read;
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(out.mergedCommit).toBe("merge519");
    expect(h.github.merges).toHaveLength(1);
    const mergedAt = h.github.pulls[0]!.mergedAt!;
    expect(h.store.records[0]!.publishedAt).toEqual(mergedAt);
    // The retry's clock is later, so the stamp can only be GitHub's.
    expect(h.now().getTime()).toBeGreaterThan(mergedAt.getTime());
  });

  // The resume path reads the instant off the pull request, so it has the
  // same guess to refuse when GitHub answers without one.
  it("refuses merge_time_unknown when GitHub reports the merge with no instant", async () => {
    const h = harness();
    const id = await opened(h);
    const store = h.store;
    const original = store.publishMerge.bind(store);
    let fail = true;
    store.publishMerge = async (input) => {
      if (fail) {
        fail = false;
        throw new Error("connection reset");
      }
      return original(input);
    };
    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");
    const pr = h.github.pulls[0]!;
    const mergedAt = pr.mergedAt;
    pr.mergedAt = null;
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "merge_time_unknown",
    });
    expect(h.store.records).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);

    // Once GitHub answers with the instant, the same retry publishes.
    pr.mergedAt = mergedAt;
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(h.store.records[0]!.publishedAt).toEqual(mergedAt);
  });

  // `latestPublication` orders by `publishedAt` to name the commit a checkout
  // must reach. A retried publication stamped with the retry's time, after a
  // later merge had already published, named the earlier commit as newest.
  it("stamps a resumed publication with GitHub's merge time, not the retry's", async () => {
    const h = harness();
    const id = await opened(h);
    const store = h.store;
    const original = store.publishMerge.bind(store);
    let fail = true;
    store.publishMerge = async (input) => {
      if (fail) {
        fail = false;
        throw new Error("connection reset");
      }
      return original(input);
    };
    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");
    const mergedAt = h.github.pulls[0]!.mergedAt;
    expect(mergedAt).not.toBeNull();
    // Time passes: other calls, other merges.
    h.now();
    h.now();
    h.now();

    await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(h.store.records[0]!.publishedAt?.getTime()).toBe(
      mergedAt!.getTime(),
    );
  });

  // The case the stamp exists for. PR A merges on GitHub and its publication
  // fails. PR B merges and publishes. A's publication is retried. The newest
  // publication is still B's commit: a checkout at A's commit lacks B's
  // record, and `get_steering_freshness` must name B's commit as the one a
  // checkout has to reach, whatever order the rows were written in.
  it("a retried earlier merge does not become the newest publication over a later one", async () => {
    const h = harness();
    const a = await opened(h);
    const store = h.store;
    const original = store.publishMerge.bind(store);
    let failOnce = true;
    store.publishMerge = async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("connection reset");
      }
      return original(input);
    };
    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: a }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");
    const commitA = h.github.pulls[0]!.mergeCommitSha;
    expect(commitA).not.toBeNull();

    const b = await opened(h, {
      record: {
        ...proposalInput().record,
        lineageId: "ctx.release.cache-readme",
        statement: "Do not re-read README.md more than once in a run.",
      },
    });
    await merge({ proposalId: b }, ctx({ userId: REVIEWER }));
    const commitB = h.github.pulls[1]!.mergeCommitSha;
    expect(commitB).not.toBeNull();
    expect(commitB).not.toBe(commitA);

    // A's retry lands after B published, stamped with A's merge time.
    await merge({ proposalId: a }, ctx({ userId: REVIEWER }));
    expect(h.store.records).toHaveLength(2);
    const latest = await h.store.latestPublication(SCOPE);
    expect(latest?.commitSha).toBe(commitB);
  });

  // GitHub reports `merged_at` to the second, so two PRs can merge inside
  // one. Nothing stored orders them on the branch. Write order does not: a
  // retried earlier merge is written last, and a new version of an existing
  // lineage reuses that lineage's row. Naming one commit let a checkout at
  // the earlier one read as current while it lacked the later record, so the
  // store names both and the checkout has to reach each.
  it("names every commit published at the newest instant, not one of them", async () => {
    const store = new MemoryStore();
    const at = new Date("2026-09-18T12:00:00.000Z");
    const row = (slug: string, commitSha: string) => ({
      id: `id-${slug}`,
      publicId: `ctr_${slug}`,
      createdAt: at,
      createdById: null,
      updatedById: null,
      updatedAt: at,
      deletedAt: null,
      deletedById: null,
      orgId: "org",
      workspaceId: "ws",
      slug,
      activeVersionId: null,
      version: null,
      checksum: null,
      title: slug,
      status: "active" as const,
      kind: "rule" as const,
      force: null,
      constraintEffect: null,
      sharingScope: null,
      statement: slug,
      commitSha,
      path: `.oxagen/rules/${slug}.toml`,
      publishedAt: at,
      activatedByUserId: null,
      activatedAt: at,
    });
    store.records.push(
      row("earlier", "commit-earlier") as never,
      row("later", "commit-later") as never,
      // A second lineage published by the same merge: one commit, named once.
      row("later-sibling", "commit-later") as never,
    );
    const earlierInstant = new Date(at.getTime() - 1000);
    store.records.push({
      ...row("before", "commit-before"),
      publishedAt: earlierInstant,
    } as never);
    const latest = await store.latestPublication({ workspaceId: "ws" });
    expect(latest?.publishedAt).toEqual(at);
    expect(latest?.commitShas.sort()).toEqual([
      "commit-earlier",
      "commit-later",
    ]);
    // The single commit older clients read is one of the tied ones.
    expect(latest?.commitShas).toContain(latest?.commitSha);
  });

  it("two merges a moment apart publish once: the second resumes GitHub's merge and its publication rolls back with already_merged", async () => {
    const h = harness();
    const id = await opened(h);
    const store = h.store;
    const original = store.publishMerge.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const parked = new Promise<void>((resolve) => (held = resolve));
    let first = true;
    store.publishMerge = async (input) => {
      if (first) {
        first = false;
        held();
        await gate;
      }
      return original(input);
    };
    const merge = createMergeContextPrHandler(h);
    const r1 = merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    await parked;
    // GitHub holds the merge; the second call reads it as merged and resumes.
    const r2 = merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    release();
    const settled = await Promise.allSettled([r1, r2]);
    const statuses = settled.map((s) => s.status);
    expect(statuses.filter((s) => s === "fulfilled")).toHaveLength(1);
    const lost = settled.find((s) => s.status === "rejected");
    expect(lost?.reason).toMatchObject({
      code: "conflict",
      reason: "already_merged",
    });
    expect(h.github.merges).toHaveLength(1);
    expect(h.store.ledger).toHaveLength(1);
    expect(h.store.versions).toHaveLength(1);
    expect(h.store.proposals[0]!.status).toBe("merged");
    expect(h.events).toHaveLength(1);
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
