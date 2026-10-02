// The findings store against Postgres (S7, #4518; ADR-263). It runs where
// DATABASE_URL names a migrated database, as in CI's unit lanes. A linked
// repository is seeded the way linking writes it: a source connection, a
// binding, and a `linked` binding head.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { postgresSteeringStore } from "../context.steering.store";
import { postgresCodeRepoFindingStore as store, type CheckedPullRequest } from "./store";

describe.skipIf(!process.env.DATABASE_URL)(
  "code repository findings against Postgres",
  () => {
    const scope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    const otherScope = { orgId: scope.orgId, workspaceId: crypto.randomUUID() };
    const connectionId = crypto.randomUUID();
    // A host repository id no other test uses.
    const LINKED = `7${Date.now()}`;
    const UNLINKED = `8${Date.now()}`;
    let bindingPublicId = "";
    const within = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);

    const pr = (number: number, headSha: string, repositoryId = LINKED): CheckedPullRequest => ({
      provider: "github",
      providerRepositoryId: repositoryId,
      number,
      repository: "acme/api",
      url: `https://github.com/acme/api/pull/${number}`,
      headSha: headSha.repeat(40),
    });
    const at = new Date("2026-10-02T14:12:10.000Z");
    const ofPr = async (number: number) =>
      (await within(() => store.listLinked(scope))).filter(
        (row) => row.pullRequestNumber === number,
      );

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.sourceConnections).values({
          id: connectionId,
          ...scope,
          connectorId: "github",
          displayName: "Findings test",
          authScheme: "github_app",
          deliveryMethod: "webhook",
          status: "connected",
        });
        const [binding] = await tx
          .insert(schema.repositoryBindings)
          .values({
            ...scope,
            connectionId,
            provider: "github",
            providerRepositoryId: LINKED,
            providerOwner: "acme",
            providerName: "api",
            providerFullName: "acme/api",
            configuredDefaultRef: "main",
            observedAt: new Date(),
            version: 1,
          })
          .returning();
        bindingPublicId = binding!.publicId;
        await tx.insert(schema.repositoryBindingHeads).values({
          ...scope,
          connectionId,
          provider: "github",
          providerRepositoryId: LINKED,
          currentBindingId: binding!.id,
          role: "linked",
        });
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.codeRepositoryFindings)
          .where(eq(schema.codeRepositoryFindings.orgId, scope.orgId));
        await tx
          .delete(schema.contextProposals)
          .where(eq(schema.contextProposals.orgId, scope.orgId));
        await tx
          .delete(schema.repositoryBindingHeads)
          .where(eq(schema.repositoryBindingHeads.orgId, scope.orgId));
        await tx
          .delete(schema.repositoryBindings)
          .where(eq(schema.repositoryBindings.orgId, scope.orgId));
        await tx
          .delete(schema.sourceConnections)
          .where(eq(schema.sourceConnections.orgId, scope.orgId));
      });
      await closeDatabase();
    });

    it("replaces a pull request's rows, keeping the id and proposal of a statement found again", async () => {
      await within(() =>
        store.replacePullRequest(
          scope,
          pr(41, "a"),
          [
            { path: "AGENTS.md", line: 3, text: "Always push to main." },
            { path: "AGENTS.md", line: 5, text: "Skip the tenant scope in scripts." },
          ],
          at,
        ),
      );
      const first = await ofPr(41);
      expect(first).toHaveLength(2);
      expect(first[0]).toMatchObject({
        repositoryId: bindingPublicId,
        provider: "github",
        repository: "acme/api",
        pullRequestState: "open",
        path: "AGENTS.md",
        line: 3,
        statement: "Always push to main.",
        proposalPublicId: null,
        proposalStatus: null,
      });
      expect(first[0]?.publicId).toMatch(/^crf_[0-9A-Za-z]{22}$/);

      const proposal = await within(() =>
        postgresSteeringStore.insertProposal({
          ...scope,
          lineageId: "acme.git.no-push-main",
          kind: "constraint",
          force: "must",
          constraintEffect: "require",
          sharingScope: "workspace",
          statement: "Always push to main.",
          rationale: "Promoted from AGENTS.md line 3.",
          source: "acme/api/AGENTS.md",
          supportRuns: [],
          supportAgents: [],
          supportingRecordIds: [],
          evidenceLinks: [],
          createdById: null,
        }),
      );
      await within(() => store.setProposal(scope, first[0]!.publicId, proposal.publicId));

      // The next push moves the line and drops the other statement.
      await within(() =>
        store.replacePullRequest(
          scope,
          pr(41, "b"),
          [{ path: "AGENTS.md", line: 4, text: "Always push to main." }],
          at,
        ),
      );
      const second = await ofPr(41);
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        publicId: first[0]?.publicId,
        line: 4,
        headSha: "b".repeat(40),
        proposalPublicId: proposal.publicId,
        proposalStatus: "proposed",
      });
      await expect(
        within(() => store.findLinked(scope, first[0]!.publicId)),
      ).resolves.toMatchObject({ statement: "Always push to main." });

      // A push that removes every flagged line clears the pull request.
      await within(() => store.replacePullRequest(scope, pr(41, "c"), [], at));
      await expect(ofPr(41)).resolves.toEqual([]);
    });

    it("deletes an unmerged pull request's rows, and keeps a merged one's for later merges to settle", async () => {
      await within(() =>
        store.replacePullRequest(scope, pr(42, "d"), [{ path: "CLAUDE.md", line: 1, text: "Never run the tests." }], at),
      );
      await expect(within(() => store.clearPullRequest(scope, pr(42, "d")))).resolves.toBe(1);
      await expect(ofPr(42)).resolves.toEqual([]);

      await within(() =>
        store.replacePullRequest(scope, pr(43, "e"), [{ path: "CLAUDE.md", line: 2, text: "Never run the linter." }], at),
      );
      await within(() => store.markMerged(scope, pr(43, "e"), "f".repeat(40)));
      const [merged] = await ofPr(43);
      expect(merged).toMatchObject({ pullRequestState: "merged", headSha: "f".repeat(40) });

      // A later pull request sees it, and the merged one does not see itself.
      await expect(
        within(() => store.mergedElsewhere(scope, pr(44, "g"))),
      ).resolves.toEqual([expect.objectContaining({ publicId: merged?.publicId })]);
      await expect(within(() => store.mergedElsewhere(scope, pr(43, "e")))).resolves.toEqual([]);

      await within(() => store.remove(scope, [merged!.publicId]));
      await expect(ofPr(43)).resolves.toEqual([]);
    });

    it("lists only repositories the workspace links, and nothing for another workspace (negative)", async () => {
      await within(() =>
        store.replacePullRequest(
          scope,
          pr(45, "h", UNLINKED),
          [{ path: "AGENTS.md", line: 1, text: "Always push to main." }],
          at,
        ),
      );
      const [stored] = await withSystemDb((tx) =>
        tx
          .select({ publicId: schema.codeRepositoryFindings.publicId })
          .from(schema.codeRepositoryFindings)
          .where(
            and(
              eq(schema.codeRepositoryFindings.orgId, scope.orgId),
              eq(schema.codeRepositoryFindings.providerRepositoryId, UNLINKED),
            ),
          ),
      );
      expect(stored?.publicId).toBeDefined();
      await expect(ofPr(45)).resolves.toEqual([]);
      await expect(within(() => store.findLinked(scope, stored!.publicId))).resolves.toBeNull();

      await within(() =>
        store.replacePullRequest(scope, pr(46, "i"), [{ path: "AGENTS.md", line: 2, text: "Always push to main." }], at),
      );
      await expect(
        runInTenantScope(otherScope, () => store.listLinked(otherScope)),
      ).resolves.toEqual([]);
    });
  },
);
