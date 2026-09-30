import { randomUUID } from "node:crypto";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTenants,
  cleanupUsers,
  seedTenant,
  type SeededTenant,
} from "@oxagen/agent/handlers/_agent-identity.test-support";
import {
  conversationExportSnapshotQuery,
  type ConversationExportSnapshot,
} from "./conversation-export-snapshot";
import { MAX_EXPORT_SOURCE_BYTES } from "./conversation-export-limits";

describe.skipIf(!process.env.DATABASE_URL)("conversation export SQL against Postgres", () => {
  let tenant: SeededTenant | undefined;

  beforeAll(async () => {
    tenant = await seedTenant();
  });

  afterAll(async () => {
    if (!tenant) return;
    await cleanupTenants([tenant.orgId]);
    await cleanupUsers([tenant.userId]);
  });

  async function fixture(
    check: (tx: Tx, conversation: { id: string; publicId: string }, scope: SeededTenant) => Promise<void>,
  ): Promise<void> {
    const scope = tenant;
    if (!scope) throw new Error("Export test tenant is missing");
    const rollback = new Error("Roll back export fixture");
    await expect(runInTenantScope(scope, () => withTenantDb(async (tx) => {
      const [conversation] = await tx.insert(schema.conversations).values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        title: "Export SQL fixture",
        status: "active",
      }).returning({ id: schema.conversations.id, publicId: schema.conversations.publicId });
      if (!conversation) throw new Error("Export fixture insertion failed");
      await check(tx, conversation, scope);
      throw rollback;
    }))).rejects.toBe(rollback);
  }

  it("returns no large payload when UTF-8 metadata exceeds the byte budget", async () => {
    await fixture(async (tx, conversation, scope) => {
      await tx.insert(schema.messages).values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        conversationId: conversation.id,
        role: "user",
        content: "Small visible text",
        contentBlocks: [],
        metadata: { hidden: "é".repeat(MAX_EXPORT_SOURCE_BYTES / 2) },
      });
      const [result] = await tx.execute<ConversationExportSnapshot>(
        conversationExportSnapshotQuery(conversation.publicId, scope.orgId, scope.workspaceId),
      );
      expect(result).toMatchObject({ messageCount: 1, sourceTooLarge: true, messages: null });
    });
  });

  it("accepts 500 messages and refuses the 501st without a partial export", async () => {
    await fixture(async (tx, conversation, scope) => {
      const row = {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        conversationId: conversation.id,
        role: "user",
        content: "Small message",
        contentBlocks: [],
      };
      await tx.insert(schema.messages).values(Array.from({ length: 500 }, () => ({ ...row })));
      const query = conversationExportSnapshotQuery(conversation.publicId, scope.orgId, scope.workspaceId);
      const [accepted] = await tx.execute<ConversationExportSnapshot>(query);
      expect(accepted?.messageCount).toBe(500);
      expect(accepted?.messages).toHaveLength(500);
      await tx.insert(schema.messages).values(row);
      const [rejected] = await tx.execute<ConversationExportSnapshot>(query);
      expect(rejected).toMatchObject({ messageCount: 501, messages: null });
      const foreign = await tx.execute<ConversationExportSnapshot>(
        conversationExportSnapshotQuery(conversation.publicId, scope.orgId, randomUUID()),
      );
      expect(foreign).toHaveLength(0);
    });
  });
});
