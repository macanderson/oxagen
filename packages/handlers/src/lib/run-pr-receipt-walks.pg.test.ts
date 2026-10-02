// cost.run_pr_receipt_walks against a real Postgres (#4511): a walk keeps its
// position and receipts across passes, the retry check holds, and the prune
// deletes only walks created more than 31 days ago. Runs wherever
// DATABASE_URL points at a migrated database (CI's `test` job). A local run
// without one is skipped, not red.
import { closeDatabase, schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ReceiptWalk,
  readReceiptWalks,
  saveReceiptWalks,
} from "./run-pr-receipt-walks";

const walks = schema.runPrReceiptWalks;

describe.skipIf(!process.env.DATABASE_URL)(
  "run_pr_receipt_walks against Postgres",
  () => {
    const scope = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const scoped = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
    const at = (iso: string) => new Date(iso);

    const walk = (runId: string, over: Partial<ReceiptWalk> = {}): ReceiptWalk => ({
      runId,
      afterSeq: null,
      complete: false,
      receipts: [],
      attemptedAt: at("2026-10-01T10:00:00Z"),
      unresolved: null,
      retryAfter: null,
      ...over,
    });

    afterAll(async () => {
      await scoped(() =>
        withTenantDb((tx) =>
          tx
            .delete(walks)
            .where(
              and(
                eq(walks.orgId, scope.orgId),
                eq(walks.workspaceId, scope.workspaceId),
              ),
            ),
        ),
      );
      await closeDatabase();
    });

    it("keeps a walk's position and receipts, and moves them on the next save", async () => {
      const runId = `arun_${tag}a1`;
      await scoped(() =>
        saveReceiptWalks(scope, [
          walk(runId, {
            afterSeq: "10000",
            receipts: [{ repositoryId: "R_1", number: 12, headSha: "b".repeat(40) }],
          }),
        ]),
      );
      expect(await scoped(() => readReceiptWalks(scope, [runId]))).toEqual([
        walk(runId, {
          afterSeq: "10000",
          receipts: [{ repositoryId: "R_1", number: 12, headSha: "b".repeat(40) }],
        }),
      ]);
      const done = walk(runId, {
        afterSeq: "10300",
        complete: true,
        receipts: [
          { repositoryId: "R_1", number: 12, headSha: "b".repeat(40) },
          { repositoryId: "R_1", number: 13, headSha: null },
        ],
        attemptedAt: at("2026-10-01T11:00:00Z"),
      });
      await scoped(() => saveReceiptWalks(scope, [done]));
      expect(await scoped(() => readReceiptWalks(scope, [runId]))).toEqual([done]);
    });

    it("keeps an unresolved walk's reason and retry time, and clears both once it resolves", async () => {
      const runId = `arun_${tag}b2`;
      const waiting = walk(runId, {
        complete: true,
        unresolved: "repository_not_connected",
        retryAfter: at("2026-10-01T16:00:00Z"),
      });
      await scoped(() => saveReceiptWalks(scope, [waiting]));
      expect(await scoped(() => readReceiptWalks(scope, [runId]))).toEqual([waiting]);
      const resolved = walk(runId, { complete: true });
      await scoped(() => saveReceiptWalks(scope, [resolved]));
      expect(await scoped(() => readReceiptWalks(scope, [runId]))).toEqual([resolved]);
    });

    it("rejects an unresolved walk with no retry time", async () => {
      await expect(
        scoped(() =>
          withTenantDb((tx) =>
            tx.insert(walks).values({
              orgId: scope.orgId,
              workspaceId: scope.workspaceId,
              runId: `arun_${tag}c3`,
              attemptedAt: at("2026-10-01T10:00:00Z"),
              unresolved: "read_failed",
              retryAfter: null,
            }),
          ),
        ),
      ).rejects.toThrow();
    });

    it("deletes the workspace's walks created more than 31 days ago, and keeps the rest", async () => {
      const old = `arun_${tag}d4`;
      const recent = `arun_${tag}e5`;
      await scoped(() => saveReceiptWalks(scope, [walk(old), walk(recent)]));
      await scoped(() =>
        withTenantDb((tx) =>
          tx
            .update(walks)
            .set({ createdAt: sql`now() - interval '32 days'` })
            .where(and(eq(walks.orgId, scope.orgId), eq(walks.runId, old))),
        ),
      );
      await scoped(() => saveReceiptWalks(scope, []));
      const left = await scoped(() => readReceiptWalks(scope, [old, recent]));
      expect(left.map((w) => w.runId)).toEqual([recent]);
    });
  },
);
