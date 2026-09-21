// list_members against a real Postgres: the org scope returns the org's own
// members and pending invitations and nothing from another org, a plain
// Member can list, and the workspace scope still answers with the workspace's
// members. Runs wherever DATABASE_URL points at a migrated database — CI's
// `test` job migrates Postgres with Atlas before `turbo run build test:unit`
// and carries DATABASE_URL in turbo's globalEnv; a local run without one is
// skipped, not red. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { listMembersHandler } from "./workspace.member.list";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("list_members against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const ns = tag.slice(0, 5);
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const workspaceA = crypto.randomUUID();
  const workspaceA2 = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const member = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  const userIds = [owner, member, outsider];
  const email = (who: string) => `wl19-${tag}-${who}@handlers.test`;

  const ctxFor = (
    orgId: string,
    workspaceId: string,
    userId: string,
  ): CapabilityContext => ({
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  });

  const list = (
    input: { scope: "org" | "workspace" },
    ctx: CapabilityContext,
  ) =>
    runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, () =>
      listMembersHandler(listMembers.input.parse(input), ctx),
    );

  beforeAll(async () => {
    const day = 24 * 60 * 60 * 1000;
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        {
          id: owner,
          email: email("owner"),
          displayName: "Owner",
          status: "active",
        },
        { id: member, email: email("member"), status: "active" },
        { id: outsider, email: email("outsider"), status: "active" },
      ]);
      await tx.insert(schema.organizations).values([
        {
          id: orgA,
          name: `A ${tag}`,
          slug: `wl19a-${tag}`,
          namespace: `a${ns}`,
          planType: "free",
          status: "active",
        },
        {
          id: orgB,
          name: `B ${tag}`,
          slug: `wl19b-${tag}`,
          namespace: `b${ns}`,
          planType: "free",
          status: "active",
        },
      ]);
      await tx.insert(schema.workspaces).values([
        {
          id: workspaceA,
          orgId: orgA,
          name: "Core",
          slug: "core",
          namespace: "core",
        },
        {
          id: workspaceA2,
          orgId: orgA,
          name: "Ops",
          slug: "ops",
          namespace: "ops",
        },
      ]);
      await tx.insert(schema.orgUsers).values([
        {
          orgId: orgA,
          userId: owner,
          role: "owner",
          joinedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          orgId: orgA,
          userId: member,
          role: "member",
          joinedAt: new Date("2026-02-01T00:00:00Z"),
        },
        {
          orgId: orgB,
          userId: outsider,
          role: "owner",
          joinedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ]);
      await tx.insert(schema.workspaceUsers).values([
        {
          workspaceId: workspaceA,
          userId: owner,
          role: "owner",
          joinedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          workspaceId: workspaceA2,
          userId: member,
          role: "member",
          joinedAt: new Date("2026-02-01T00:00:00Z"),
        },
      ]);
      await tx.insert(schema.invitations).values([
        // Pending and unexpired: listed.
        {
          orgId: orgA,
          email: email("pending"),
          role: "Member",
          status: "pending",
          invitedByUserId: owner,
          expiresAt: new Date(Date.now() + 7 * day),
        },
        // Pending with no expiry: listed.
        {
          orgId: orgA,
          email: email("open"),
          role: "Admin",
          status: "pending",
          invitedByUserId: owner,
          expiresAt: null,
        },
        // Pending but expired: listed so an owner can renew or revoke it.
        {
          orgId: orgA,
          email: email("expired"),
          role: "Member",
          status: "pending",
          invitedByUserId: owner,
          expiresAt: new Date(Date.now() - day),
        },
        // Already accepted: not listed.
        {
          orgId: orgA,
          email: email("accepted"),
          role: "Member",
          status: "accepted",
          invitedByUserId: owner,
          acceptedUserId: member,
          expiresAt: new Date(Date.now() + 7 * day),
        },
        // Another org's pending invitation: never listed for org A.
        {
          orgId: orgB,
          email: email("other-org"),
          role: "Member",
          status: "pending",
          invitedByUserId: outsider,
          expiresAt: new Date(Date.now() + 7 * day),
        },
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const orgIds = [orgA, orgB];
      await tx
        .delete(schema.invitations)
        .where(inArray(schema.invitations.orgId, orgIds));
      await tx
        .delete(schema.workspaceUsers)
        .where(
          inArray(schema.workspaceUsers.workspaceId, [workspaceA, workspaceA2]),
        );
      await tx
        .delete(schema.orgUsers)
        .where(inArray(schema.orgUsers.orgId, orgIds));
      await tx
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.orgId, orgIds));
      await tx
        .delete(schema.organizations)
        .where(inArray(schema.organizations.id, orgIds));
      await tx.delete(schema.users).where(inArray(schema.users.id, userIds));
    });
    await closeDatabase();
  });

  it("org scope returns the org's members and its pending invitations including expired ones, and nothing from another org", async () => {
    const out = await list({ scope: "org" }, ctxFor(orgA, workspaceA, owner));
    expect(listMembers.output.safeParse(out).success).toBe(true);
    if (out.scope !== "org") throw new Error("unreachable");

    expect(out.members.map((m) => [m.email, m.role, m.name])).toEqual([
      [email("owner"), "owner", "Owner"],
      [email("member"), "member", null],
    ]);
    const publicIds = await withSystemDb((tx) =>
      tx
        .select({ id: schema.users.id, publicId: schema.users.publicId })
        .from(schema.users)
        .where(eq(schema.users.id, owner)),
    );
    expect(out.members[0]?.id).toBe(publicIds[0]?.publicId);
    expect(out.members[0]?.joinedAt).toBe("2026-01-01T00:00:00.000Z");

    expect(out.invitations.map((i) => [i.email, i.role])).toEqual(
      expect.arrayContaining([
        [email("open"), "Admin"],
        [email("pending"), "Member"],
        [email("expired"), "Member"],
      ]),
    );
    expect(out.invitations).toHaveLength(3);
    expect(
      Date.parse(
        out.invitations.find((i) => i.email === email("expired"))?.expiresAt ??
          "",
      ),
    ).toBeLessThan(Date.now());
    expect(
      out.invitations.find((i) => i.email === email("open"))?.expiresAt,
    ).toBeNull();
    expect(out.invitations.every((i) => i.id.startsWith("invi_"))).toBe(true);
  });

  it("a plain Member can list the org", async () => {
    const out = await list({ scope: "org" }, ctxFor(orgA, workspaceA2, member));
    if (out.scope !== "org") throw new Error("unreachable");
    expect(out.members).toHaveLength(2);
    expect(out.invitations).toHaveLength(3);
  });

  it("the other org sees only its own roster", async () => {
    const out = await list(
      { scope: "org" },
      ctxFor(orgB, workspaceB, outsider),
    );
    if (out.scope !== "org") throw new Error("unreachable");
    expect(out.members.map((m) => m.email)).toEqual([email("outsider")]);
    expect(out.invitations.map((i) => i.email)).toEqual([email("other-org")]);
  });

  it("workspace scope lists the members of the request's workspace and carries no invitations", async () => {
    const core = await list(
      { scope: "workspace" },
      ctxFor(orgA, workspaceA, owner),
    );
    expect(listMembers.output.safeParse(core).success).toBe(true);
    expect(core.scope).toBe("workspace");
    expect(core.members.map((m) => [m.email, m.role])).toEqual([
      [email("owner"), "owner"],
    ]);
    expect("invitations" in core).toBe(false);

    const ops = await list(
      { scope: "workspace" },
      ctxFor(orgA, workspaceA2, member),
    );
    expect(ops.members.map((m) => m.email)).toEqual([email("member")]);
  });
});
