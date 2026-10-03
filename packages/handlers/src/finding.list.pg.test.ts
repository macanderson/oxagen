// list_findings against a real Postgres (#5303): a cursor pages through 120
// open findings and 70 decided ones in the order Postgres itself sorts them,
// with no finding missed and none read twice, and a level and a subject list
// only one agent's findings however far down the workspace's list they rank.
// The open findings share savings in threes and the decided ones share a
// millisecond in fours, at different microseconds, so the id has to break
// the ties and the cursor has to compare the instant at the precision it
// carries.
//
// Runs wherever DATABASE_URL points at a migrated database. CI's unit job
// migrates Postgres with Atlas before it runs the tests. A local run without
// one is skipped. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import {
  FINDINGS_LIST_MAX,
  type FindingListOutput,
} from "@oxagen/oxagen/contracts/finding.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findingListHandler } from "./finding.list";
import { makeCTX } from "./test-utils/fixtures";

const findings = schema.findings;
const OPEN = 120;
const DECIDED = 70;
const LONE = "acme.core.lone-bot";

describe.skipIf(!process.env.DATABASE_URL)(
  "list_findings pages against Postgres",
  () => {
    const scope = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const ctx = makeCTX(scope);
    const windowStart = new Date("2026-08-16T00:00:00.000Z");
    const windowEnd = new Date("2026-09-15T00:00:00.000Z");

    function row(i: number, subject: string) {
      return {
        ...scope,
        kind: "spin_loops",
        level: "agent",
        subject,
        fingerprint: `spin_loops|agent|${subject}|${String(i)}`,
        windowStart,
        windowEnd,
        estimatedSavingMicros: 0n,
        currency: "USD",
        savingBasis: "gateway_observed",
        confidence: "high",
        why: "A loop repeated one call.",
        fix: "Stop the loop.",
        citedRuns: ["tse_0000000000000000000001"],
        citedFrames: {
          calls: 1,
          coveredCalls: 1,
          measuredTokens: 1,
          counterfactualTokens: 0,
          measuredMicros: "1",
          counterfactualMicros: "0",
          operatorKeys: [],
          runs: [],
        },
        detectedAt: windowEnd,
      };
    }

    beforeAll(async () => {
      await withSystemDb((tx) =>
        tx.insert(findings).values([
          // Savings fall in threes, so each value is shared by three rows.
          // The last and smallest belongs to the one agent that has no other
          // finding, so it ranks 120th in the workspace.
          ...Array.from({ length: OPEN }, (_, i) => ({
            ...row(
              i,
              i === OPEN - 1 ? LONE : `acme.core.bot-${String(i % 7)}`,
            ),
            estimatedSavingMicros:
              i === OPEN - 1 ? 1n : 1_000_000n - BigInt(Math.floor(i / 3)),
          })),
          // Decisions fall four to a millisecond, a microsecond apart.
          ...Array.from({ length: DECIDED }, (_, i) => ({
            ...row(i, `acme.core.done-${String(i)}`),
            estimatedSavingMicros: 5_000n,
            status: "applied",
            appliedActionId: `req_${String(i)}`,
            decidedAt: sql`timestamptz '2026-09-20T12:00:00.000Z' + ${Math.floor(i / 4) * 1000 + (i % 4)}::integer * interval '1 microsecond'`,
          })),
        ]),
      );
    });

    afterAll(async () => {
      await withSystemDb((tx) =>
        tx.delete(findings).where(eq(findings.workspaceId, scope.workspaceId)),
      );
      await closeDatabase();
    });

    /** Every page from the first, following each answer's cursor. */
    async function readAll(input: {
      status: "open" | "applied";
      level?: "agent";
      subject?: string;
    }): Promise<FindingListOutput[]> {
      const pages: FindingListOutput[] = [];
      let cursor: string | null = null;
      do {
        const ask = cursor === null ? input : { ...input, cursor };
        const page: FindingListOutput = await runInTenantScope(scope, () =>
          findingListHandler(ask, ctx),
        );
        pages.push(page);
        cursor = page.nextCursor;
      } while (cursor !== null && pages.length < 10);
      return pages;
    }

    /** The public ids in the order Postgres sorts them, the oracle. */
    function sorted(status: "open" | "applied") {
      return withSystemDb((tx) =>
        tx
          .select({ id: findings.publicId })
          .from(findings)
          .where(
            and(
              eq(findings.workspaceId, scope.workspaceId),
              eq(findings.status, status),
            ),
          )
          .orderBy(
            status === "open"
              ? desc(findings.estimatedSavingMicros)
              : desc(sql`date_trunc('milliseconds', ${findings.decidedAt})`),
            asc(findings.id),
          ),
      );
    }

    it("pages through 120 open findings with no gap and no repeat", async () => {
      const pages = await readAll({ status: "open" });
      expect(pages.map((p) => p.findings.length)).toEqual([
        FINDINGS_LIST_MAX,
        FINDINGS_LIST_MAX,
        OPEN - 2 * FINDINGS_LIST_MAX,
      ]);
      expect(pages.map((p) => p.offset)).toEqual([0, 50, 100]);
      const ids = pages.flatMap((p) => p.findings.map((f) => f.id));
      expect(new Set(ids).size).toBe(OPEN);
      expect(ids).toEqual((await sorted("open")).map((r) => r.id));
      // Every page counts every open finding.
      for (const page of pages) expect(page.counts.findings).toBe(OPEN);
    });

    it("pages through decided findings that share a millisecond with no gap and no repeat", async () => {
      const pages = await readAll({ status: "applied" });
      expect(pages.map((p) => p.findings.length)).toEqual([
        FINDINGS_LIST_MAX,
        DECIDED - FINDINGS_LIST_MAX,
      ]);
      const ids = pages.flatMap((p) => p.findings.map((f) => f.id));
      expect(new Set(ids).size).toBe(DECIDED);
      expect(ids).toEqual((await sorted("applied")).map((r) => r.id));
    });

    it("lists one agent's finding that ranks past 50 in the workspace by its level and subject", async () => {
      const [first] = await readAll({ status: "open" });
      expect(first?.findings.some((f) => f.subject === LONE)).toBe(false);

      const pages = await readAll({
        status: "open",
        level: "agent",
        subject: LONE,
      });
      expect(pages).toHaveLength(1);
      const [page] = pages;
      expect(page?.findings.map((f) => f.subject)).toEqual([LONE]);
      expect(page?.counts.findings).toBe(1);
      expect(page?.saving?.micros).toBe("1");
      expect(page?.truncated).toBe(false);
      expect(page?.nextCursor).toBeNull();
    });
  },
);
