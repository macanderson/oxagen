import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, and } from "drizzle-orm";
import { createApprovalRequest } from "./approval";
import { resumeApprovedCall } from "./approval-resume";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { agentApprovalListResolvedHandler } from "../handlers/agent.approval.list_resolved";

// CI supplies a migrated Postgres. No capability handler or model is invoked.
describe.skipIf(!process.env.DATABASE_URL)(
  "stored approvals against Postgres",
  () => {
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messages = [crypto.randomUUID(), crypto.randomUUID()];
    const scope = { orgId, workspaceId };
    const within = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
    const args = (messageId: string) => ({
      ...scope,
      messageId,
      capabilityName: "missing_resume_fixture",
      inputPreview: { secret: "stored fixture secret" },
      digestInput: { secret: "stored fixture secret" },
      riskLevel: "high" as const,
      resumeRequesterUserId: userId,
    });

    beforeAll(async () => {
      vi.stubEnv(
        "AUTH_TOKEN_ENCRYPTION_KEY",
        Buffer.alloc(32, 17).toString("base64"),
      );
      await withSystemDb(async (tx) => {
        await tx
          .insert(schema.conversations)
          .values({ id: conversationId, ...scope, userId, status: "active" });
        await tx.insert(schema.messages).values(
          messages.map((id) => ({
            id,
            ...scope,
            conversationId,
            role: "user",
            content: "approve fixture",
            contentBlocks: [],
          })),
        );
      });
    });
    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.approvalRequests)
          .where(eq(schema.approvalRequests.orgId, orgId));
        await tx
          .delete(schema.messages)
          .where(eq(schema.messages.orgId, orgId));
        await tx
          .delete(schema.conversations)
          .where(eq(schema.conversations.orgId, orgId));
      });
      vi.unstubAllEnvs();
    });

    it("deduplicates concurrent turns, claims once, and reads the refusal back", async () => {
      const parked = await Promise.all(
        messages.map((messageId) =>
          within(() => createApprovalRequest(args(messageId))),
        ),
      );
      expect(parked[0]?.approvalId).toBe(parked[1]?.approvalId);
      const id = parked[0]!.approvalId;
      const row = await withSystemDb((tx) =>
        tx.query.approvalRequests.findFirst({
          where: eq(schema.approvalRequests.id, id),
        }),
      );
      expect(JSON.stringify(row?.resumePayload)).not.toContain(
        "stored fixture secret",
      );
      expect(JSON.stringify(row?.inputPreview)).not.toContain(
        "stored fixture secret",
      );
      await withSystemDb((tx) =>
        tx
          .update(schema.approvalRequests)
          .set({
            resolution: "approved",
            resolvedAt: new Date(),
            resolvedByUserId: userId,
            resumeStatus: "queued",
          })
          .where(
            and(
              eq(schema.approvalRequests.id, id),
              eq(schema.approvalRequests.orgId, orgId),
            ),
          ),
      );
      const ref = { id, ...scope };
      expect(
        (
          await Promise.all([resumeApprovedCall(ref), resumeApprovedCall(ref)])
        ).sort(),
      ).toEqual(["failed", "not_claimed"]);
      const reused = await within(() =>
        createApprovalRequest(args(messages[1]!)),
      );
      expect(reused).toMatchObject({
        approvalId: id,
        resolution: "approved",
        resumeStatus: "failed",
      });
      const history = await within(() =>
        agentApprovalListResolvedHandler(
          agentApprovalListResolved.input.parse({}),
          {
            ...scope,
            userId,
            apiKeyId: null,
            requestId: crypto.randomUUID(),
            surface: "app",
            messageId: null,
          },
        ),
      );
      expect(
        history.items.find((item) => item.id === row?.publicId)?.execution,
      ).toEqual({
        status: "failed",
        runId: null,
        reason: "capability_removed",
      });
      expect(
        await resumeApprovedCall({ ...ref, workspaceId: crypto.randomUUID() }),
      ).toBe("not_claimed");
    });
  },
);
