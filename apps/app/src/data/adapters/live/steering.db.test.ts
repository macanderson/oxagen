// The steering adapter against a real Postgres: seeds one published record
// (record, version, promotion ledger entry) in a throwaway org and workspace,
// reads it back through liveSteering.records, and removes what it wrote.
//
// Opt-in, local only: MC_LIVE_DB=1 with DATABASE_URL pointing at the local
// stack (localhost:5433, `pnpm dev`). The unit suite and CI skip it; the mocked
// contract test beside it (steering.test.ts) runs everywhere.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.MC_LIVE_DB === "1";

describe.runIf(enabled)(
  "liveSteering.records against the local database",
  () => {
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const otherWorkspaceId = crypto.randomUUID();
    const lineage = `ctx.mc-live-db.steering.t${Date.now().toString(36)}`;
    const body = `schema = "context-record/v0.1"
set_id = "mc-live-db"

[defaults]
sharing_scope = "workspace"

[[record]]
lineage_id = "${lineage}"
kind = "constraint"
statement = "The release manager opens the release pull request. A person merges it."

  [record.steering]
  force = "must"

  [record.enforcement]
  mode = "hard"
`;

    beforeAll(async () => {
      const { schema, withSystemDb } = await import("@oxagen/database");
      const { eq } = await import("drizzle-orm");
      // Seeding crosses no tenant boundary that matters here: fresh ids, and the
      // read under test runs through withTenantDb in the adapter.
      await withSystemDb(async (tx) => {
        for (const ws of [workspaceId, otherWorkspaceId]) {
          const [record] = await tx
            .insert(schema.contextRecords)
            .values({
              orgId,
              workspaceId: ws,
              slug: lineage,
              title: "Merge rule",
            })
            .returning({ id: schema.contextRecords.id });
          if (!record) throw new Error("record insert returned no row");
          const [version] = await tx
            .insert(schema.contextRecordVersions)
            .values({
              orgId,
              workspaceId: ws,
              recordId: record.id,
              versionNumber: 1,
              isLatest: true,
              publishedAt: new Date("2026-06-18T09:00:00Z"),
              body: ws === workspaceId ? body : body.replace("must", "may"),
              checksum: "c".repeat(64),
              provenance: [{ type: "commit", digest: "3f0b8c1" }],
            })
            .returning({ id: schema.contextRecordVersions.id });
          if (!version) throw new Error("version insert returned no row");
          await tx
            .update(schema.contextRecords)
            .set({ activeVersionId: version.id })
            .where(eq(schema.contextRecords.id, record.id));
          await tx.insert(schema.contextPromotions).values({
            orgId,
            workspaceId: ws,
            recordId: record.id,
            versionId: version.id,
            seq: 1,
            action: "promote",
            policyVersion: "solo@1",
            chainDigest: "d".repeat(64),
            createdAt: new Date("2026-06-19T15:00:00Z"),
          });
        }
      });
    });

    afterAll(async () => {
      const { schema, withSystemDb } = await import("@oxagen/database");
      const { eq } = await import("drizzle-orm");
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.contextPromotions)
          .where(eq(schema.contextPromotions.orgId, orgId));
        await tx
          .update(schema.contextRecords)
          .set({ activeVersionId: null })
          .where(eq(schema.contextRecords.orgId, orgId));
        await tx
          .delete(schema.contextRecordVersions)
          .where(eq(schema.contextRecordVersions.orgId, orgId));
        await tx
          .delete(schema.contextRecords)
          .where(eq(schema.contextRecords.orgId, orgId));
      });
    });

    it("maps the seeded row, dated by its promotion, and only this workspace's", async () => {
      const { liveSteering } = await import("./steering");
      await expect(
        liveSteering.records({ orgId, workspaceId }),
      ).resolves.toEqual({
        ok: true,
        value: [
          {
            lineage,
            kind: "constraint",
            force: "must",
            enforcement: null,
            scope: "workspace",
            status: "published",
            statement:
              "The release manager opens the release pull request. A person merges it.",
            effect: null,
            commitSha: "3f0b8c1",
            publishedOn: "2026-06-19",
          },
        ],
      });
    });
  },
);
