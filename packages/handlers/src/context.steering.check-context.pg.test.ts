// readCheckContext against a real Postgres (#5149, ADR-266): the members
// list the steering checks resolve an agent file's operator against holds the
// public user ids of this organization's live members, and nothing from
// another organization. A check message on the host quotes these ids, so a
// member of another organization must never appear. Runs wherever
// DATABASE_URL points at a migrated database, as CI's unit job does; a run
// without one is skipped. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { inArray } from "drizzle-orm";
import { readCheckContext } from "./context.steering.index.get";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("readCheckContext members against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const ns = tag.slice(0, 5);
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const workspaceA = crypto.randomUUID();
  const second = crypto.randomUUID();
  const first = crypto.randomUUID();
  const removed = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  const userIds = [second, first, removed, outsider];
  const publicId = (who: string) => `usr_ck${tag}${who}`;
  const email = (who: string) => `ck-${tag}-${who}@handlers.test`;

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        { id: second, publicId: publicId("b"), email: email("second"), status: "active" },
        { id: first, publicId: publicId("a"), email: email("first"), status: "active" },
        {
          id: removed,
          publicId: publicId("c"),
          email: email("removed"),
          status: "active",
          deletedAt: new Date("2026-09-01T00:00:00Z"),
        },
        { id: outsider, publicId: publicId("d"), email: email("outsider"), status: "active" },
      ]);
      await tx.insert(schema.organizations).values([
        {
          id: orgA,
          name: `A ${tag}`,
          slug: `cka-${tag}`,
          namespace: `a${ns}`,
          planType: "free",
          status: "active",
        },
        {
          id: orgB,
          name: `B ${tag}`,
          slug: `ckb-${tag}`,
          namespace: `b${ns}`,
          planType: "free",
          status: "active",
        },
      ]);
      await tx.insert(schema.workspaces).values({
        id: workspaceA,
        orgId: orgA,
        name: "Core",
        slug: "core",
        namespace: "core",
      });
      const joinedAt = new Date("2026-01-01T00:00:00Z");
      await tx.insert(schema.orgUsers).values([
        { orgId: orgA, userId: second, role: "member", joinedAt },
        { orgId: orgA, userId: first, role: "owner", joinedAt },
        { orgId: orgA, userId: removed, role: "member", joinedAt },
        { orgId: orgB, userId: outsider, role: "owner", joinedAt },
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const orgIds = [orgA, orgB];
      await tx.delete(schema.orgUsers).where(inArray(schema.orgUsers.orgId, orgIds));
      await tx.delete(schema.workspaces).where(inArray(schema.workspaces.orgId, orgIds));
      await tx.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
      await tx.delete(schema.users).where(inArray(schema.users.id, userIds));
    });
    await closeDatabase();
  });

  it("lists this organization's live members by public id, sorted, and no one else", async () => {
    const context = await runInTenantScope({ orgId: orgA, workspaceId: workspaceA }, () =>
      readCheckContext({ orgId: orgA, workspaceId: workspaceA }),
    );

    // Not the deleted user, and not the member of the other organization.
    expect(context.members).toEqual([publicId("a"), publicId("b")]);
  });
});
