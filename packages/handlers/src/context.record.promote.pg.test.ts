import { describe, expect, it, vi } from "vitest";
import { schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";
import { makeCTX } from "./test-utils/fixtures";
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: vi.fn().mockResolvedValue("Owner"),
  resolveActingUserId: vi.fn(
    async (ctx: { userId: string | null }) => ctx.userId,
  ),
}));
import { contextRecordPromoteHandler } from "./context.record.promote";
describe.skipIf(!process.env.DATABASE_URL)(
  "record retirement against Postgres",
  () => {
    it("records one retirement and one validity end under concurrent requests", async () => {
      const scope = {
        orgId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
      };
      let id: string | undefined;
      try {
        const [record] = await withSystemDb((tx) =>
          tx
            .insert(schema.contextRecords)
            .values({
              ...scope,
              slug: "retire-once",
              title: "Retire once",
              kind: "rule",
              force: "must",
              sharingScope: "workspace",
              status: "active",
              statement: "Retained historical claim.",
            })
            .returning(),
        );
        id = record!.id;
        const context = { ...makeCTX(), ...scope, userId: crypto.randomUUID() };
        const input = {
          record_id: record!.publicId,
          action: "retire" as const,
          policy_version: "test-existing-policy",
        };
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            runInTenantScope(scope, () =>
              contextRecordPromoteHandler(input, context),
            ),
          ),
        );
        expect(new Set(results.map((result) => result.validUntil)).size).toBe(
          1,
        );
        expect(
          results.every(
            (result) => result.seq === 1 && result.validUntil !== null,
          ),
        ).toBe(true);
        const [saved] = await withSystemDb((tx) =>
          tx
            .select()
            .from(schema.contextRecords)
            .where(eq(schema.contextRecords.id, id!)),
        );
        expect(saved).toMatchObject({
          id,
          publicId: record!.publicId,
          slug: "retire-once",
          statement: "Retained historical claim.",
          status: "retired",
        });
        expect(saved!.validUntil?.toISOString()).toBe(results[0]!.validUntil);
        expect(
          await withSystemDb((tx) =>
            tx
              .select()
              .from(schema.contextPromotions)
              .where(eq(schema.contextPromotions.recordId, id!)),
          ),
        ).toHaveLength(1);
      } finally {
        if (id)
          await withSystemDb(async (tx) => {
            await tx
              .delete(schema.contextPromotions)
              .where(eq(schema.contextPromotions.recordId, id!));
            await tx
              .delete(schema.contextRecords)
              .where(eq(schema.contextRecords.id, id!));
          });
      }
    });
  },
);
