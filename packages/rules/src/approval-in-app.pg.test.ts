/**
 * The in-app approval predicate against Postgres (ADR-235, ruled on
 * 2026-10-01).
 *
 * The rendering test beside this file (`approval-in-app.test.ts`) pins the
 * statement shape. This one proves the rows: which approvals the workspace's
 * queue keeps, which ones a person sees under a run, and that a person's
 * answer to an in-app approval never opens a workspace rule's standing
 * window (`lastHumanApprovalOf` in call-facts.ts). Runs in CI's Postgres job,
 * and locally with DATABASE_URL set. Skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(!process.env.DATABASE_URL)(
  "in-app approvals against Postgres",
  async () => {
    const { schema, withSystemDb, withTenantDb } = await import(
      "@oxagen/database"
    );
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { and, eq, inArray, isNull } = await import("drizzle-orm");
    const { inAppOnlyForAsker, notInAppApproval } = await import(
      "./approval-in-app"
    );
    const { inputDigest, lastHumanApprovalOf } = await import("./call-facts");

    const tag = Date.now().toString(36).slice(-6);
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const askerId = randomUUID();
    const otherId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runIds = {
      chat: randomUUID(),
      apiChat: randomUUID(),
      external: randomUUID(),
    };
    const runPublicIds: Record<keyof typeof runIds, string> = {
      chat: "",
      apiChat: "",
      external: "",
    };
    const ids: Record<string, string> = {};
    const NOW = Date.now();
    const inMinutes = (n: number) => new Date(NOW + n * 60_000);
    const CALL = { id: `thing_${tag}` };
    const digest = inputDigest(CALL);

    const inScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope({ orgId, workspaceId }, fn);
    const ar = schema.approvalRequests;

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.users).values([
          { id: askerId, email: `asker-${tag}@in-app.test`, status: "active" },
          { id: otherId, email: `other-${tag}@in-app.test`, status: "active" },
        ]);
        await tx.insert(schema.conversations).values({
          id: conversationId,
          orgId,
          workspaceId,
          userId: askerId,
          status: "active",
        });
        await tx.insert(schema.messages).values({
          id: messageId,
          orgId,
          workspaceId,
          conversationId,
          role: "user",
          content: "",
          contentBlocks: [],
        });
        const runs = await tx
          .insert(schema.agentRuns)
          .values([
            { id: runIds.chat, orgId, workspaceId, surface: "chat", spec: {} },
            {
              id: runIds.apiChat,
              orgId,
              workspaceId,
              surface: "api-chat",
              spec: {},
            },
            {
              id: runIds.external,
              orgId,
              workspaceId,
              surface: "external",
              spec: {},
            },
          ])
          .returning({
            id: schema.agentRuns.id,
            publicId: schema.agentRuns.publicId,
          });
        for (const run of runs) {
          const key = (Object.keys(runIds) as Array<keyof typeof runIds>).find(
            (k) => runIds[k] === run.id,
          )!;
          runPublicIds[key] = run.publicId;
        }
        const pending = (capabilityName: string, runPublicId: string | null) => ({
          orgId,
          workspaceId,
          messageId,
          capabilityName,
          inputPreview: {},
          riskLevel: "high",
          runPublicId,
          expiresAt: inMinutes(5),
        });
        const approved = (capabilityName: string, runPublicId: string) => ({
          ...pending(capabilityName, runPublicId),
          inputDigest: digest,
          resolution: "approved",
          resolvedAt: inMinutes(-1),
          resolvedByUserId: askerId,
        });
        const rows = await tx
          .insert(ar)
          .values([
            pending("in_app_chat", runPublicIds.chat),
            pending("in_app_api_chat", runPublicIds.apiChat),
            pending("external_run", runPublicIds.external),
            // A wrapped agent's session never names an agent_runs row.
            pending("tacho_session", "tse_0123456789abcdefghjkmn"),
            pending("no_run", null),
            approved("standing_in_app", runPublicIds.chat),
            approved("standing_workspace", runPublicIds.external),
          ])
          .returning({ publicId: ar.publicId, capabilityName: ar.capabilityName });
        for (const row of rows) ids[row.capabilityName] = row.publicId;
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.delete(ar).where(eq(ar.orgId, orgId));
        await tx
          .delete(schema.agentRuns)
          .where(inArray(schema.agentRuns.id, Object.values(runIds)));
        await tx.delete(schema.messages).where(eq(schema.messages.id, messageId));
        await tx
          .delete(schema.conversations)
          .where(eq(schema.conversations.id, conversationId));
        await tx
          .delete(schema.users)
          .where(inArray(schema.users.id, [askerId, otherId]));
      });
    });

    const pendingTools = (where: ReturnType<typeof notInAppApproval>) =>
      inScope(() =>
        withTenantDb(async (tx) =>
          (
            await tx
              .select({ tool: ar.capabilityName })
              .from(ar)
              .where(
                and(
                  eq(ar.orgId, orgId),
                  eq(ar.workspaceId, workspaceId),
                  isNull(ar.resolution),
                  where,
                ),
              )
          )
            .map((r) => r.tool)
            .sort(),
        ),
      );

    it("keeps every approval but the in-app ones on the workspace's queue", async () => {
      expect(await pendingTools(notInAppApproval())).toEqual([
        "external_run",
        "no_run",
        "tacho_session",
      ]);
    });

    it("shows the person who asked their in-app approvals through a relational read", async () => {
      const read = (userId: string | null) =>
        inScope(() =>
          withTenantDb(async (tx) =>
            (
              await tx.query.approvalRequests.findMany({
                where: and(
                  eq(ar.orgId, orgId),
                  eq(ar.runPublicId, runPublicIds.chat),
                  inAppOnlyForAsker(userId),
                ),
                columns: { capabilityName: true },
              })
            )
              .map((r) => r.capabilityName)
              .sort(),
          ),
        );
      expect(await read(askerId)).toEqual(["in_app_chat", "standing_in_app"]);
      // Another member of the workspace sees nothing under that run.
      expect(await read(otherId)).toEqual([]);
      // Nor does a caller with no acting user.
      expect(await read(null)).toEqual([]);
    });

    it("never reads a person's answer to an in-app approval as a standing approval", async () => {
      const standing = (capability: string) =>
        inScope(() =>
          withTenantDb((tx) =>
            lastHumanApprovalOf(tx, workspaceId, capability, digest),
          ),
        );
      // The same person approved the same input both times. Only the
      // workspace's own approval opens a rule's window.
      expect(await standing("standing_in_app")).toBeNull();
      expect((await standing("standing_workspace"))?.toISOString()).toBe(
        inMinutes(-1).toISOString(),
      );
    });
  },
);
