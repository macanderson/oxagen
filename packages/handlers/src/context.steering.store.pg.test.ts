// The Postgres steering store against a real migrated database (ADR-061):
// the publication transaction, the idempotent append, the one-open-PR-per-
// lineage index, and the tenant policies on the two new tables. Runs wherever
// DATABASE_URL points at a migrated database — CI's `test` job migrates
// Postgres with Atlas before `turbo run build test:unit` and carries
// DATABASE_URL in turbo's globalEnv; a local run without one is skipped, not
// red. Every row it writes is removed in afterAll.
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { steeringRecordLabel } from "@oxagen/oxagen/steering-record-label";
import { runInTenantScope } from "@oxagen/tenancy";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  postgresSteeringStore as store,
  type ProposalRow,
} from "./context.steering.store";
import { LEGACY_RECORD_SCHEMA } from "@oxagen/oxagen/steering-repo/paths";
import { buildRecordFile, serializeRecordFile } from "./context.steering.file";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("steering store against Postgres", () => {
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const otherWorkspace = crypto.randomUUID();
  // The concurrency test merges twice, and the promotions ledger is counted
  // per workspace: run it in a workspace of its own so its two rows do not
  // move the ledger the publish test asserts from zero. Cleaned up with the
  // rest below.
  const concurrentWorkspace = crypto.randomUUID();
  // The label test merges three times: a workspace of its own, for the same
  // reason.
  const labelWorkspace = crypto.randomUUID();
  // The steering PR test retires a record and counts its ledger: a workspace
  // of its own too (#5122).
  const revertWorkspace = crypto.randomUUID();
  const scope = { orgId, workspaceId };
  const concurrentScope = { orgId, workspaceId: concurrentWorkspace };
  const userId = crypto.randomUUID();
  const tag = workspaceId.slice(0, 8);
  const lineage = `ctx.g2961.${tag}`;
  const inScope = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const records = await tx
        .select({ id: schema.steeringRecords.id })
        .from(schema.steeringRecords)
        .where(
          inArray(schema.steeringRecords.workspaceId, [
            workspaceId,
            otherWorkspace,
            concurrentWorkspace,
            labelWorkspace,
            revertWorkspace,
          ]),
        );
      const ids = records.map((r) => r.id);
      if (ids.length > 0) {
        await tx
          .delete(schema.steeringPromotions)
          .where(inArray(schema.steeringPromotions.recordId, ids));
        await tx
          .update(schema.steeringRecords)
          .set({ activeVersionId: null })
          .where(inArray(schema.steeringRecords.id, ids));
        await tx
          .delete(schema.steeringRecordVersions)
          .where(inArray(schema.steeringRecordVersions.recordId, ids));
        await tx
          .delete(schema.steeringRecords)
          .where(inArray(schema.steeringRecords.id, ids));
      }
      await tx
        .delete(schema.contextAppends)
        .where(
          inArray(schema.contextAppends.workspaceId, [
            workspaceId,
            otherWorkspace,
            concurrentWorkspace,
            labelWorkspace,
            revertWorkspace,
          ]),
        );
      await tx
        .delete(schema.steeringProposals)
        .where(
          inArray(schema.steeringProposals.workspaceId, [
            workspaceId,
            otherWorkspace,
            concurrentWorkspace,
            labelWorkspace,
            revertWorkspace,
          ]),
        );
    });
    await closeDatabase();
  });

  const proposeIn = (
    where: { orgId: string; workspaceId: string },
    over: Partial<ProposalRow> = {},
  ) =>
    runInTenantScope(where, () =>
      store.insertProposal({
        orgId: where.orgId,
        workspaceId: where.workspaceId,
        lineageId: lineage,
        kind: "rule",
        force: "should",
        constraintEffect: null,
        sharingScope: "workspace",
        statement: "Do not re-read CHANGELOG.md more than once in a run.",
        rationale: "682 duplicate tool calls across 212 runs.",
        source: `user:${userId}`,
        supportRuns: ["run_1"],
        supportAgents: [],
        supportingRecordIds: [],
        evidenceLinks: [],
        createdById: userId,
        ...over,
      }),
    );

  const propose = (over: Partial<ProposalRow> = {}) => proposeIn(scope, over);

  it("serializes clone lineage creation and keeps rejected proposals occupied", async () => {
    const seed = await propose({ lineageId: `${lineage}.clone-source` });
    const { id: _id, publicId: _publicId, ...values } = seed;
    const cloneValues = {
      ...values,
      lineageId: `${lineage}.cloned`,
      title: "Cloned record",
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        inScope(() => store.insertProposal(cloneValues, { createOnly: true })),
      ),
    );
    const created = results.filter((result) => result.status === "fulfilled");
    expect(created).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ reason: "clone_name_taken" });
    await withSystemDb((tx) =>
      tx
        .update(schema.steeringProposals)
        .set({ status: "rejected" })
        .where(eq(schema.steeringProposals.lineageId, cloneValues.lineageId)),
    );
    await expect(
      inScope(() => store.insertProposal(cloneValues, { createOnly: true })),
    ).rejects.toMatchObject({ reason: "clone_name_taken" });
    expect(seed.lineageId).toBe(`${lineage}.clone-source`);
  });

  it("makes ordinary proposals acquire the same lineage lock as clones", async () => {
    const seed = await propose({ lineageId: `${lineage}.mixed-source` });
    const { id: _id, publicId: _publicId, ...values } = seed;
    const mixed = { ...values, lineageId: `${lineage}.mixed-clone` };
    const lockKey = `${workspaceId}:${mixed.lineageId}`;
    let ordinary: Promise<ProposalRow> | undefined;
    try {
      await withSystemDb(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
        );
        ordinary = inScope(() => store.insertProposal(mixed));
        await Promise.race([
          vi.waitFor(
            async () => {
              const rows = await tx.execute(
                sql`select count(*)::int as waiting from pg_locks where locktype='advisory' and not granted and classid=((hashtextextended(${lockKey},0) >> 32) & 4294967295)::oid and objid=(hashtextextended(${lockKey},0) & 4294967295)::oid`,
              );
              expect(rows[0]?.waiting).toBe(1);
            },
            { timeout: 5000 },
          ),
          ordinary.then(() => {
            throw new Error("Ordinary proposal skipped the lineage lock");
          }),
        ]);
      });
    } finally {
      await ordinary;
    }
    await expect(
      inScope(() => store.insertProposal(mixed, { createOnly: true })),
    ).rejects.toMatchObject({ reason: "clone_name_taken" });
    const rows = await inScope(() =>
      store.listProposals(
        scope,
        { lineageId: mixed.lineageId },
        { limit: 10, offset: 0 },
      ),
    );
    expect(rows.total).toBe(1);
  });

  // `publishMerge` takes ROW EXCLUSIVE on the version table before probing for
  // the classification columns, so the migration's ACCESS EXCLUSIVE cannot
  // commit between the probe and the insert. ROW EXCLUSIVE does not conflict
  // with itself, so the lock must NOT serialize merges against each other --
  // that is the regression the fix could have introduced, and it is what this
  // asserts: two merges on different lineages, started together, both complete.
  // A self-conflicting lock mode would deadlock or block here, not just slow
  // down, because each holds its lock to commit.
  it("does not serialize concurrent merges on different lineages", async () => {
    const inConcurrentScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope(concurrentScope, fn);
    const merge = async (suffix: string) => {
      const proposal = await proposeIn(concurrentScope, {
        lineageId: `${lineage}.${suffix}`,
      });
      const opened = await inConcurrentScope(() =>
        store.updateProposal(
          proposal.id,
          {
            status: "checks_passed",
            repository: "a-intel/platform",
            baseRef: "main",
            branch: `context/${lineage}.${suffix}`,
            path: `.oxagen/rules/${lineage}.${suffix}.toml`,
            provider: "github",
            prNumber: 900,
            prUrl: "https://github.com/a-intel/platform/pull/900",
            headSha: "dee9001",
            stampedRecordId: `rec_${suffix}`,
            recordHash: `sha256:${suffix.repeat(64).slice(0, 64)}`,
          },
          ["proposed"],
        ),
      );
      return inConcurrentScope(() =>
        store.publishMerge({
          scope: concurrentScope,
          proposal: opened,
          body: `schema = "${LEGACY_RECORD_SCHEMA}"\n`,
          checksum: suffix.repeat(64).slice(0, 64),
          commitSha: `c0ffee${suffix}`,
          path: opened.path!,
          mergedAt: new Date("2026-09-18T12:00:00.000Z"),
          mergedByUserId: userId,
          policyVersion: "governance:team",
        }),
      );
    };

    const [a, b] = await Promise.all([merge("a"), merge("b")]);
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    // Both wrote their own record and their own ledger row.
    expect(a.recordId).not.toBe(b.recordId);
    expect(new Set([a.promotion.seq, b.promotion.seq])).toEqual(new Set([1]));
    expect(
      await inConcurrentScope(() => store.ledgerLength(concurrentScope)),
    ).toBe(2);
  });

  it("publishes a merge in one transaction: record, version, promotion event, proposal merged; a repeat rolls back; a second merge is version 2 and chain seq 2", async () => {
    const proposal = await propose();
    const opened = await inScope(() =>
      store.updateProposal(
        proposal.id,
        {
          status: "checks_passed",
          repository: "a-intel/platform",
          baseRef: "main",
          branch: `context/${lineage}`,
          path: `.oxagen/rules/${lineage}.toml`,
          provider: "github",
          prNumber: 519,
          prUrl: "https://github.com/a-intel/platform/pull/519",
          headSha: "abc1234",
          stampedRecordId: "rec_x",
          recordHash: `sha256:${"a".repeat(64)}`,
        },
        ["proposed"],
      ),
    );
    const mergedAt = new Date("2026-09-15T09:16:40.000Z");
    const first = await inScope(() =>
      store.publishMerge({
        scope,
        proposal: opened,
        body: `schema = "${LEGACY_RECORD_SCHEMA}"\n`,
        checksum: "b".repeat(64),
        commitSha: "7d2e91a",
        path: opened.path!,
        mergedAt,
        mergedByUserId: userId,
        policyVersion: "governance:team",
      }),
    );
    expect(first.version).toBe(1);
    expect(first.promotion.seq).toBe(1);
    expect(first.ledgerBefore).toBe(0);

    const found = await inScope(() => store.findRecord(scope, lineage));
    expect(found?.record).toMatchObject({
      slug: lineage,
      status: "active",
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      commitSha: "7d2e91a",
      path: opened.path,
      version: 1,
      checksum: "b".repeat(64),
    });
    expect(found?.record.publishedAt?.toISOString()).toBe(
      mergedAt.toISOString(),
    );
    expect(found?.publishedBy).toEqual({
      proposalPublicId: proposal.publicId,
      prUrl: opened.prUrl,
    });
    const merged = await inScope(() =>
      store.findProposal(scope, proposal.publicId),
    );
    expect(merged).toMatchObject({
      status: "merged",
      mergedCommit: "7d2e91a",
      publishedRecordId: first.recordId,
      promotionEventId: first.promotion.id,
    });
    expect(await inScope(() => store.mergedRefs(merged!))).toEqual({
      promotionEventPublicId: first.promotion.publicId,
      recordPublicId: first.recordPublicId,
    });
    expect(await inScope(() => store.ledgerLength(scope))).toBe(1);

    // The proposal is past checks_passed: the transition finds no row and
    // the transaction's record, version and ledger writes roll back.
    await expect(
      inScope(() =>
        store.publishMerge({
          scope,
          proposal: opened,
          body: `schema = "${LEGACY_RECORD_SCHEMA}"\n# again\n`,
          checksum: "d".repeat(64),
          commitSha: "7d2e91a",
          path: opened.path!,
          mergedAt: new Date(),
          mergedByUserId: userId,
          policyVersion: "governance:team",
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "already_merged" });
    // A guarded write finds the proposal merged and leaves it as it is.
    await expect(
      inScope(() =>
        store.updateProposal(proposal.id, { status: "rejected" }, [
          "proposed",
          "checks_passed",
        ]),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "proposal_merged" });
    expect(await inScope(() => store.ledgerLength(scope))).toBe(1);
    expect(
      (await inScope(() => store.findRecord(scope, lineage)))!.versions,
    ).toHaveLength(1);

    const second = await propose({ statement: "Cache the first read." });
    const secondOpened = await inScope(() =>
      store.updateProposal(
        second.id,
        {
          status: "checks_passed",
          repository: "a-intel/platform",
          baseRef: "main",
          branch: `context/${lineage}`,
          path: `.oxagen/rules/${lineage}.toml`,
          provider: "github",
          prNumber: 520,
          prUrl: "https://github.com/a-intel/platform/pull/520",
          headSha: "def5678",
          stampedRecordId: "rec_y",
          recordHash: `sha256:${"e".repeat(64)}`,
        },
        ["proposed"],
      ),
    );
    const again = await inScope(() =>
      store.publishMerge({
        scope,
        proposal: secondOpened,
        body: `schema = "${LEGACY_RECORD_SCHEMA}"\n# v2\n`,
        checksum: "c".repeat(64),
        commitSha: "8e3f0ab",
        path: opened.path!,
        mergedAt: new Date(),
        mergedByUserId: userId,
        policyVersion: "governance:team",
      }),
    );
    expect(again.recordId).toBe(first.recordId);
    expect(again.version).toBe(2);
    expect(again.promotion.seq).toBe(2);
    expect(again.ledgerBefore).toBe(1);
    const versions = (await inScope(() => store.findRecord(scope, lineage)))!
      .versions;
    expect(versions.map((v) => [v.version, v.isLatest])).toEqual([
      [2, true],
      [1, false],
    ]);
    // Each version carries the classification its own merge published, so a
    // promote back to version 1 can restore what version 1 says (#3312).
    const classified = await withSystemDb((tx) =>
      tx
        .select({
          version: schema.steeringRecordVersions.versionNumber,
          kind: schema.steeringRecordVersions.kind,
          force: schema.steeringRecordVersions.force,
          constraintEffect: schema.steeringRecordVersions.constraintEffect,
          statement: schema.steeringRecordVersions.statement,
        })
        .from(schema.steeringRecordVersions)
        .where(eq(schema.steeringRecordVersions.recordId, first.recordId))
        .orderBy(asc(schema.steeringRecordVersions.versionNumber)),
    );
    expect(classified).toEqual([
      {
        version: 1,
        kind: "rule",
        force: "should",
        constraintEffect: null,
        statement: "Do not re-read CHANGELOG.md more than once in a run.",
      },
      {
        version: 2,
        kind: "rule",
        force: "should",
        constraintEffect: null,
        statement: "Cache the first read.",
      },
    ]);
  });

  it("keeps a record's label when a later proposal gives only a title, and changes it when one gives a label", async () => {
    const where = { orgId, workspaceId: labelWorkspace };
    const labelLineage = `ctx.g3771.${tag}`;
    const mergeWith = async (
      over: Partial<ProposalRow>,
      n: number,
      lineageId = labelLineage,
      body = `schema = "${LEGACY_RECORD_SCHEMA}"\n# ${n}\n`,
    ) => {
      const proposal = await proposeIn(where, { lineageId, ...over });
      const opened = await runInTenantScope(where, () =>
        store.updateProposal(
          proposal.id,
          {
            status: "checks_passed",
            repository: "a-intel/platform",
            baseRef: "main",
            branch: `context/${lineageId}`,
            path: `.oxagen/rules/${lineageId}.toml`,
            provider: "github",
            prNumber: 600 + n,
            prUrl: `https://github.com/a-intel/platform/pull/${600 + n}`,
            headSha: `abc${n}`,
            stampedRecordId: `rec_l${n}`,
            recordHash: `sha256:${String(n).repeat(64)}`,
          },
          ["proposed"],
        ),
      );
      await runInTenantScope(where, () =>
        store.publishMerge({
          scope: where,
          proposal: opened,
          body,
          checksum: String(n).repeat(64),
          commitSha: `9a${n}f0ab`,
          path: opened.path!,
          mergedAt: new Date(),
          mergedByUserId: userId,
          policyVersion: "governance:team",
        }),
      );
      return (await runInTenantScope(where, () =>
        store.findRecord(where, lineageId),
      ))!.record;
    };

    expect(
      await mergeWith({ title: "Changelog reads", label: "Read once" }, 1),
    ).toMatchObject({ title: "Changelog reads", label: "Read once" });
    expect(await mergeWith({ title: "Changelog reads v2" }, 2)).toMatchObject({
      title: "Changelog reads v2",
      label: "Read once",
    });
    expect(
      await mergeWith({ label: "Read the changelog once" }, 3),
    ).toMatchObject({ label: "Read the changelog once" });
    // A blank title stored before the schema trimmed it names the record
    // from its lineage, so the label check cannot refuse the merge.
    expect(
      await mergeWith({ title: "   " }, 4, `${labelLineage}.blank`),
    ).toMatchObject({
      title: "Do not re-read CHANGELOG.md more than once in a run.",
      label: steeringRecordLabel(`${labelLineage}.blank`),
    });
    // The merged file names the record (ADR-178), over the proposal.
    const named = serializeRecordFile(
      buildRecordFile({
        lineageId: labelLineage,
        label: "Changelog once",
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: "Do not re-read CHANGELOG.md more than once in a run.",
        origin: "user",
        proposalPublicId: "prp_5",
        setId: "a-intel.platform",
      }),
    );
    expect(
      await mergeWith({ label: "Read once" }, 5, labelLineage, named),
    ).toMatchObject({ label: "Changelog once" });
  });

  it("keeps one open PR per lineage through the partial unique index", async () => {
    const a = await propose({ lineageId: `${lineage}.dup` });
    const b = await propose({ lineageId: `${lineage}.dup` });
    await inScope(() =>
      store.updateProposal(a.id, { status: "pr_open" }, ["proposed"]),
    );
    await expect(
      inScope(() =>
        store.updateProposal(b.id, { status: "checks_running" }, ["proposed"]),
      ),
    ).rejects.toThrow();
    expect(
      await inScope(() =>
        store.findOpenPrOnLineage(scope, `${lineage}.dup`, b.id),
      ),
    ).toMatchObject({ id: a.id });
  });

  it("admits a governance proposal, merges it with no record or promotion event, and still refuses an unknown kind (#4795)", async () => {
    const row = await propose({
      lineageId: "governance",
      kind: "governance",
      force: "info",
      statement: "Change the steering governance mode from team to solo.",
      status: "checks_passed",
      governanceMode: "team",
      provider: "github",
      repository: "acme/steering",
      baseRef: "main",
      branch: "steering/governance",
      path: "steering/governance.toml",
      prNumber: 7,
      prUrl: "https://github.com/acme/steering/pull/7",
      headSha: "4d5e6f7a8b9c",
      checks: [],
    });
    expect(row).toMatchObject({ kind: "governance", status: "checks_passed" });

    const mergedAt = new Date("2026-09-30T08:00:00.000Z");
    const merged = await inScope(() =>
      store.mergeGovernance({
        proposal: row,
        commitSha: "9a8b7c6d5e4f",
        mergedAt,
        mergedByUserId: userId,
      }),
    );
    expect(merged).toMatchObject({
      status: "merged",
      mergedCommit: "9a8b7c6d5e4f",
      mergedAt,
      mergedByUserId: userId,
      publishedRecordId: null,
      promotionEventId: null,
      mergeClaimedAt: null,
    });
    await expect(
      inScope(() =>
        store.mergeGovernance({
          proposal: row,
          commitSha: "0f1e2d3c4b5a",
          mergedAt,
          mergedByUserId: userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "already_merged" });

    // A record proposal still reads merged only with its record and its
    // promotion event.
    const record = await propose({ lineageId: `${lineage}.merged-check` });
    await expect(
      withSystemDb((tx) =>
        tx
          .update(schema.steeringProposals)
          .set({ status: "merged", mergedCommit: "1a2b3c4d" })
          .where(eq(schema.steeringProposals.id, record.id)),
      ),
    ).rejects.toThrow();
    // The kind check still refuses a kind it does not list.
    await expect(
      propose({ lineageId: `${lineage}.unknown-kind`, kind: "directive" }),
    ).rejects.toThrow();
  });

  it("admits each steering PR kind, merges it with its commit only, and retires a reverted record in the same transaction (#5122)", async () => {
    const where = { orgId, workspaceId: revertWorkspace };
    const inRevertScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope(where, fn);
    const recordLineage = `${lineage}.reverted`;
    // The record a steering PR published, which the revert deletes.
    const proposal = await proposeIn(where, { lineageId: recordLineage });
    const opened = await inRevertScope(() =>
      store.updateProposal(
        proposal.id,
        {
          status: "checks_passed",
          repository: "a-intel/platform",
          baseRef: "main",
          branch: `steering/${recordLineage}`,
          path: `steering/business-rules/${recordLineage}.md`,
          provider: "github",
          prNumber: 519,
          prUrl: "https://github.com/a-intel/platform/pull/519",
          headSha: "abc1234",
          stampedRecordId: "rec_r",
          recordHash: `sha256:${"c".repeat(64)}`,
        },
        ["proposed"],
      ),
    );
    await inRevertScope(() =>
      store.publishMerge({
        scope: where,
        proposal: opened,
        body: "---\nschema: steering-record/v1\n---\n",
        checksum: "c".repeat(64),
        commitSha: "7d2e91a",
        path: opened.path!,
        mergedAt: new Date("2026-10-02T08:00:00.000Z"),
        mergedByUserId: userId,
        policyVersion: "governance:team",
      }),
    );
    expect(await inRevertScope(() => store.ledgerLength(where))).toBe(1);

    const pr = (kind: string, number: number, branch: string, lineageId = branch) =>
      proposeIn(where, {
        lineageId,
        kind,
        force: "info",
        statement: `Steering PR #${number}`,
        status: "checks_passed",
        governanceMode: "team",
        provider: "github",
        repository: "a-intel/platform",
        baseRef: "main",
        branch,
        path: "steering",
        prNumber: number,
        prUrl: `https://github.com/a-intel/platform/pull/${number}`,
        headSha: `head${number}`,
        checks: [],
      });
    const revert = await pr("revert", 520, "steering/revert-519", recordLineage);
    const mergedAt = new Date("2026-10-02T09:00:00.000Z");
    const merged = await inRevertScope(() =>
      store.mergeSteeringPr({
        scope: where,
        proposal: revert,
        commitSha: "9a8b7c6d5e4f",
        mergedAt,
        mergedByUserId: userId,
        policyVersion: "governance:team",
        retire: [recordLineage, `${lineage}.never-published`],
      }),
    );
    expect(merged.retired).toEqual([recordLineage]);
    expect(merged.proposal).toMatchObject({
      kind: "revert",
      status: "merged",
      mergedCommit: "9a8b7c6d5e4f",
      mergedByUserId: userId,
      publishedRecordId: null,
      promotionEventId: null,
      mergeClaimedAt: null,
    });
    expect(
      (await inRevertScope(() => store.findRecord(where, recordLineage)))?.record,
    ).toMatchObject({ status: "retired", commitSha: "9a8b7c6d5e4f" });
    // The retirement is one more ledger entry, approved by the merger.
    expect(await inRevertScope(() => store.ledgerLength(where))).toBe(2);
    await expect(
      inRevertScope(() =>
        store.mergeSteeringPr({
          scope: where,
          proposal: revert,
          commitSha: "0f1e2d3c4b5a",
          mergedAt,
          mergedByUserId: userId,
          policyVersion: "governance:team",
          retire: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "already_merged" });

    // Every other kind merges with its commit alone.
    const kinds = ["tools", "import", "memory_pr", "agent_file", "agent_proposal", "workspace"];
    for (const [i, kind] of kinds.entries()) {
      const row = await pr(kind, 600 + i, `${kind.replace("_", "-")}/x${i}`);
      const out = await inRevertScope(() =>
        store.mergeSteeringPr({
          scope: where,
          proposal: row,
          commitSha: `c0ffee${i}`,
          mergedAt,
          mergedByUserId: userId,
          policyVersion: "governance:team",
          retire: [],
        }),
      );
      expect(out).toMatchObject({ retired: [], proposal: { kind, status: "merged" } });
    }
    expect(await inRevertScope(() => store.ledgerLength(where))).toBe(2);
  });

  it("replaces an open governance proposal in one transaction (#4795)", async () => {
    const noProposal = "00000000-0000-0000-0000-000000000000";
    const first = await propose({
      lineageId: "governance",
      kind: "governance",
      force: "info",
      statement: "Change the steering governance mode from team to solo.",
      status: "checks_passed",
      governanceMode: "team",
      provider: "github",
      repository: "acme/steering",
      baseRef: "main",
      branch: "steering/governance",
      path: "steering/governance.toml",
      prNumber: 8,
      prUrl: "https://github.com/acme/steering/pull/8",
      headSha: "aaa111aaa111",
      checks: [],
    });
    const { id: _id, publicId: _publicId, ...values } = first;
    const setAside = (id: string) => ({
      id,
      patch: {
        status: "rejected" as const,
        dismissedAt: new Date(),
        dismissedReason: "Replaced by a newer governance change on the same pull request",
      },
      from: ["checks_passed"] as const,
    });

    const next = await inScope(() =>
      store.replaceProposal(setAside(first.id), {
        ...values,
        statement: "Change the steering governance mode from team to regulated.",
        headSha: "bbb222bbb222",
      }),
    );
    expect(next).toMatchObject({ kind: "governance", status: "checks_passed", headSha: "bbb222bbb222" });
    expect((await inScope(() => store.findProposalById(first.id)))?.status).toBe("rejected");
    expect(
      await inScope(() => store.findOpenPrOnLineage(scope, "governance", noProposal)),
    ).toMatchObject({ id: next.id });

    // An insert that fails rolls the set-aside back: the open proposal stays.
    await expect(
      inScope(() => store.replaceProposal(setAside(next.id), { ...values, kind: "directive" })),
    ).rejects.toThrow();
    expect((await inScope(() => store.findProposalById(next.id)))?.status).toBe("checks_passed");

    // A prior that already moved on refuses, and nothing is inserted.
    await expect(
      inScope(() =>
        store.replaceProposal(setAside(first.id), { ...values, headSha: "ccc333ccc333" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await inScope(() => store.findOpenPrOnLineage(scope, "governance", noProposal)),
    ).toMatchObject({ id: next.id });
  });

  it("refuses a write tied to a head the proposal has moved past with head_moved, and applies one tied to its head", async () => {
    const p = await propose({ lineageId: `${lineage}.head` });
    await inScope(() =>
      store.updateProposal(
        p.id,
        { status: "checks_running", headSha: "head2" },
        ["proposed"],
      ),
    );
    await expect(
      inScope(() =>
        store.updateProposal(
          p.id,
          { status: "checks_passed" },
          ["checks_running"],
          { headSha: "head1" },
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "head_moved" });
    expect(
      (await inScope(() => store.findProposal(scope, p.publicId)))?.status,
    ).toBe("checks_running");
    expect(
      await inScope(() =>
        store.updateProposal(
          p.id,
          { status: "checks_failed" },
          ["checks_running"],
          { headSha: "head2" },
        ),
      ),
    ).toMatchObject({ status: "checks_failed", headSha: "head2" });
    await expect(
      inScope(() =>
        store.updateProposal(
          p.id,
          { status: "checks_passed" },
          ["checks_running"],
          { headSha: "head2" },
        ),
      ),
    ).rejects.toMatchObject({ reason: "proposal_checks_failed" });
  });

  it("refuses a write while a merge claim newer than the cutoff stands, and applies one once the claim is older or cleared", async () => {
    const p = await propose({ lineageId: `${lineage}.claim` });
    const claimedAt = new Date("2026-09-27T12:00:00Z");
    await inScope(() =>
      store.updateProposal(
        p.id,
        { status: "checks_passed", mergeClaimedAt: claimedAt },
        ["proposed"],
      ),
    );
    const before = new Date(claimedAt.getTime() - 1000);
    await expect(
      inScope(() =>
        store.updateProposal(
          p.id,
          { status: "checks_running" },
          ["checks_passed"],
          { noClaimSince: before },
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "merge_in_progress" });
    // The status check comes first: a write from the wrong status names it.
    await expect(
      inScope(() =>
        store.updateProposal(
          p.id,
          { status: "checks_passed" },
          ["checks_running"],
          { noClaimSince: before },
        ),
      ),
    ).rejects.toMatchObject({ reason: "proposal_checks_passed" });
    expect(
      await inScope(() => store.findProposal(scope, p.publicId)),
    ).toMatchObject({ status: "checks_passed", mergeClaimedAt: claimedAt });

    // A claim as old as the cutoff has lapsed.
    expect(
      await inScope(() =>
        store.updateProposal(
          p.id,
          { status: "checks_running" },
          ["checks_passed"],
          { noClaimSince: claimedAt },
        ),
      ),
    ).toMatchObject({ status: "checks_running", mergeClaimedAt: claimedAt });

    // A cleared claim blocks nothing.
    await inScope(() =>
      store.updateProposal(p.id, { mergeClaimedAt: null }, ["checks_running"]),
    );
    expect(
      await inScope(() =>
        store.updateProposal(
          p.id,
          { status: "checks_passed" },
          ["checks_running"],
          { noClaimSince: new Date() },
        ),
      ),
    ).toMatchObject({ status: "checks_passed", mergeClaimedAt: null });
  });

  it("appends once per content hash and reads the first back on a repeat", async () => {
    const values = {
      orgId,
      workspaceId,
      kind: "observation",
      lineageId: `${lineage}.obs`,
      statement: "The checkout suite flaked on Safari through August.",
      sharingScope: "workspace",
      recordHash: `sha256:${"d".repeat(64)}`,
      sourceRefs: ["frame:run_1/12"],
      evidenceLinks: [],
      proposalId: null,
      createdById: userId,
    };
    const first = await inScope(() => store.insertAppend(values));
    expect(first.appended).toBe(true);
    const again = await inScope(() => store.insertAppend(values));
    expect(again).toEqual({ row: first.row, appended: false });
    expect(
      await inScope(() => store.findAppendByHash(scope, values.recordHash)),
    ).toEqual(first.row);
    expect(
      await inScope(() => store.findAppend(scope, first.row.publicId)),
    ).toEqual(first.row);
  });

  it("SELECT under another workspace's tenant scope sees none of these rows", async () => {
    const other = { orgId, workspaceId: otherWorkspace };
    const seen = await runInTenantScope(other, async () => ({
      proposals: await store.listProposals(other, {}, { limit: 50, offset: 0 }),
      records: await store.listRecords(other, {}, { limit: 50, offset: 0 }),
      append: await store.findAppendByHash(other, `sha256:${"d".repeat(64)}`),
      ledger: await store.ledgerLength(other),
    }));
    expect(seen.proposals.total).toBe(0);
    expect(seen.records.total).toBe(0);
    expect(seen.append).toBeNull();
    expect(seen.ledger).toBe(0);
    const mine = await inScope(() =>
      store.listProposals(scope, {}, { limit: 50, offset: 0 }),
    );
    expect(mine.total).toBeGreaterThan(0);

    // The policy itself, not the query's WHERE, is what filters: an unfiltered
    // read of each new table as the application role (a superuser bypasses
    // RLS) under the other workspace's GUCs answers no row of this workspace,
    // and under this workspace's GUCs answers every one of them.
    const unfiltered = (workspace: string) =>
      withSystemDb(async (tx) => {
        await tx.execute(
          sql`select set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', ${orgId}, true), set_config('app.current_workspace_id', ${workspace}, true)`,
        );
        await tx.execute(sql`set local role oxagen_app`);
        const proposals = await tx.execute(
          sql`select id from agent.steering_proposals`,
        );
        const appends = await tx.execute(
          sql`select id from agent.context_appends`,
        );
        return {
          proposals: [...proposals].map((r) => (r as { id: string }).id),
          appends: [...appends].map((r) => (r as { id: string }).id),
        };
      });
    const theirs = await unfiltered(otherWorkspace);
    expect(theirs.proposals).toEqual([]);
    expect(theirs.appends).toEqual([]);
    const ours = await unfiltered(workspaceId);
    expect(new Set(ours.proposals)).toEqual(
      new Set(mine.rows.map((p) => p.id)),
    );
    expect(ours.appends).toHaveLength(1);
  });
});
