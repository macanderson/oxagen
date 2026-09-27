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
import {
  createMergeContextPrHandler,
  type SteeringPublisher,
} from "./context.pr.merge";
import { createDismissProposalHandler } from "./context.proposal.dismiss";
import { createProposeRecordHandler } from "./context.proposal.create";
import { createListRecordsHandler } from "./context.records.list";
import { stringify } from "smol-toml";
import { contextRecordLabel } from "@oxagen/oxagen/context-record-label";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  memoryVersionStore,
  publish as publishBundle,
  treeFromFiles,
  type BundleIdentity,
  type PublishDeps,
  type PublishResult,
  type StoredVersion,
} from "@oxagen/steering-bundle";
import { logger } from "./logger";
import { heldVersionStore } from "./steering-repo/version-store";
import { parseChecked } from "./context.steering.checks";
import { stampRecordObject } from "./context.steering.file";
import { MERGE_CLAIM_SECONDS } from "./context.steering.store";
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
const BRANCH = `steering/${LINEAGE}`;
const GOVERNANCE = ".oxagen/rules/governance.toml";

/** A steering record as an author writes one: no id or hash yet. */
function steeringRecord(lineage: string): string {
  return [
    "---",
    "schema: steering-record/v1",
    `lineage: ${lineage}`,
    "label: A rule",
    "kind: rule",
    "force: should",
    "scope: workspace",
    "status: active",
    "origin: user",
    "---",
    "",
    "Do not re-read CHANGELOG.md more than once in a run.",
    "",
  ].join("\n");
}

/**
 * The fixture steering repo on main, with a clock after its ledger's last
 * line, so a stamp appends to 2026-09.jsonl.
 */
function steeringHarness(): Harness {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
  const h = harness(seed);
  let t = Date.parse("2026-09-26T12:00:00.000Z");
  const clock = () => new Date((t += 1000));
  h.github.clock = clock;
  h.now = clock;
  return h;
}

/** The identity S5 publishes the fixture steering repo under. */
const BUNDLE_IDENTITY: BundleIdentity = {
  repository: "github.com/a-intel/oxagen-core-platform",
  scope: "workspace",
  organization: "a-intel",
  workspace: "core-platform",
};

/** A later commit on the production branch than the fake host's merge of #519. */
const LATER = "0000000000000000000000000000000000000520";

/**
 * S5's publish() over the fixture repo and an in-memory version store, bound
 * as the merge binds it. The production branch head is `tip.head`, so a test
 * can publish an earlier commit first. `publish` records each publish the
 * merge makes under the store's lock. `deps` takes the lock itself, as the
 * repository sync does.
 */
function s5Publisher() {
  const tip = { head: "0000000000000000000000000000000000000519" };
  const store = memoryVersionStore();
  const deps: PublishDeps = {
    store,
    health: async () => "healthy",
    head: async () => tip.head,
    tree: async () => treeFromFiles(fixtureRepo()),
    tag: async () => undefined,
    // No server compiles here, so the tool manifest stays null.
    compiler: () => {
      throw new Error("the handler tests compile no tools");
    },
    now: () => new Date("2026-09-27T08:00:00Z"),
  };
  const publish = vi.fn(async (_repo: unknown, commit: string) =>
    publishBundle(
      { ...deps, store: heldVersionStore(store) },
      BUNDLE_IDENTITY,
      commit,
    ),
  );
  const publisher: SteeringPublisher = {
    repository: () => BUNDLE_IDENTITY.repository,
    store,
    publish: (_repo, commit) => publishBundle(deps, BUNDLE_IDENTITY, commit),
    withLock: (repo, fn) =>
      store.withLock(BUNDLE_IDENTITY.repository, () =>
        fn((commit) => publish(repo, commit)),
      ),
  };
  return { tip, store, deps, publish, publisher };
}

/** A publisher with a stubbed publish() and a lock that holds nothing. */
function unlockedPublisher(
  parts: Omit<SteeringPublisher, "withLock">,
): SteeringPublisher {
  return {
    ...parts,
    withLock: (repo, fn) => fn((commit) => parts.publish(repo, commit)),
  };
}

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
  it("quotes every line of a statement that carries a line break", async () => {
    const h = harness();
    const proposalId = await proposed(h, {
      record: {
        lineageId: LINEAGE,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: "Do not re-read CHANGELOG.md \nmore than once in a run.",
      },
    });
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    expect(h.github.pulls[0]!.body).toContain(
      "> Do not re-read CHANGELOG.md \n> more than once in a run.",
    );
  });

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
    expect(h.github.pulls[0]!.body).toContain(
      "Change the record in Oxagen, not on this pull request.",
    );
    expect(h.github.pulls[0]!.body).toContain(
      "> Do not re-read CHANGELOG.md more than once in a run; cache the first read.",
    );

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
    // One required check carries all six outcomes.
    expect(h.github.checkRuns).toEqual([
      expect.objectContaining({
        name: "Oxagen steering",
        headSha: "head1",
        conclusion: "success",
      }),
    ]);
    expect(h.github.checkRuns[0]!.summary).toContain(
      "- Passed: Conflict against active records.",
    );
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
    expect(h.github.checkRuns).toEqual([
      expect.objectContaining({
        name: "Oxagen steering",
        conclusion: "failure",
      }),
    ]);
    expect(h.github.checkRuns[0]!.summary).toContain(
      "email address in statement",
    );
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
    expect(h.github.checkRuns.map((c) => c.headSha)).toEqual([
      "head1",
      "head2",
    ]);
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

  it("writes the proposal's label into the file, else the published record's, else one read from the slug (ADR-178)", async () => {
    const committedLabel = async (h: Harness) => {
      const parsed = parseChecked(
        (await h.github.readFile(REPO, PATH, BRANCH))!,
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.file.raw[0]!.label;
    };

    const derived = harness();
    await createOpenContextPrHandler(derived)(
      { proposalId: await proposed(derived) },
      ctx(),
    );
    expect(await committedLabel(derived)).toBe(contextRecordLabel(LINEAGE));

    const h = harness();
    const named = await proposed(h, {
      record: { ...proposalInput().record, label: "Read the changelog once" },
    });
    await createOpenContextPrHandler(h)({ proposalId: named }, ctx());
    expect(await committedLabel(h)).toBe("Read the changelog once");
    await createMergeContextPrHandler(h)(
      { proposalId: named },
      ctx({ userId: REVIEWER }),
    );

    // A revision that sets no label keeps the name the record already has.
    const revision = await proposed(h, {
      record: {
        ...proposalInput().record,
        statement: "Cache the first CHANGELOG.md read; never re-read it.",
      },
    });
    await createOpenContextPrHandler(h)({ proposalId: revision }, ctx());
    expect(await committedLabel(h)).toBe("Read the changelog once");
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
    expect(h.github.checkRuns).toHaveLength(1);
    expect(h.github.checkRuns[0]!.headSha).toBe("head2");
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
        commitMessage: [
          `Oxagen-Approved-By: ${REVIEWER}`,
          "Oxagen-Checks: schema,lineage_uniqueness,record_hash,secret_pii_scan,conflict_against_active,constraint_effect",
          "Oxagen-Version: 1",
        ].join("\n"),
      },
    ]);
    expect(h.github.deletedBranches).toEqual([BRANCH]);
    expect(out).toMatchObject({
      status: "merged",
      record: { lineageId: LINEAGE, version: 1, path: PATH },
      mergedCommit: "0000000000000000000000000000000000000519",
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
      commitSha: "0000000000000000000000000000000000000519",
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
      [LINEAGE, "rule", "0000000000000000000000000000000000000519"],
    ]);
    const view = await createGetContextPrHandler(h)({ proposalId: id }, ctx());
    expect(view.status).toBe("merged");
    expect(view.merged).toMatchObject({
      commit: "0000000000000000000000000000000000000519",
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

  it("writes the record's name into the file: the proposal's, else the one the record holds, else one read from the slug (ADR-178)", async () => {
    const h = harness();
    const labelIn = async () =>
      parseChecked((await h.github.readFile(REPO, PATH, BRANCH))!);

    // A proposal that names nothing, on a lineage nothing holds: the file
    // carries the name the slug reads as, and the registry takes it.
    const first = await opened(h);
    const unnamed = await labelIn();
    expect(unnamed.ok && unnamed.file.record[0]!.label).toBe(
      "No Reread Changelog",
    );
    await createMergeContextPrHandler(h)(
      { proposalId: first },
      ctx({ userId: REVIEWER }),
    );
    expect(h.store.records[0]!.label).toBe("No Reread Changelog");

    // A proposal that renames the record writes its label, and every check,
    // the file-against-proposal one included, passes.
    const renamed = await proposed(h, {
      record: { ...proposalInput().record, label: "Read the changelog once" },
    });
    const out = await createOpenContextPrHandler(h)(
      { proposalId: renamed },
      ctx(),
    );
    expect(out.status).toBe("checks_passed");
    const named = await labelIn();
    expect(named.ok && named.file.record[0]!.label).toBe(
      "Read the changelog once",
    );
    await createMergeContextPrHandler(h)(
      { proposalId: renamed },
      ctx({ userId: REVIEWER }),
    );
    expect(h.store.records[0]!.label).toBe("Read the changelog once");

    // A revision that sets no label keeps the name the record holds. A file
    // that fell back to the slug's name would rename the record on merge.
    const revised = await opened(h, {
      record: {
        ...proposalInput().record,
        statement: "Cache the first CHANGELOG.md read; never re-read it.",
      },
    });
    const kept = await labelIn();
    expect(kept.ok && kept.file.record[0]!.label).toBe(
      "Read the changelog once",
    );
    await createMergeContextPrHandler(h)(
      { proposalId: revised },
      ctx({ userId: REVIEWER }),
    );
    expect(h.store.records).toHaveLength(1);
    expect(h.store.records[0]).toMatchObject({
      label: "Read the changelog once",
      version: 3,
    });
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

  // #4118: a review bot's suggestion was accepted into the record file on
  // GitHub, the PR was merged there, and the app answered "run the checks
  // again", which re-ran them on a head that could never change and turned
  // two of them red.
  it("refuses merged_outside_oxagen when the PR was edited and merged on the host, on the merge and on a re-run, and the lineage can be proposed again", async () => {
    const h = harness();
    const id = await opened(h);
    const accepted = (await h.github.readFile(REPO, PATH, BRANCH))!.replace(
      "cache the first read",
      "cache the first read and reuse it",
    );
    h.github.commit(BRANCH, PATH, accepted);
    await h.github.mergePullRequest(REPO, {
      number: 519,
      commitTitle: "Context PR (#519)",
      sha: "head2",
    });
    const refusal = {
      code: "conflict",
      reason: "merged_outside_oxagen",
      message: expect.stringContaining("head2"),
    };

    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject(refusal);
    await expect(
      createOpenContextPrHandler(h)({ proposalId: id }, ctx()),
    ).rejects.toMatchObject(refusal);
    // Nothing was published, and no check reported on the merged head.
    expect(h.store.records).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.github.checkRuns.map((c) => c.headSha)).toEqual(["head1"]);
    expect(h.store.proposals[0]!.status).toBe("checks_passed");

    // The way out the refusal names: dismiss, propose the wording again, and
    // merge that Context PR from Oxagen.
    await createDismissProposalHandler(h)(
      { proposalId: id, reason: "merged on GitHub after an edit" },
      ctx(),
    );
    const again = await proposed(h, {
      record: {
        lineageId: LINEAGE,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement:
          "Do not re-read CHANGELOG.md more than once in a run; cache the first read and reuse it.",
      },
    });
    const reopened = await createOpenContextPrHandler(h)(
      { proposalId: again },
      ctx(),
    );
    expect(reopened.status).toBe("checks_passed");
    const merged = await createMergeContextPrHandler(h)(
      { proposalId: again },
      ctx({ userId: REVIEWER }),
    );
    expect(merged.status).toBe("merged");
    expect(h.store.records).toHaveLength(1);
  });

  it("re-runs the checks on a PR merged on the host at the commit they passed on, and merge still publishes it", async () => {
    const h = harness();
    const id = await opened(h);
    await h.github.mergePullRequest(REPO, {
      number: 519,
      commitTitle: "Context PR (#519)",
      sha: "head1",
    });
    const rerun = await createOpenContextPrHandler(h)(
      { proposalId: id },
      ctx(),
    );
    expect(rerun.status).toBe("checks_passed");
    const out = await createMergeContextPrHandler(h)(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );
    expect(out.status).toBe("merged");
    expect(out.mergedCommit).toBe("0000000000000000000000000000000000000519");
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
    expect(h.github.checkRuns).toHaveLength(1);
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
    expect(out.mergedCommit).toBe("0000000000000000000000000000000000000519");
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
    expect(out.mergedCommit).toBe("0000000000000000000000000000000000000519");
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

  it("two merges a moment apart publish once: the second waits in the queue, reads the row as merged, and refuses already_merged", async () => {
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
    // The second call waits behind the first in the queue, then reads the
    // row the first one merged.
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

  // ── The merge queue ────────────────────────────────────────────────────────

  it("refuses repository_unhealthy while the repository is not healthy, and touches nothing", async () => {
    const h = harness();
    const id = await opened(h);
    const readHealth = vi.fn(async () => "diverged" as const);
    await expect(
      createMergeContextPrHandler(h, { readHealth })(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "repository_unhealthy",
      message: expect.stringContaining("a-intel/platform is diverged"),
    });
    expect(readHealth).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: SCOPE.workspaceId }),
      REPO,
    );
    expect(h.github.merges).toHaveLength(0);
    expect(h.github.updates).toHaveLength(0);
    expect(h.github.deployments).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.store.proposals[0]!.status).toBe("checks_passed");
  });

  it("team mode: refuses approval_required without an approval at the checked head by a member other than the author", async () => {
    const h = harness();
    const id = await opened(h);
    const merge = createMergeContextPrHandler(h);
    h.github.approvals = [];
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ code: "forbidden", reason: "approval_required" });

    // An approval of an older head, the author's own, one by a person
    // outside the workspace, and one by a host account linked to nobody
    // count for nothing.
    h.github.approvals = [
      { userId: REVIEWER, login: "reviewer", commitSha: "base0" },
      { userId: AUTHOR, login: "author", commitSha: "head1" },
      { userId: "u_outsider", login: "outsider", commitSha: "head1" },
      { userId: null, login: "unlinked", commitSha: "head1" },
    ];
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ reason: "approval_required" });
    expect(h.github.merges).toHaveLength(0);
    expect(h.github.deletedBranches).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);

    // A workspace member's approval at the checked head merges, and the
    // trailer names that member once.
    h.roleOf.set("u_member", { org: null, workspace: "Member" });
    h.github.approvals = [
      { userId: "u_member", login: "member", commitSha: "head1" },
      { userId: "u_member", login: "member", commitSha: "head1" },
    ];
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(h.github.merges[0]!.commitMessage).toMatch(
      /^Oxagen-Approved-By: u_member\n/,
    );
  });

  it("team mode: an approval does not carry across a push the queue did not make, so the merge waits for an approval of the new head", async () => {
    const h = harness();
    const id = await opened(h);
    h.roleOf.set("u_member", { org: null, workspace: "Member" });
    h.github.approvals = [
      { userId: "u_member", login: "member", commitSha: "head1" },
    ];
    // The author then edits the record on the branch and stamps it again,
    // and the checks pass on the new head.
    const committed = parseChecked(
      (await h.github.readFile(REPO, PATH, BRANCH))!,
    );
    if (!committed.ok) throw new Error(committed.reason);
    const edited = {
      ...committed.file.raw[0]!,
      provenance: { source_kind: "proposal", source_uri: "oxagen:proposal/x" },
    };
    h.github.commit(
      BRANCH,
      PATH,
      `${stringify({
        schema: "context-record/v0.1",
        set_id: committed.file.set_id,
        record: [{ ...edited, ...stampRecordObject(edited) }],
      })}\n`,
    );
    const rerun = await createOpenContextPrHandler(h)(
      { proposalId: id },
      ctx(),
    );
    expect(rerun.status).toBe("checks_passed");
    expect(rerun.pr?.headSha).toBe("head2");

    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "approval_required",
      message: expect.stringContaining("approves it at head2."),
    });
    expect(h.github.updates).toHaveLength(0);
    expect(h.github.merges).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);

    h.github.approvals = [
      { userId: "u_member", login: "member", commitSha: "head2" },
    ];
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(h.github.merges).toEqual([
      expect.objectContaining({ number: 519, sha: "head2" }),
    ]);
    expect(h.github.merges[0]!.commitMessage).toMatch(
      /^Oxagen-Approved-By: u_member\n/,
    );
  });

  it("lets an owner, or a merger holding merge_without_review, merge without an approval, and the trailer says nobody reviewed it", async () => {
    const owner = harness();
    const ownerPr = await opened(owner);
    owner.github.approvals = [];
    owner.roleOf.set(REVIEWER, { org: "Owner", workspace: null });
    const notAsked = vi.fn(async () => false);
    const byOwner = await createMergeContextPrHandler(owner, {
      holdsMergeWithoutReview: notAsked,
    })({ proposalId: ownerPr }, ctx({ userId: REVIEWER }));
    expect(byOwner.status).toBe("merged");
    // An Owner needs no grant, so the grant is never read.
    expect(notAsked).not.toHaveBeenCalled();
    expect(owner.github.merges[0]!.commitMessage).toContain(
      `Oxagen-Approved-By: none; merged without review by ${REVIEWER}\n`,
    );

    const h = harness();
    const id = await opened(h);
    h.github.approvals = [];
    const holds = vi.fn(
      async (_scope: unknown, userId: string) => userId === REVIEWER,
    );
    const out = await createMergeContextPrHandler(h, {
      holdsMergeWithoutReview: holds,
    })({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(holds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: SCOPE.workspaceId }),
      REVIEWER,
    );
    expect(h.github.merges[0]!.commitMessage).toContain(
      `merged without review by ${REVIEWER}`,
    );
  });

  it("records the publish as a deployment of the merge commit to the steering environment, and never calls publish() for the code repository", async () => {
    const h = harness();
    const id = await opened(h);
    const versionAt = vi.fn(async () => null);
    const highestVersion = vi.fn(async () => 40);
    const publish = vi.fn(
      async (): Promise<PublishResult> => ({
        status: "current",
        version: 41,
        commit: "0000000000000000000000000000000000000519",
      }),
    );
    const publisher = vi.fn(
      (): SteeringPublisher => unlockedPublisher({
        repository: () => BUNDLE_IDENTITY.repository,
        store: { versionAt, highestVersion },
        publish,
      }),
    );
    await createMergeContextPrHandler(h, {
      nextVersion: async () => 7,
      publisher,
    })({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(h.github.merges[0]!.commitMessage).toMatch(/\nOxagen-Version: 7$/);
    expect(h.github.deployments).toEqual([
      {
        sha: "0000000000000000000000000000000000000519",
        ref: "main",
        environment: "steering",
        description: "Steering version 7 from #519",
      },
    ]);
    // The legacy layout is the main code repository, which publish() skips,
    // so its version is the ledger's and S5's store is never read. The
    // publisher is not even built for it.
    expect(publisher).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(versionAt).not.toHaveBeenCalled();
    expect(highestVersion).not.toHaveBeenCalled();
  });

  it("still publishes when the host refuses the deployment record", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.deploymentRefused = true;
    const warn = vi.spyOn(logger, "warn");
    try {
      const out = await createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      );
      expect(out.status).toBe("merged");
      expect(h.store.ledger).toHaveLength(1);
      expect(h.github.deployments).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ sha: "0000000000000000000000000000000000000519", pr: 519 }),
        expect.stringContaining("refused the deployment record"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("brings the branch up to date when main moved after the checks passed, checks the new head again, and merges that head", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.commit("main", "README.md", "# Platform\n");
    const out = await createMergeContextPrHandler(h)(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );
    expect(out.status).toBe("merged");
    expect(h.github.updates).toEqual([
      { branch: BRANCH, from: "head1", to: "head3" },
    ]);
    expect(
      h.github.checkRuns.map((c) => [c.name, c.headSha, c.conclusion]),
    ).toEqual([
      ["Oxagen steering", "head1", "success"],
      ["Oxagen steering", "head3", "success"],
    ]);
    expect(h.github.merges).toEqual([
      expect.objectContaining({ number: 519, sha: "head3" }),
    ]);
    expect(h.store.proposals[0]).toMatchObject({
      status: "merged",
      headSha: "head3",
    });
    expect(h.store.records[0]!.commitSha).toBe("0000000000000000000000000000000000000519");
  });

  it("team mode: an approval does not carry to an updated head whose parents are not the approved head and the production branch tip", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.commit("main", "README.md", "# Platform\n");
    // The host answers the update with a commit whose second parent is an
    // older production commit, not the tip the queue asked it to merge.
    const update = h.github.updateBranch.bind(h.github);
    h.github.updateBranch = async (repo, args) => ({
      ...(await update(repo, args)),
      parents: [args.expectedHead, "base0"],
    });
    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "approval_required",
      message: expect.stringContaining("approves it at head3."),
    });
    // The only approval is the one at the head the author pushed.
    expect(await h.github.listApprovals(REPO, 519)).toEqual([
      expect.objectContaining({ userId: REVIEWER, commitSha: "head1" }),
    ]);
    expect(h.github.updates).toEqual([
      { branch: BRANCH, from: "head1", to: "head3" },
    ]);
    expect(h.github.merges).toHaveLength(0);
    expect(h.store.ledger).toHaveLength(0);
  });

  it("brings the branch up to date again when main moves during the re-check, and merges the head it checked last", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.commit("main", "README.md", "# Platform\n");
    // Main moves again right after the re-check reports on head3.
    const report = h.github.reportCheckRun.bind(h.github);
    let moved = false;
    h.github.reportCheckRun = async (repo, args) => {
      const url = await report(repo, args);
      if (!moved && args.headSha === "head3") {
        moved = true;
        h.github.commit("main", "CHANGELOG.md", "# Changes\n");
      }
      return url;
    };
    const out = await createMergeContextPrHandler(h)(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );
    expect(out.status).toBe("merged");
    expect(h.github.updates).toEqual([
      { branch: BRANCH, from: "head1", to: "head3" },
      { branch: BRANCH, from: "head3", to: "head5" },
    ]);
    expect(h.github.checkRuns.map((c) => [c.headSha, c.conclusion])).toEqual([
      ["head1", "success"],
      ["head3", "success"],
      ["head5", "success"],
    ]);
    expect(h.github.merges).toEqual([
      expect.objectContaining({ number: 519, sha: "head5" }),
    ]);
    expect(h.store.proposals[0]).toMatchObject({
      status: "merged",
      headSha: "head5",
    });
  });

  it("refuses checks_failed when the checks fail on the head brought up to date, and merges nothing", async () => {
    const h = harness();
    const constraint = (lineageId: string, effect: "forbid" | "require") => ({
      record: {
        lineageId,
        kind: "constraint",
        force: "must",
        constraintEffect: effect,
        sharingScope: "workspace",
        statement: "Never renumber a merged migration.",
      },
    });
    const forbidId = await opened(
      h,
      constraint("ctx.platform.migration-order", "forbid"),
    );
    const requireId = await opened(
      h,
      constraint("ctx.platform.migration-renumber", "require"),
    );
    const merge = createMergeContextPrHandler(h);
    await merge({ proposalId: requireId }, ctx({ userId: REVIEWER }));

    // main now holds the require constraint, so the forbid on the same
    // statement fails when it is checked again.
    await expect(
      merge({ proposalId: forbidId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "checks_failed",
      message: expect.stringContaining(
        "brought steering/ctx.platform.migration-order up to date",
      ),
    });
    const row = h.store.proposals.find((p) => p.publicId === forbidId)!;
    expect(row.status).toBe("checks_failed");
    expect(row.headSha).toBe(h.github.updates[0]!.to);
    expect(
      row.checks.find((c) => c.name === "conflict_against_active"),
    ).toMatchObject({
      status: "failed",
      summary: expect.stringContaining(
        "ctx.platform.migration-renumber is an active require",
      ),
    });
    expect(h.github.checkRuns.at(-1)).toMatchObject({
      name: "Oxagen steering",
      headSha: h.github.updates[0]!.to,
      conclusion: "failure",
    });
    expect(h.github.merges.map((m) => m.number)).toEqual([520]);
    expect(h.store.ledger).toHaveLength(1);
  });

  it("merges two PRs in the order they were queued: the second waits, then is brought up to date with the first and checked again", async () => {
    const h = harness();
    const a = await opened(h);
    const b = await opened(h, {
      record: {
        ...proposalInput().record,
        lineageId: "ctx.release.cache-readme",
        statement: "Do not re-read README.md more than once in a run.",
      },
    });
    const merge = createMergeContextPrHandler(h);
    const [first, second] = await Promise.all([
      merge({ proposalId: a }, ctx({ userId: REVIEWER })),
      merge({ proposalId: b }, ctx({ userId: REVIEWER })),
    ]);
    expect(first.bundleVersion).toEqual({ before: 0, after: 1 });
    expect(second.bundleVersion).toEqual({ before: 1, after: 2 });
    expect(h.github.merges.map((m) => [m.number, m.sha])).toEqual([
      [519, "head1"],
      [520, "head3"],
    ]);
    expect(h.github.updates).toEqual([
      {
        branch: "steering/ctx.release.cache-readme",
        from: "head2",
        to: "head3",
      },
    ]);
    // The version is read inside the queue, after the first merge landed.
    expect(h.github.merges[1]!.commitMessage).toMatch(/\nOxagen-Version: 2$/);
    expect(h.store.ledger).toHaveLength(2);
  });

  it("in a steering repo, fails the one required check when the branch changes a path outside its folder", async () => {
    const h = steeringHarness();
    const id = await proposed(h);
    const out = await createOpenContextPrHandler(h)({ proposalId: id }, ctx());
    expect(out.status).toBe("checks_failed");
    expect(out.checks.find((c) => c.name === "schema")).toMatchObject({
      status: "failed",
      summary: expect.stringContaining(
        `${PATH} is outside every folder a steering PR may change`,
      ),
    });
    expect(h.github.checkRuns).toEqual([
      expect.objectContaining({
        name: "Oxagen steering",
        headSha: "head1",
        conclusion: "failure",
      }),
    ]);
  });

  /**
   * A steering-repo PR whose row passed. The proposal writer still writes
   * .oxagen/rules/, which a steering repo refuses (the test above), so the
   * branch is rewritten into a steering record and the row marked passed.
   */
  async function steeringPrPassed(h: Harness) {
    const id = await proposed(h);
    await createOpenContextPrHandler(h)({ proposalId: id }, ctx());
    const recordAt = `steering/platform/${LINEAGE}.md`;
    h.github.remove(BRANCH, PATH);
    const head = h.github.commit(BRANCH, recordAt, steeringRecord(LINEAGE));
    const row = h.store.proposals[0]!;
    Object.assign(row, {
      status: "checks_passed",
      headSha: head,
      path: recordAt,
      checks: row.checks.map((c) => ({ ...c, status: "passed" })),
    });
    return { id, head, recordAt };
  }

  /**
   * Fails the first registry write once, so the host has merged and the
   * registry has not: the state a retry resumes from.
   */
  function failFirstRegistryWrite(h: Harness) {
    const original = h.store.publishMerge.bind(h.store);
    let fail = true;
    h.store.publishMerge = async (input) => {
      if (fail) {
        fail = false;
        throw new Error("connection reset");
      }
      return original(input);
    };
  }

  /** Moves the production branch on to `sha`, a later commit with the same tree. */
  function advanceProduction(h: Harness, sha: string) {
    const from = h.github.heads.get(REPO.defaultBranch)!;
    for (const [key, text] of [...h.github.files])
      if (key.startsWith(`${from}:`))
        h.github.files.set(`${sha}:${key.slice(from.length + 1)}`, text);
    h.github.heads.set(REPO.defaultBranch, sha);
  }

  it("in a steering repo, stamps the checked head, posts the required check on the stamp, merges the stamp, and calls publish() with the merge commit", async () => {
    const h = steeringHarness();
    const { id, head, recordAt } = await steeringPrPassed(h);
    const s5 = s5Publisher();
    const publisher = vi.fn(() => s5.publisher);
    const out = await createMergeContextPrHandler(h, { publisher })(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );

    expect(out.status).toBe("merged");
    // The publisher is built for the caller's workspace, over its host.
    expect(publisher).toHaveBeenCalledWith(SCOPE, h.github);
    expect(h.github.stamps).toHaveLength(1);
    const stamp = h.github.stamps[0]!;
    expect(stamp).toMatchObject({ branch: BRANCH, parent: head });
    expect(stamp.files.map((f) => f.path)).toEqual([
      recordAt,
      "steering/promotions/2026-09.jsonl",
    ]);
    expect(h.github.checkRuns.at(-1)).toMatchObject({
      name: "Oxagen steering",
      headSha: stamp.sha,
      conclusion: "success",
    });
    expect(h.github.merges).toEqual([
      expect.objectContaining({ number: 519, sha: stamp.sha }),
    ]);
    // The row follows the stamp, and the registry holds the stamped bytes.
    expect(h.store.proposals[0]!.headSha).toBe(stamp.sha);
    expect(h.store.versions[0]!.body).toBe(
      await h.github.readFile(REPO, recordAt, stamp.sha),
    );
    expect(s5.publish).toHaveBeenCalledTimes(1);
    expect(s5.publish).toHaveBeenCalledWith(REPO, "0000000000000000000000000000000000000519");
    expect(h.github.deployments).toEqual([
      expect.objectContaining({ sha: "0000000000000000000000000000000000000519", environment: "steering" }),
    ]);
  });

  it("in a steering repo, stamps the version S5's publish() assigns into the Oxagen-Version trailer", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const s5 = s5Publisher();
    // Version 1 is an earlier commit, published before this merge.
    s5.tip.head = "5eed000000000000000000000000000000000000";
    await expect(
      publishBundle(s5.deps, BUNDLE_IDENTITY, "5eed000000000000000000000000000000000000"),
    ).resolves.toMatchObject({ status: "published", version: 1 });
    s5.tip.head = "0000000000000000000000000000000000000519";

    const out = await createMergeContextPrHandler(h, {
      nextVersion: async () => 99,
      publisher: () => s5.publisher,
    })({ proposalId: id }, ctx({ userId: REVIEWER }));

    expect(out.status).toBe("merged");
    expect(h.github.merges[0]!.commitMessage).toMatch(/\nOxagen-Version: 2$/);
    await expect(s5.publish.mock.results[0]!.value).resolves.toMatchObject({
      status: "published",
      version: 2,
      commit: "0000000000000000000000000000000000000519",
    });
    expect(s5.store.published.get(BUNDLE_IDENTITY.repository)).toMatchObject({
      version: 2,
      commit: "0000000000000000000000000000000000000519",
    });
    expect(h.github.deployments).toEqual([
      expect.objectContaining({
        sha: "0000000000000000000000000000000000000519",
        description: "Steering version 2 from #519",
      }),
    ]);
  });

  it("in a steering repo, holds the version store's lock from the version read through publish(), so a sync during the landing cannot take the trailer's version", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const s5 = s5Publisher();
    // Version 1 is an earlier commit, published before this merge.
    s5.tip.head = "5eed000000000000000000000000000000000000";
    await publishBundle(
      s5.deps,
      BUNDLE_IDENTITY,
      "5eed000000000000000000000000000000000000",
    );
    s5.tip.head = "0000000000000000000000000000000000000519";

    // While the stamp lands, the production branch reads another commit and
    // the repository sync publishes it. Unless the merge holds the lock, the
    // sync takes version 2, the version already in the merge's trailer.
    const side = "51de000000000000000000000000000000000000";
    const commitFiles = h.github.commitFiles.bind(h.github);
    let sync: Promise<PublishResult> | null = null;
    let first: string | null = null;
    h.github.commitFiles = async (repo, args) => {
      const out = await commitFiles(repo, args);
      if (sync === null) {
        s5.tip.head = side;
        const started = publishBundle(s5.deps, BUNDLE_IDENTITY, side);
        sync = started;
        first = await Promise.race([
          started.then(() => "sync"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("landing"), 50),
          ),
        ]);
        s5.tip.head = "0000000000000000000000000000000000000519";
      }
      return out;
    };
    const out = await createMergeContextPrHandler(h, {
      publisher: () => s5.publisher,
    })({ proposalId: id }, ctx({ userId: REVIEWER }));

    // The sync waited for the merge's lock.
    expect(first).toBe("landing");
    expect(out.status).toBe("merged");
    expect(h.github.merges[0]!.commitMessage).toMatch(/\nOxagen-Version: 2$/);
    expect(s5.store.published.get(BUNDLE_IDENTITY.repository)).toMatchObject({
      version: 2,
      commit: "0000000000000000000000000000000000000519",
    });
    // Once the merge let go, the sync found its commit was no longer the
    // production branch's head.
    await expect(sync).resolves.toMatchObject({ status: "stale", commit: side });
    expect(h.github.deployments).toEqual([
      expect.objectContaining({
        description: "Steering version 2 from #519",
      }),
    ]);
  });

  it("in a steering repo, refuses publish_in_progress before claiming or merging when another publish holds the lock", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const publish = vi.fn(
      async (): Promise<PublishResult> => ({
        status: "current",
        version: 1,
        commit: "0000000000000000000000000000000000000519",
      }),
    );
    const held = vi.fn(async () => {
      throw new HandlerError({
        code: "conflict",
        reason: "publish_in_progress",
        message:
          "Another publish of github.com/a-intel/oxagen-core-platform held its lock for over 60 seconds. The next sync publishes it again.",
      });
    });
    await expect(
      createMergeContextPrHandler(h, {
        publisher: () => ({
          repository: () => BUNDLE_IDENTITY.repository,
          store: {
            versionAt: async () => null,
            highestVersion: async () => 0,
          },
          publish,
          withLock: held,
        }),
      })({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "publish_in_progress",
      message: expect.stringContaining("so nothing merged. Merge again"),
    });
    expect(held).toHaveBeenCalledTimes(1);
    expect(h.github.stamps).toHaveLength(0);
    expect(h.github.merges).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(h.store.proposals[0]).toMatchObject({
      status: "checks_passed",
      mergeClaimedAt: null,
    });
  });

  it("in a steering repo, refuses version_mismatch when publish() assigns a version other than the trailer's, before the deployment and the event", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const publish = vi.fn(
      async (): Promise<PublishResult> => ({
        status: "current",
        version: 6,
        commit: "0000000000000000000000000000000000000519",
      }),
    );
    await expect(
      createMergeContextPrHandler(h, {
        publisher: () => unlockedPublisher({
          repository: () => BUNDLE_IDENTITY.repository,
          store: {
            versionAt: async () => null,
            highestVersion: async () => 4,
          },
          publish,
        }),
      })({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "version_mismatch",
      message: expect.stringContaining(
        "with Oxagen-Version: 5, but publish() assigned version 6.",
      ),
    });
    // The merge landed and the registry holds it; nothing repeats the
    // wrong number.
    expect(h.github.merges[0]!.commitMessage).toMatch(/\nOxagen-Version: 5$/);
    expect(h.store.proposals[0]!.status).toBe("merged");
    expect(h.store.ledger).toHaveLength(1);
    expect(h.github.deployments).toHaveLength(0);
    expect(h.events.map((e) => e.eventType)).not.toContain(
      "steering.published",
    );
  });

  it("in a steering repo, a stale commit from publish() is logged, the merge stands, and no deployment names it", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const warn = vi.spyOn(logger, "warn");
    try {
      const out = await createMergeContextPrHandler(h, {
        publisher: () => unlockedPublisher({
          repository: () => BUNDLE_IDENTITY.repository,
          store: {
            versionAt: async () => null,
            highestVersion: async () => 0,
          },
          publish: async () => ({
            status: "stale",
            commit: "0000000000000000000000000000000000000519",
            head: "0000000000000000000000000000000000000520",
          }),
        }),
      })({ proposalId: id }, ctx({ userId: REVIEWER }));
      expect(out.status).toBe("merged");
      expect(h.store.ledger).toHaveLength(1);
      // Version 1 never went live, so no deployment names it.
      expect(h.github.deployments).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ commit: "0000000000000000000000000000000000000519", version: 1 }),
        expect.stringContaining("publish() answered stale"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("in a steering repo, a resumed merge keeps the version S5 published for its merge commit between the two calls", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const s5 = s5Publisher();
    failFirstRegistryWrite(h);
    const merge = createMergeContextPrHandler(h, {
      publisher: () => s5.publisher,
    });
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");
    expect(h.github.merges[0]!.commitMessage).toMatch(/\nOxagen-Version: 1$/);
    expect(s5.publish).not.toHaveBeenCalled();
    // The host merged, so the claim stays for the retry.
    expect(h.store.proposals[0]!.mergeClaimedAt).not.toBeNull();

    // S5's sync publishes the merge commit before the retry, so the store's
    // highest version is now the one in the trailer.
    await expect(
      publishBundle(s5.deps, BUNDLE_IDENTITY, "0000000000000000000000000000000000000519"),
    ).resolves.toMatchObject({ status: "published", version: 1 });

    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(h.github.merges).toHaveLength(1);
    expect(h.store.proposals[0]!.mergeClaimedAt).toBeNull();
    // The retry keeps version 1 and does not publish the commit again.
    expect(s5.publish).not.toHaveBeenCalled();
    expect(s5.store.published.get(BUNDLE_IDENTITY.repository)).toMatchObject({
      version: 1,
      commit: "0000000000000000000000000000000000000519",
    });
    expect(h.github.deployments).toEqual([
      expect.objectContaining({
        sha: "0000000000000000000000000000000000000519",
        description: "Steering version 1 from #519",
      }),
    ]);
    expect(h.events.map((e) => e.eventType)).toContain("steering.published");
  });

  it("in a steering repo, a resumed merge keeps its published version after a later merge was published", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const s5 = s5Publisher();
    failFirstRegistryWrite(h);
    const merge = createMergeContextPrHandler(h, {
      publisher: () => s5.publisher,
    });
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");

    // Before the retry, S5's sync publishes this merge as version 1, and a
    // later merge on the host as version 2.
    await expect(
      publishBundle(
        s5.deps,
        BUNDLE_IDENTITY,
        "0000000000000000000000000000000000000519",
      ),
    ).resolves.toMatchObject({ status: "published", version: 1 });
    advanceProduction(h, LATER);
    s5.tip.head = LATER;
    await expect(
      publishBundle(s5.deps, BUNDLE_IDENTITY, LATER),
    ).resolves.toMatchObject({ status: "published", version: 2 });

    // The published version is the later merge's, and the retry still finds
    // version 1 for its own commit.
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(s5.publish).not.toHaveBeenCalled();
    expect(h.store.ledger).toHaveLength(1);
    expect(s5.store.published.get(BUNDLE_IDENTITY.repository)).toMatchObject({
      version: 2,
      commit: LATER,
    });
    expect(h.github.deployments).toEqual([
      expect.objectContaining({
        sha: "0000000000000000000000000000000000000519",
        description: "Steering version 1 from #519",
      }),
    ]);
  });

  it("in a steering repo, refuses version_superseded when a resumed merge was never published and production moved on", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const s5 = s5Publisher();
    const requestSync = vi.fn(
      async (_scope: { orgId: string; workspaceId: string }) => undefined,
    );
    h.requestSync = requestSync;
    failFirstRegistryWrite(h);
    const merge = createMergeContextPrHandler(h, {
      publisher: () => s5.publisher,
    });
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");
    expect(h.github.merges[0]!.commitMessage).toMatch(/\nOxagen-Version: 1$/);
    expect(h.store.proposals[0]!.mergeClaimedAt).not.toBeNull();

    // A later merge lands on the host before the retry, and S5's sync
    // publishes it as version 1: the number in this merge's trailer.
    advanceProduction(h, LATER);
    s5.tip.head = LATER;
    await expect(
      publishBundle(s5.deps, BUNDLE_IDENTITY, LATER),
    ).resolves.toMatchObject({ status: "published", version: 1 });

    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "version_superseded",
      message: expect.stringContaining(`has moved on to ${LATER} since`),
    });
    expect(requestSync).toHaveBeenCalledWith(SCOPE);
    // The sync links this merge, so the refusal released the claim.
    expect(h.store.proposals[0]!.mergeClaimedAt).toBeNull();
    // Nothing records version 1 a second time.
    expect(s5.publish).not.toHaveBeenCalled();
    expect(h.store.ledger).toHaveLength(0);
    expect(h.store.proposals[0]!.status).not.toBe("merged");
    expect(h.github.deployments).toHaveLength(0);
    expect(h.events.map((e) => e.eventType)).not.toContain(
      "steering.published",
    );

    // A sync request that fails is logged, and the refusal stands.
    requestSync.mockRejectedValueOnce(new Error("queue unreachable"));
    const warn = vi.spyOn(logger, "warn");
    try {
      await expect(
        merge({ proposalId: id }, ctx({ userId: REVIEWER })),
      ).rejects.toMatchObject({ reason: "version_superseded" });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ proposal: h.store.proposals[0]!.publicId }),
        expect.stringContaining("could not request a sync"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("in a steering repo, a resumed merge whose version was stored and never published takes the next version, and logs it", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    failFirstRegistryWrite(h);
    const store = {
      versionAt: vi.fn(async (): Promise<StoredVersion | null> => null),
      highestVersion: vi.fn(async () => 0),
    };
    const publish = vi.fn(
      async (): Promise<PublishResult> => ({
        status: "current",
        version: 2,
        commit: "0000000000000000000000000000000000000519",
      }),
    );
    const merge = createMergeContextPrHandler(h, {
      publisher: () => unlockedPublisher({
        repository: () => BUNDLE_IDENTITY.repository,
        store,
        publish,
      }),
    });
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toThrow("connection reset");
    expect(h.github.merges[0]!.commitMessage).toMatch(/\nOxagen-Version: 1$/);

    // put() stored version 1 at the merge commit, and setPublished() never
    // switched to it. The production branch is still at the merge commit.
    store.versionAt.mockResolvedValue({ version: 1, published: false });
    store.highestVersion.mockResolvedValue(1);
    const warn = vi.spyOn(logger, "warn");
    try {
      const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
      expect(out.status).toBe("merged");
      expect(store.versionAt).toHaveBeenCalledWith(
        BUNDLE_IDENTITY.repository,
        "0000000000000000000000000000000000000519",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          commit: "0000000000000000000000000000000000000519",
          stored: 1,
        }),
        expect.stringContaining("stored and never published"),
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(h.github.deployments).toEqual([
        expect.objectContaining({
          description: "Steering version 2 from #519",
        }),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("in a steering repo, a failed publish() is logged, the merge stands, and no deployment names it", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const publish = vi.fn(async (): Promise<PublishResult> => {
      throw new Error("bundle store unreachable");
    });
    const warn = vi.spyOn(logger, "warn");
    try {
      const out = await createMergeContextPrHandler(h, {
        publisher: () => unlockedPublisher({
          repository: () => BUNDLE_IDENTITY.repository,
          store: {
            versionAt: async () => null,
            highestVersion: async () => 0,
          },
          publish,
        }),
      })({ proposalId: id }, ctx({ userId: REVIEWER }));
      expect(out.status).toBe("merged");
      expect(h.store.proposals[0]!.status).toBe("merged");
      expect(h.github.deployments).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ commit: "0000000000000000000000000000000000000519" }),
        expect.stringContaining("publish() failed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // ── The merge claim (#4504) ────────────────────────────────────────────────

  it("in a steering repo, refuses a check rerun and a dismissal while the stamp lands, and the merge publishes", async () => {
    const h = steeringHarness();
    const { id } = await steeringPrPassed(h);
    const s5 = s5Publisher();
    // The stamp commit is the PR's head from here until the host merges it.
    // A rerun and a dismissal arrive in that window.
    const commitFiles = h.github.commitFiles.bind(h.github);
    const during: unknown[] = [];
    let claimDuringLanding: Date | null = null;
    let once = true;
    h.github.commitFiles = async (repo, args) => {
      const out = await commitFiles(repo, args);
      if (once) {
        once = false;
        claimDuringLanding = h.store.proposals[0]!.mergeClaimedAt;
        during.push(
          await createOpenContextPrHandler(h)({ proposalId: id }, ctx()).catch(
            (e: unknown) => e,
          ),
          await createDismissProposalHandler(h)(
            { proposalId: id, reason: "superseded" },
            ctx(),
          ).catch((e: unknown) => e),
        );
      }
      return out;
    };
    const out = await createMergeContextPrHandler(h, {
      publisher: () => s5.publisher,
    })({ proposalId: id }, ctx({ userId: REVIEWER }));

    expect(claimDuringLanding).toBeInstanceOf(Date);
    expect(during).toHaveLength(2);
    for (const refusal of during)
      expect(refusal).toMatchObject({
        code: "conflict",
        reason: "merge_in_progress",
      });
    expect(out.status).toBe("merged");
    expect(h.github.merges).toHaveLength(1);
    expect(h.store.proposals[0]).toMatchObject({
      status: "merged",
      mergeClaimedAt: null,
      dismissedAt: null,
    });
  });

  it("refuses a merge, a check rerun, and a dismissal while another merge's claim stands, and touches nothing until it lapses", async () => {
    const h = harness();
    const id = await opened(h);
    const claimedAt = h.now();
    Object.assign(h.store.proposals[0]!, { mergeClaimedAt: claimedAt });
    const lapses = new Date(
      claimedAt.getTime() + MERGE_CLAIM_SECONDS * 1000,
    ).toISOString();
    const refusal = {
      code: "conflict",
      reason: "merge_in_progress",
      message: expect.stringContaining(lapses),
    };
    const checkRuns = h.github.checkRuns.length;

    await expect(
      createMergeContextPrHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject(refusal);
    await expect(
      createOpenContextPrHandler(h)({ proposalId: id }, ctx()),
    ).rejects.toMatchObject(refusal);
    await expect(
      createDismissProposalHandler(h)(
        { proposalId: id, reason: "superseded" },
        ctx(),
      ),
    ).rejects.toMatchObject(refusal);
    expect(h.github.merges).toHaveLength(0);
    expect(h.github.pulls[0]!.state).toBe("open");
    expect(h.github.deletedBranches).toEqual([]);
    expect(h.github.checkRuns).toHaveLength(checkRuns);
    expect(h.store.proposals[0]).toMatchObject({
      status: "checks_passed",
      mergeClaimedAt: claimedAt,
    });

    // A claim older than MERGE_CLAIM_SECONDS has lapsed, and blocks nothing.
    Object.assign(h.store.proposals[0]!, {
      mergeClaimedAt: new Date(
        h.now().getTime() - (MERGE_CLAIM_SECONDS + 1) * 1000,
      ),
    });
    const rerun = await createOpenContextPrHandler(h)(
      { proposalId: id },
      ctx(),
    );
    expect(rerun.status).toBe("checks_passed");
    const out = await createMergeContextPrHandler(h)(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );
    expect(out.status).toBe("merged");
    expect(h.store.proposals[0]!.mergeClaimedAt).toBeNull();
    expect(h.github.merges).toHaveLength(1);
  });

  it("releases the claim when the host refuses the merge, so a retry can land it", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.mergeRefusedWith = "At least 1 approving review is required";
    const claims: (Date | null)[] = [];
    const mergePullRequest = h.github.mergePullRequest.bind(h.github);
    h.github.mergePullRequest = async (repo, args) => {
      claims.push(h.store.proposals[0]!.mergeClaimedAt);
      return mergePullRequest(repo, args);
    };
    const merge = createMergeContextPrHandler(h);
    await expect(
      merge({ proposalId: id }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ code: "conflict", reason: "github_refused" });
    // The merge held the claim while it called the host, and released it.
    expect(claims[0]).toBeInstanceOf(Date);
    expect(h.store.proposals[0]).toMatchObject({
      status: "checks_passed",
      mergeClaimedAt: null,
    });

    h.github.mergeRefusedWith = null;
    const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(out.status).toBe("merged");
    expect(h.github.merges).toHaveLength(1);
  });

  it("keeps the claim when the host merged and the call failed, and a retry publishes the merge", async () => {
    const h = harness();
    const id = await opened(h);
    const publicId = h.store.proposals[0]!.publicId;
    const mergePullRequest = h.github.mergePullRequest.bind(h.github);
    h.github.mergePullRequest = async (repo, args) => {
      await mergePullRequest(repo, args);
      throw new Error("socket hang up");
    };
    const merge = createMergeContextPrHandler(h);
    const warn = vi.spyOn(logger, "warn");
    try {
      await expect(
        merge({ proposalId: id }, ctx({ userId: REVIEWER })),
      ).rejects.toThrow("socket hang up");
      expect(h.store.proposals[0]!.status).toBe("checks_passed");
      expect(h.store.proposals[0]!.mergeClaimedAt).toBeInstanceOf(Date);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ proposal: publicId, pr: 519 }),
        expect.stringContaining("the host merged the pull request"),
      );

      // The retry reads the merged PR at the checked head and resumes.
      h.github.mergePullRequest = mergePullRequest;
      const out = await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
      expect(out.status).toBe("merged");
      expect(h.store.proposals[0]!.mergeClaimedAt).toBeNull();
      expect(h.github.merges).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the claim when the landing failed and the PR could not be read, and logs it", async () => {
    const h = harness();
    const id = await opened(h);
    const publicId = h.store.proposals[0]!.publicId;
    let broken = false;
    h.github.mergePullRequest = async () => {
      broken = true;
      throw new Error("connection refused");
    };
    const getPullRequest = h.github.getPullRequest.bind(h.github);
    h.github.getPullRequest = async (repo, number) => {
      if (broken) throw new Error("connection refused");
      return getPullRequest(repo, number);
    };
    const merge = createMergeContextPrHandler(h);
    const warn = vi.spyOn(logger, "warn");
    try {
      await expect(
        merge({ proposalId: id }, ctx({ userId: REVIEWER })),
      ).rejects.toThrow("connection refused");
      expect(h.store.proposals[0]!.mergeClaimedAt).toBeInstanceOf(Date);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ proposal: publicId, pr: 519 }),
        expect.stringContaining("could not be read"),
      );

      // The host answers again, and the claim still holds the proposal.
      broken = false;
      await expect(
        merge({ proposalId: id }, ctx({ userId: REVIEWER })),
      ).rejects.toMatchObject({ reason: "merge_in_progress" });
      expect(h.github.merges).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a claim it could not release, and the host's refusal reaches the caller", async () => {
    const h = harness();
    const id = await opened(h);
    const publicId = h.store.proposals[0]!.publicId;
    h.github.mergeRefusedWith = "At least 1 approving review is required";
    const updateProposal = h.store.updateProposal.bind(h.store);
    h.store.updateProposal = async (rowId, patch, from, guard) => {
      if (patch.mergeClaimedAt === null)
        throw new Error("connection reset");
      return updateProposal(rowId, patch, from, guard);
    };
    const warn = vi.spyOn(logger, "warn");
    try {
      await expect(
        createMergeContextPrHandler(h)(
          { proposalId: id },
          ctx({ userId: REVIEWER }),
        ),
      ).rejects.toMatchObject({ reason: "github_refused" });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ proposal: publicId }),
        expect.stringContaining("could not release the merge claim"),
      );
      expect(h.store.proposals[0]!.mergeClaimedAt).toBeInstanceOf(Date);
    } finally {
      warn.mockRestore();
    }
  });
});
