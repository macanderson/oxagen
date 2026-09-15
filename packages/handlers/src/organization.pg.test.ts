// The Organization › Roles and Workspaces backend against a real Postgres
// (issue #2964, ADR-063): an enterprise org's Admin creates a custom role
// over the catalogue, reads it back folded into permissions, is refused a
// second custom role of the same name in either scope kind by the unique
// indexes, replaces the grants, is refused a delete
// while an agent holds the role and allowed after; creates a second
// workspace, sees it in the list, is refused its archive while an agent is
// registered there, archives it once the agent is archived, sees it leave the
// list unless asked, and is refused a second archive. The second workspace is created
// through an API key the Admin created, the MCP path, which acts as the key's
// creator. Runs wherever DATABASE_URL points
// at a migrated database — CI's `test` job migrates Postgres with Atlas
// before `turbo run build test:unit`; a local run without one is skipped, not
// red. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { capabilitiesOf } from "@oxagen/oxagen/iam";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { iamRoleCreateHandler } from "./iam.role.create";
import { iamRoleDeleteHandler } from "./iam.role.delete";
import { iamRoleGrantsSetHandler } from "./iam.role.grants.set";
import { iamRoleListHandler } from "./iam.role.list";
import { workspaceArchiveHandler } from "./workspace.archive";
import { workspaceCreateHandler } from "./workspace.create";
import { workspaceListHandler } from "./workspace.list";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)(
  "organization roles and workspaces against Postgres",
  () => {
    const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const orgId = crypto.randomUUID();
    const orgSlug = `g2964-${tag}`;
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const agentPrincipalId = crypto.randomUUID();
    let adminRoleId = "";
    let apiKeyId = "";

    const admin: CapabilityContext = {
      orgId,
      workspaceId,
      userId,
      apiKeyId: null,
      requestId: `req-${tag}`,
      surface: "api",
      messageId: null,
    };

    const scoped = <T>(fn: () => Promise<T>) =>
      runInTenantScope({ orgId, workspaceId }, fn);
    const refusal = async (p: Promise<unknown>) => {
      const err = await p.catch((e) => e);
      if (!isHandlerError(err))
        throw new Error(`expected a HandlerError, got ${err}`);
      return { code: err.code, reason: err.reason };
    };

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.users).values({
          id: userId,
          email: `g2964-${tag}@handlers.test`,
          displayName: "Dana Okafor",
          status: "active",
        });
        await tx.insert(schema.organizations).values({
          id: orgId,
          name: `G2964 ${tag}`,
          slug: orgSlug,
          namespace: `g${tag.slice(0, 5)}`,
          // The legacy plan_type fallback of resolveOrgTier: the enterprise
          // tier is the one the kernel enforces roles for.
          planType: "enterprise",
          status: "active",
        });
        await tx.insert(schema.workspaces).values({
          id: workspaceId,
          orgId,
          name: "Core",
          slug: "core",
          namespace: "core",
        });
        await tx.insert(schema.orgUsers).values({
          orgId,
          userId,
          role: "admin",
          joinedAt: new Date(),
        });
        const [principal] = await tx
          .insert(schema.principals)
          .values({
            orgId,
            kind: "human",
            displayName: "Dana Okafor",
            status: "active",
            parentUserId: userId,
          })
          .returning({ id: schema.principals.id });
        await tx.insert(schema.principals).values({
          id: agentPrincipalId,
          orgId,
          workspaceId,
          kind: "agent",
          displayName: "release-manager",
          status: "active",
        });
        // An org Admin, holding run.read and run.control and nothing else:
        // the ceiling the walk pushes against.
        const [role] = await tx
          .insert(schema.roles)
          .values({
            orgId,
            scopeKind: "org",
            name: "Admin",
            isSystemDefault: true,
          })
          .returning({ id: schema.roles.id });
        if (!principal || !role)
          throw new Error("fixture insert returned no row");
        adminRoleId = role.id;
        await tx.insert(schema.principalRoleAssignments).values({
          principalId: principal.id,
          roleId: role.id,
          orgId,
        });
        await tx.insert(schema.roleGrants).values(
          capabilitiesOf(["run.read", "run.control"]).map((capabilityId) => ({
            orgId,
            roleId: role.id,
            capabilityId,
            effect: "allow",
          })),
        );
        const [key] = await tx
          .insert(schema.apiKeys)
          .values({
            orgId,
            workspaceId,
            keyPrefix: `ox_g${tag}`,
            keyHash: `hash-${tag}`,
            name: "g2964 walk",
            scope: {},
            createdByUserId: userId,
          })
          .returning({ id: schema.apiKeys.id });
        if (!key) throw new Error("fixture insert returned no row");
        apiKeyId = key.id;
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        const roleIds = (
          await tx
            .select({ id: schema.roles.id })
            .from(schema.roles)
            .where(eq(schema.roles.orgId, orgId))
        ).map((r) => r.id);
        if (roleIds.length > 0) {
          await tx
            .delete(schema.principalRoleAssignments)
            .where(inArray(schema.principalRoleAssignments.roleId, roleIds));
          await tx
            .delete(schema.roleGrants)
            .where(inArray(schema.roleGrants.roleId, roleIds));
        }
        await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
        await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
        await tx
          .delete(schema.principals)
          .where(eq(schema.principals.orgId, orgId));
        await tx
          .delete(schema.orgUsers)
          .where(eq(schema.orgUsers.orgId, orgId));
        const wsIds = (
          await tx
            .select({ id: schema.workspaces.id })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.orgId, orgId))
        ).map((w) => w.id);
        if (wsIds.length > 0) {
          await tx
            .delete(schema.workspaceUsers)
            .where(inArray(schema.workspaceUsers.workspaceId, wsIds));
          await tx
            .delete(schema.workspaceSlugHistory)
            .where(inArray(schema.workspaceSlugHistory.workspaceId, wsIds));
        }
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
        await tx.delete(schema.users).where(eq(schema.users.id, userId));
      });
      await closeDatabase();
    });

    it("walks the role editor: create, read back, unique per scope kind, replace grants, refuse a held delete, delete", async () => {
      const created = await scoped(() =>
        iamRoleCreateHandler(
          iamRoleCreate.input.parse({
            name: "agent.release",
            scopeKind: "workspace",
            description: "cut a release after approval",
            permissions: ["run.read"],
          }),
          admin,
        ),
      );
      expect(created.role.permissions).toEqual(["run.read"]);
      expect(created.role.kind).toBe("agent");
      expect(created.role.createdBy).toBe("Dana Okafor");
      expect(created.role.id.startsWith("rol_")).toBe(true);

      // The read: the custom role beside the seeded Admin, folded into
      // permissions, with the catalogue and enforcement on.
      const listed = await scoped(() =>
        iamRoleListHandler(iamRoleList.input.parse({}), admin),
      );
      expect(listed.enforcement).toEqual({
        tier: "enterprise",
        enforced: true,
      });
      const row = listed.roles.find((r) => r.id === created.role.id);
      expect(row?.permissions).toEqual(["run.read"]);
      expect(row?.grants.map((g) => g.capability)).toEqual(
        capabilitiesOf(["run.read"]),
      );
      expect(listed.roles.find((r) => r.name === "Admin")?.permissions).toEqual(
        ["run.read", "run.control"],
      );

      // A custom role name is unique in the org: the indexes refuse the same
      // name in the same scope kind and in the other one.
      await expect(
        refusal(
          scoped(() =>
            iamRoleCreateHandler(
              iamRoleCreate.input.parse({
                name: "agent.release",
                scopeKind: "workspace",
                permissions: ["run.read"],
              }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "role_exists" });
      await expect(
        refusal(
          scoped(() =>
            iamRoleCreateHandler(
              iamRoleCreate.input.parse({
                name: "agent.release",
                scopeKind: "org",
                permissions: ["run.read"],
              }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "role_exists" });

      // The ceiling: the Admin holds run.read and run.control, so run.approve
      // is refused and run.control replaces the grants.
      await expect(
        refusal(
          scoped(() =>
            iamRoleGrantsSetHandler(
              iamRoleGrantsSet.input.parse({
                roleId: created.role.id,
                permissions: ["run.approve"],
              }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({
        code: "forbidden",
        reason: "delegation_ceiling_exceeded",
      });
      const replaced = await scoped(() =>
        iamRoleGrantsSetHandler(
          iamRoleGrantsSet.input.parse({
            roleId: created.role.id,
            permissions: ["run.control"],
          }),
          admin,
        ),
      );
      expect(replaced.role.permissions).toEqual(["run.control"]);
      const grantsNow = await withSystemDb((tx) =>
        tx
          .select({ capabilityId: schema.roleGrants.capabilityId })
          .from(schema.roleGrants)
          .innerJoin(
            schema.roles,
            eq(schema.roles.id, schema.roleGrants.roleId),
          )
          .where(eq(schema.roles.publicId, created.role.id)),
      );
      expect(grantsNow.map((g) => g.capabilityId)).toEqual([
        "dispatch_command",
      ]);

      // A held role is not deleted out from under its holder.
      const [roleRow] = await withSystemDb((tx) =>
        tx
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(eq(schema.roles.publicId, created.role.id)),
      );
      await withSystemDb((tx) =>
        tx.insert(schema.principalRoleAssignments).values({
          principalId: agentPrincipalId,
          roleId: roleRow!.id,
          orgId,
          workspaceId,
        }),
      );
      await expect(
        refusal(
          scoped(() =>
            iamRoleDeleteHandler(
              iamRoleDelete.input.parse({ roleId: created.role.id }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "role_in_use" });
      await withSystemDb((tx) =>
        tx
          .update(schema.principalRoleAssignments)
          .set({ deletedAt: new Date() })
          .where(eq(schema.principalRoleAssignments.roleId, roleRow!.id)),
      );
      const deleted = await scoped(() =>
        iamRoleDeleteHandler(
          iamRoleDelete.input.parse({ roleId: created.role.id }),
          admin,
        ),
      );
      expect(deleted).toEqual({ id: created.role.id, name: "agent.release" });
      const after = await scoped(() =>
        iamRoleListHandler(iamRoleList.input.parse({}), admin),
      );
      expect(after.roles.map((r) => r.id)).not.toContain(created.role.id);

      // The seeded Admin role is read-only.
      const adminPublicId = listed.roles.find((r) => r.name === "Admin")!.id;
      expect(adminRoleId).not.toBe("");
      await expect(
        refusal(
          scoped(() =>
            iamRoleDeleteHandler(
              iamRoleDelete.input.parse({ roleId: adminPublicId }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "system_role_readonly" });
    });

    it("walks the workspaces: create through an API key, list, refuse an archive over a registered agent, archive, list without and with archived rows, refuse a second archive", async () => {
      const keyCall: CapabilityContext = {
        ...admin,
        userId: null,
        apiKeyId,
        surface: "mcp",
      };
      const created = await scoped(() =>
        workspaceCreateHandler(
          workspaceCreate.input.parse({ name: "Data platform", slug: "data" }),
          keyCall,
        ),
      );
      expect(created.orgSlug).toBe(orgSlug);
      const [createdRow] = await withSystemDb((tx) =>
        tx
          .select({
            id: schema.workspaces.id,
            createdByUserId: schema.workspaces.createdByUserId,
          })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.publicId, created.publicId)),
      );
      expect(createdRow?.createdByUserId).toBe(userId);
      await expect(
        refusal(
          scoped(() =>
            workspaceCreateHandler(
              workspaceCreate.input.parse({ name: "Again", slug: "data" }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "slug_taken" });

      const list = (includeArchived: boolean) =>
        workspaceListHandler(
          workspaceList.input.parse({ orgSlug, includeArchived }),
          { ...admin, orgId: "", workspaceId: "" },
        );
      expect((await list(false)).workspaces.map((w) => w.slug).sort()).toEqual([
        "core",
        "data",
      ]);

      // An agent registered in the workspace holds the archive; the seeded
      // qa-chat agent does not.
      const [agent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId: createdRow!.id,
            slug: "ingest",
            name: "ingest",
            agentType: "sdk",
            createdByUserId: userId,
          })
          .returning({ id: schema.agents.id }),
      );
      await expect(
        refusal(
          scoped(() =>
            workspaceArchiveHandler(
              workspaceArchive.input.parse({ workspaceId: created.publicId }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "workspace_has_agents" });
      await withSystemDb((tx) =>
        tx
          .update(schema.agents)
          .set({ status: "archived" })
          .where(eq(schema.agents.id, agent!.id)),
      );

      const archived = await scoped(() =>
        workspaceArchiveHandler(
          workspaceArchive.input.parse({ workspaceId: created.publicId }),
          admin,
        ),
      );
      expect(archived.slug).toBe("data");
      expect((await list(false)).workspaces.map((w) => w.slug)).toEqual([
        "core",
      ]);
      const withArchived = (await list(true)).workspaces;
      expect(withArchived.find((w) => w.slug === "data")?.archivedAt).toBe(
        archived.archivedAt,
      );
      expect(
        withArchived.find((w) => w.slug === "core")?.archivedAt,
      ).toBeNull();

      await expect(
        refusal(
          scoped(() =>
            workspaceArchiveHandler(
              workspaceArchive.input.parse({ workspaceId: created.publicId }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "already_archived" });

      // The slug stays taken.
      await expect(
        refusal(
          scoped(() =>
            workspaceCreateHandler(
              workspaceCreate.input.parse({ name: "Data again", slug: "data" }),
              admin,
            ),
          ),
        ),
      ).resolves.toEqual({ code: "conflict", reason: "slug_taken" });
    });
  },
);
