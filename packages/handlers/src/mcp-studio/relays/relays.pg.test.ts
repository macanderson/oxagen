/**
 * mcp.relays against Postgres (M12, #4685). Runs in the CI Postgres job and
 * locally with DATABASE_URL set, and is skipped otherwise.
 *
 * The role gate is the shared double from test-utils: the gate runs for real
 * against a transaction that answers an org Owner, so no IAM rows are seeded.
 * Everything else, the handlers, the store, the verifier, and the table's
 * constraints, runs against the real database.
 *
 * What is asserted:
 *   index    — the partial unique index refuses a second live row with one
 *              name in one workspace (23505 on relays_workspace_name_live_uq),
 *              allows the name in another workspace, and allows it again once
 *              the first row is revoked
 *   create   — the row holds the SHA-256 of the returned token, not the token
 *   revoke   — a caller in another workspace cannot revoke the relay, and a
 *              second revoke answers not_found
 *   verifier — a live token names its organization, workspace, and relay, and
 *              the same token answers null once revoked
 */
import { randomUUID } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("../../test-utils/org-role-gate")).orgRoleModule(),
);

describe.skipIf(!process.env.DATABASE_URL)(
  "mcp.relays against Postgres",
  async () => {
    const { closeDatabase, isUniqueViolation, schema, withSystemDb } =
      await import("@oxagen/database");
    const { eq } = await import("drizzle-orm");
    const { hashRelayToken, generateRelayToken } = await import(
      "@oxagen/relay-broker/tokens"
    );
    const { toolRelayCreateHandler } = await import("./create");
    const { toolRelayRevokeHandler } = await import("./revoke");
    const { postgresRelayTokenVerifier } = await import("./verifier");
    const { insertRelay } = await import("./store");

    const tag = Date.now().toString(36).slice(-6);
    const orgId = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const userId = randomUUID();
    let workspaceAPublicId = "";

    const ctx = (workspaceId: string): CapabilityContext => ({
      orgId,
      workspaceId,
      userId,
      apiKeyId: null,
      requestId: `req_${tag}`,
      surface: "api",
      messageId: null,
    });

    /** The stored rows for a name in a workspace, oldest first. */
    const rowsNamed = (workspaceId: string, name: string) =>
      withSystemDb((tx) =>
        tx
          .select({
            tokenHash: schema.mcpRelays.tokenHash,
            revokedAt: schema.mcpRelays.revokedAt,
            revokedById: schema.mcpRelays.revokedById,
            workspaceId: schema.mcpRelays.workspaceId,
            name: schema.mcpRelays.name,
          })
          .from(schema.mcpRelays)
          .where(eq(schema.mcpRelays.workspaceId, workspaceId))
          .orderBy(schema.mcpRelays.createdAt),
      ).then((rows) => rows.filter((r) => r.name === name));

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.organizations).values({
          id: orgId,
          name: `Relays ${tag}`,
          slug: `relays-${tag}`,
          namespace: `r${tag.slice(0, 5)}`,
          planType: "free",
          status: "active",
        });
        const [a] = await tx
          .insert(schema.workspaces)
          .values({
            id: workspaceA,
            orgId,
            name: "Relays A",
            slug: `relays-a-${tag}`,
            namespace: "rlya",
          })
          .returning({ publicId: schema.workspaces.publicId });
        workspaceAPublicId = a!.publicId;
        await tx.insert(schema.workspaces).values({
          id: workspaceB,
          orgId,
          name: "Relays B",
          slug: `relays-b-${tag}`,
          namespace: "rlyb",
        });
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.mcpRelays)
          .where(eq(schema.mcpRelays.orgId, orgId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      });
      await closeDatabase();
    });

    it("stores the SHA-256 of the returned token, never the token", async () => {
      const out = await toolRelayCreateHandler(
        { name: "office-lan" },
        ctx(workspaceA),
      );
      const [row] = await rowsNamed(workspaceA, "office-lan");
      expect(row!.tokenHash).toBe(hashRelayToken(out.token));
      expect(row!.tokenHash).not.toBe(out.token);
      expect(out.publicId).toMatch(/^rly_[0-9a-z]{22}$/);
    });

    it("refuses a second live relay with the same name in the workspace", async () => {
      await expect(
        toolRelayCreateHandler({ name: "office-lan" }, ctx(workspaceA)),
      ).rejects.toMatchObject({ code: "conflict", reason: "relay_name_taken" });

      // Past the handler's pre-check, the partial unique index refuses it.
      const err = await withSystemDb((tx) =>
        insertRelay(tx, {
          scope: { orgId, workspaceId: workspaceA },
          workspacePublicId: workspaceAPublicId,
          name: "office-lan",
          tokenHash: hashRelayToken(generateRelayToken()),
          createdById: userId,
          createdAt: new Date(),
        }),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isUniqueViolation(err, "relays_workspace_name_live_uq")).toBe(
        true,
      );
    });

    it("allows the same name in another workspace", async () => {
      await expect(
        toolRelayCreateHandler({ name: "office-lan" }, ctx(workspaceB)),
      ).resolves.toMatchObject({ name: "office-lan" });
    });

    it("names the organization, workspace, and relay of a live token", async () => {
      const out = await toolRelayCreateHandler(
        { name: "billing-lan" },
        ctx(workspaceA),
      );
      await expect(postgresRelayTokenVerifier.verify(out.token)).resolves.toEqual(
        {
          orgId,
          workspaceId: workspaceA,
          workspacePublicId: workspaceAPublicId,
          relay: "billing-lan",
        },
      );
      await expect(
        postgresRelayTokenVerifier.verify(generateRelayToken()),
      ).resolves.toBeNull();
    });

    it("does not let a caller in another workspace revoke the relay", async () => {
      // Workspace B holds no relay named billing-lan. Workspace A does.
      await expect(
        toolRelayRevokeHandler({ name: "billing-lan" }, ctx(workspaceB)),
      ).rejects.toMatchObject({ code: "not_found", reason: "relay_not_found" });
      const [row] = await rowsNamed(workspaceA, "billing-lan");
      expect(row!.revokedAt).toBeNull();
      expect(row!.revokedById).toBeNull();
    });

    it("revokes the relay, refuses its token, and frees the name", async () => {
      const first = await rowsNamed(workspaceA, "office-lan");
      expect(first).toHaveLength(1);

      const out = await toolRelayRevokeHandler(
        { name: "office-lan" },
        ctx(workspaceA),
      );
      expect(Date.parse(out.revokedAt)).not.toBeNaN();
      const [revoked] = await rowsNamed(workspaceA, "office-lan");
      expect(revoked!.revokedAt).not.toBeNull();
      expect(revoked!.revokedById).toBe(userId);

      // Workspace B's relay of the same name stays live.
      const [other] = await rowsNamed(workspaceB, "office-lan");
      expect(other!.revokedAt).toBeNull();

      // A second revoke finds no live relay.
      await expect(
        toolRelayRevokeHandler({ name: "office-lan" }, ctx(workspaceA)),
      ).rejects.toMatchObject({ code: "not_found", reason: "relay_not_found" });

      // The name is free again, and only the new token verifies.
      const again = await toolRelayCreateHandler(
        { name: "office-lan" },
        ctx(workspaceA),
      );
      const rows = await rowsNamed(workspaceA, "office-lan");
      expect(rows).toHaveLength(2);
      await expect(
        postgresRelayTokenVerifier.verify(again.token),
      ).resolves.toMatchObject({ workspaceId: workspaceA, relay: "office-lan" });
    });

    it("answers null for a token once its relay is revoked", async () => {
      const out = await toolRelayCreateHandler(
        { name: "lab-lan" },
        ctx(workspaceA),
      );
      await expect(
        postgresRelayTokenVerifier.verify(out.token),
      ).resolves.not.toBeNull();
      await toolRelayRevokeHandler({ name: "lab-lan" }, ctx(workspaceA));
      await expect(
        postgresRelayTokenVerifier.verify(out.token),
      ).resolves.toBeNull();
    });
  },
);
