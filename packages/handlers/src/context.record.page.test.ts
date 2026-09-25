// What the record page reads back (oxagen#3395). A published record is the
// file `.oxagen/rules/<lineage>.toml` on the production branch, so these tests
// hold the three facts the page depends on: the file answers even when the
// registry row is gone, provenance is the commit that published the file, and
// the rendered and cited counters are a count of runs rather than a number
// anybody wrote down. The revision tests hold the other half: the one thing
// the page can change ends on a pull request.
import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async () => "Member",
}));

import { createAppendRecordHandler } from "./context.records.append";
import { createGetRecordHandler } from "./context.records.get";
import { createReviseRecordHandler } from "./context.record.revise";
import { createOpenContextPrHandler } from "./context.pr.open";
import { createMergeContextPrHandler } from "./context.pr.merge";
import { createProposeRecordHandler } from "./context.proposal.create";
import { readRecordFile } from "./context.steering.file";
import {
  REVIEWER,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const LINEAGE = "ctx.review.small-diffs";
const PATH = `.oxagen/rules/${LINEAGE}.toml`;

async function publish(
  h: Harness,
  lineageId = LINEAGE,
  kind: "rule" | "constraint" = "rule",
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
        statement: "Keep a diff under 400 lines.",
      },
      rationale: "Small diffs get reviewed.",
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

/** The page's read, narrowed to the published branch it always takes here. */
async function read(h: Harness, recordId = LINEAGE) {
  const out = await createGetRecordHandler(h)({ recordId }, ctx());
  if (out.source !== "published") throw new Error("expected a published read");
  return out;
}

describe("get_record, file-backed", () => {
  it("reads the record out of the repository, and keeps reading it after the registry row is gone", async () => {
    const h = harness();
    await publish(h);

    const backed = await read(h);
    expect(backed.backing).toBe("file");
    expect(backed.record.statement).toBe("Keep a diff under 400 lines.");

    // The registry is a mirror. Drop it: the lineage is still in force,
    // because the file on the production branch is what steers a run.
    h.store.records.length = 0;
    h.store.versions.length = 0;

    const withoutMirror = await read(h);
    expect(withoutMirror.backing).toBe("file");
    expect(withoutMirror.record.lineageId).toBe(LINEAGE);
    expect(withoutMirror.record.kind).toBe("rule");
    expect(withoutMirror.record.force).toBe("should");
    expect(withoutMirror.record.statement).toBe("Keep a diff under 400 lines.");
    // The four fields only the mirror holds report as absent rather than as a
    // value the page would have to invent.
    expect(withoutMirror.record.id).toBeNull();
    expect(withoutMirror.record.updatedAt).toBeNull();
    expect(withoutMirror.record.constraintEffect).toBeNull();
    expect(withoutMirror.versions).toEqual([]);
    // And the commit still names who published it.
    expect(withoutMirror.provenance?.commit).toBe(h.github.heads.get("main"));
  });

  it("takes the file's wording over the mirror's when the two disagree", async () => {
    const h = harness();
    await publish(h);
    const row = h.store.records[0]!;
    row.statement = "Stale wording the mirror never refreshed.";
    row.label = "Stale mirror label";

    const out = await read(h);
    expect(out.record.statement).toBe("Keep a diff under 400 lines.");
    // The file carries the label too (ADR-174), so its label wins as well.
    const file = readRecordFile(
      h.github.files.get(`${h.github.heads.get("main")}:${PATH}`)!,
    )!;
    expect(file.label).not.toBeNull();
    expect(out.record.label).toBe(file.label);
    // The mirror still supplies what the file does not carry.
    expect(out.record.id).toBe(row.publicId);
  });

  it("404s a lineage that neither the repository nor the registry holds", async () => {
    const h = harness();
    await publish(h);
    await expect(
      createGetRecordHandler(h)({ recordId: "ctx.nothing.here" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("renders without provenance rather than failing when the commit cannot be read", async () => {
    const h = harness();
    await publish(h);
    h.github.lastCommitForPath = async () => {
      throw new Error("GitHub API error 502");
    };
    const out = await read(h);
    expect(out.backing).toBe("file");
    expect(out.provenance).toBeNull();
  });
});

describe("get_record, provenance", () => {
  it("names the commit that published the file, not a column", async () => {
    const h = harness();
    await publish(h);

    const publishingCommit = h.github.heads.get("main")!;
    const first = await read(h);
    expect(first.provenance).toMatchObject({
      commit: publishingCommit,
      authorName: "Fixture Author",
      authorLogin: "fixture-author",
    });
    expect(first.provenance?.summary).toContain(LINEAGE);
    const publishedAt = first.provenance!.committedAt;

    // A commit that touches another file leaves this record's provenance
    // exactly where it was: provenance is per path, not per branch.
    h.github.commit("main", ".oxagen/rules/ctx.other.toml", "schema = 'x'\n");
    const later = await read(h);
    expect(later.provenance?.commit).toBe(publishingCommit);
    expect(later.provenance?.committedAt).toEqual(publishedAt);
  });
});

describe("get_record, effect counters", () => {
  /** One run's context-use append, as `context/append` writes it (MC spec §9). */
  async function use(
    h: Harness,
    kind: "context_use" | "context_use_feedback",
    run: string,
    seq: number,
    lineageId = LINEAGE,
  ) {
    await createAppendRecordHandler(h)(
      {
        kind,
        lineageId,
        statement: `${kind} on ${lineageId} in ${run}`,
        sharingScope: "workspace",
        sourceRefs: [`frame:${run}/${seq}`],
        evidenceLinks: [],
      },
      ctx(),
    );
  }

  it("counts the runs that rendered and cited the record, not the appends", async () => {
    const h = harness();
    await publish(h);

    // Four runs render it; run_1 renders it twice, which is still one run.
    await use(h, "context_use", "run_1", 1);
    await use(h, "context_use", "run_1", 7);
    await use(h, "context_use", "run_2", 1);
    await use(h, "context_use", "run_3", 2);
    await use(h, "context_use", "run_4", 1);
    // Two of them report back on it.
    await use(h, "context_use_feedback", "run_2", 9);
    await use(h, "context_use_feedback", "run_3", 4);
    // Another lineage's traffic belongs to that lineage.
    await use(h, "context_use", "run_5", 1, "ctx.other.thing");

    const out = await read(h);
    expect(out.effect).toEqual({ rendered: 4, cited: 2 });
  });

  it("reports nothing rather than zero when no run has written a context-use append", async () => {
    const h = harness();
    await publish(h);
    const out = await read(h);
    expect(out.effect).toBeNull();
  });

  it("reports zero for a record no run used, once some run has used something", async () => {
    const h = harness();
    await publish(h);
    await use(h, "context_use", "run_1", 1, "ctx.other.thing");
    const out = await read(h);
    expect(out.effect).toEqual({ rendered: 0, cited: 0 });
  });
});

describe("revise_context_record", () => {
  it("opens a pull request that changes only the record's file and names its lineage and kind", async () => {
    const h = harness();
    await publish(h);
    const before = h.github.heads.get("main")!;

    const pr = await createReviseRecordHandler(h)(
      { recordId: LINEAGE, statement: "Keep a diff under 200 lines." },
      ctx(),
    );

    expect(pr.status).toBe("checks_passed");
    expect(pr.checks.filter((c) => c.status !== "passed")).toEqual([]);

    // One file on the branch, and it is this record's.
    const changed = await h.github.changedPaths(
      h.github.repository!,
      "main",
      `context/${LINEAGE}`,
    );
    expect(changed).toEqual([PATH]);

    const pull = h.github.pulls.find((p) => p.number === pr.pr!.number)!;
    expect(pull.body).toContain(`\`${LINEAGE}\``);
    expect(pull.body).toContain("**kind** `rule`");
    expect(pull.body).toContain("Keep a diff under 200 lines.");

    // Nothing is in force yet: the production branch has not moved, and the
    // read still answers with the wording that merged.
    expect(h.github.heads.get("main")).toBe(before);
    expect((await read(h)).record.statement).toBe(
      "Keep a diff under 400 lines.",
    );
  });

  it("keeps the lineage and everything but the statement, and re-stamps the identity", async () => {
    const h = harness();
    await publish(h);
    const published = readRecordFile(
      h.github.files.get(`${h.github.heads.get("main")}:${PATH}`)!,
    )!;

    await createReviseRecordHandler(h)(
      { recordId: LINEAGE, statement: "Keep a diff under 200 lines." },
      ctx(),
    );
    const branchHead = h.github.heads.get(`context/${LINEAGE}`)!;
    const revised = readRecordFile(
      h.github.files.get(`${branchHead}:${PATH}`)!,
    )!;

    expect(revised.lineageId).toBe(published.lineageId);
    expect(revised.kind).toBe(published.kind);
    expect(revised.force).toBe(published.force);
    expect(revised.sharingScope).toBe(published.sharingScope);
    expect(revised.label).toBe(published.label);
    expect(revised.statement).toBe("Keep a diff under 200 lines.");
    // The content changed, so the content's identity changed with it.
    expect(revised.recordHash).not.toBe(published.recordHash);
  });

  it("moves provenance to the new publishing commit once the pull request merges", async () => {
    const h = harness();
    await publish(h);
    const firstCommit = (await read(h)).provenance!;

    const pr = await createReviseRecordHandler(h)(
      { recordId: LINEAGE, statement: "Keep a diff under 200 lines." },
      ctx(),
    );
    await createMergeContextPrHandler(h)(
      { proposalId: pr.proposalId },
      ctx({ userId: REVIEWER }),
    );

    const after = await read(h);
    expect(after.record.statement).toBe("Keep a diff under 200 lines.");
    expect(after.provenance?.commit).toBe(h.github.heads.get("main"));
    expect(after.provenance?.commit).not.toBe(firstCommit.commit);
    expect(Date.parse(after.provenance!.committedAt)).toBeGreaterThan(
      Date.parse(firstCommit.committedAt),
    );
  });

  it("refuses a constraint whose effect this workspace does not hold", async () => {
    const h = harness();
    await publish(h, "ctx.review.no-secrets", "constraint", "forbid");
    h.store.records.length = 0;

    await expect(
      createReviseRecordHandler(h)(
        { recordId: "ctx.review.no-secrets", statement: "Never commit a key." },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "constraint_effect_unknown",
    });
  });

  it("404s a lineage nothing holds", async () => {
    const h = harness();
    await expect(
      createReviseRecordHandler(h)(
        { recordId: "ctx.nothing.here", statement: "Anything." },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  // The id becomes the file's path when the mirror has no row for it, so
  // only the proposal contract's lineage shape may reach the repository.
  it.each(["../evil", "Bad.Case", "ctx/review", "ctx.review-"])(
    "404s %s without reading the repository",
    async (recordId) => {
      const h = harness();
      const read = vi.spyOn(h.github, "readFile");
      await expect(
        createReviseRecordHandler(h)(
          { recordId, statement: "Anything." },
          ctx(),
        ),
      ).rejects.toMatchObject({
        code: "not_found",
        reason: "record_not_found",
      });
      await expect(
        createGetRecordHandler(h)({ recordId }, ctx()),
      ).rejects.toMatchObject({
        code: "not_found",
        reason: "record_not_found",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
});
