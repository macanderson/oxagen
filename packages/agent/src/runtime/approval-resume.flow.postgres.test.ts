/**
 * The approval path end to end against Postgres (#3127, ADR-118): a turn
 * parks a call, the person approves it through `resolve_approval`, and the
 * call runs once through the kernel, with the person's access and the
 * organization's credit read again at that moment. A worker pass, a second
 * decision, and the next turn's identical call run nothing more. A re-check
 * that refuses at the call leaves the call unrun and names the refusal.
 *
 * Postgres is real, so "once" is the real conditional claim on the approval
 * row, and the park, the decision, the delivery and the read-back all go
 * through their own SQL. The capability and its handler are registered here,
 * and the real kernel runs them. Replaced are the parts that need fixtures
 * this suite does not own: the person's roles, the tool listing, the kill
 * switches, and the assistant run. The IAM and credit gates are stubs, so the
 * suite can see when they were read.
 *
 * The parked rows here name no run, so `inAppApproval()` reads false and the
 * rule that only the person who asked may answer an in-app approval (ADR-235)
 * is not exercised. `agent.approval.resolve.test.ts` covers that rule.
 *
 * `apps/app/e2e/` holds only login, pay and page-load (apps/app/ARCHITECTURE.md
 * §6.3), so this suite is the proof that approving a parked call makes it run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema, withSystemDb } from "@oxagen/database";
import { getCapability, registerCapability } from "@oxagen/oxagen";
import {
  clearBillingAdmissionGate,
  clearKernelIAMRuntime,
  registerHandler,
  setBillingAdmissionGate,
  setKernelIAMRuntime,
  type KernelIAMCheckFn,
} from "@oxagen/oxagen/kernel";
import type { CheckedContext } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { createApprovalRequest } from "./approval";
import { listApprovalResumes, resumeApprovedCall } from "./approval-resume";
import { agentApprovalResolveHandler } from "../handlers/agent.approval.resolve";
import { agentApprovalListResolvedHandler } from "../handlers/agent.approval.list_resolved";

const h = vi.hoisted(() => ({
  roles: vi.fn(),
  tools: vi.fn(),
  kill: vi.fn(),
  open: vi.fn(),
}));

// The handler's role gate passes, and the resume's role read is the stub
// below, so a case can revoke the person's access between park and approval.
vi.mock("@oxagen/iam/org-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/iam/org-role")>()),
  resolveActingUserId: async (ctx: { userId: string | null }) => ctx.userId,
  assertOrgRole: async () => undefined,
  resolveActorOrgRoles: h.roles,
  resolveActorWorkspaceRoles: h.roles,
}));
// The bootstraps would install the production gates. The suite installs its
// own stubs on the kernel instead, and they stay installed.
vi.mock("@oxagen/iam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/iam")>()),
  bootstrapIAMRuntime: vi.fn(),
}));
vi.mock("@oxagen/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/billing")>()),
  bootstrapBillingRuntime: vi.fn(),
}));
vi.mock("@oxagen/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/plugins")>()),
  bootstrapEntitlementRuntime: vi.fn(),
}));
vi.mock("@oxagen/rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/rules")>()),
  bootstrapDecisionRulesRuntime: vi.fn(),
}));
vi.mock("./materialize-tools", () => ({ materializeTools: h.tools }));
vi.mock("./kill-switch-gate", () => ({
  createKillSwitchGate: () => ({ check: h.kill }),
}));
vi.mock("./assistant-run", () => ({
  openAssistantRun: h.open,
  readAssistantAgentState: async () => ({
    agentId: "agt_stella",
    principalId: "prn_stella",
    stoppedBy: null,
  }),
}));

const CAPABILITY = "test.resume_flow_write";
const RESUMED_RUN = "arun_flow_resumed";

/** The approved write's handler: the one place the call's effect happens. */
const write = vi.fn(async (_input: unknown, _ctx: unknown) => ({ ok: true }));
/** The kernel's IAM check at the call, read when the call runs. */
const iam = vi.fn<KernelIAMCheckFn>();
/** The kernel's credit gate at the call, read when the call runs. */
const credit = vi.fn<(orgId: string) => Promise<void>>();

const recorder = {
  runId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
  runPublicId: RESUMED_RUN,
  toolCallStarted: vi.fn(),
  toolCall: vi.fn(),
  seal: vi.fn(),
};

describe.skipIf(!process.env.DATABASE_URL)(
  "approving a parked call against Postgres",
  () => {
    const orgIds: string[] = [];

    /** A fresh organization, workspace, person and conversation with three user messages. */
    async function tenant() {
      const orgId = crypto.randomUUID();
      const workspaceId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const messages = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      orgIds.push(orgId);
      await withSystemDb(async (tx) => {
        await tx.insert(schema.conversations).values({
          id: conversationId,
          orgId,
          workspaceId,
          userId,
          status: "active",
        });
        await tx.insert(schema.messages).values(
          messages.map((id) => ({
            id,
            orgId,
            workspaceId,
            conversationId,
            role: "user",
            content: "approve fixture",
            contentBlocks: [],
          })),
        );
      });
      const scope = { orgId, workspaceId };
      const within = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
      const ctx = (): CheckedContext => ({
        orgId,
        workspaceId,
        userId,
        apiKeyId: null,
        requestId: crypto.randomUUID(),
        surface: "app",
        messageId: null,
      });
      const park = (messageId: string, input: { note: string }) =>
        within(() =>
          createApprovalRequest({
            orgId,
            workspaceId,
            messageId,
            capabilityName: CAPABILITY,
            inputPreview: input,
            digestInput: input,
            riskLevel: "high",
            resumeRequesterUserId: userId,
          }),
        );
      const decide = (approvalId: string) =>
        within(() =>
          agentApprovalResolveHandler(
            { approvalId, decision: "approved" },
            ctx(),
          ),
        );
      const history = async (publicId: string) => {
        const read = await within(() =>
          agentApprovalListResolvedHandler(
            agentApprovalListResolved.input.parse({}),
            ctx(),
          ),
        );
        return read.items.find((item) => item.id === publicId)?.execution;
      };
      const requested = async () => {
        const rows = await withSystemDb((tx) =>
          tx
            .select({ id: schema.notifications.id })
            .from(schema.notifications)
            .where(
              and(
                eq(schema.notifications.orgId, orgId),
                eq(schema.notifications.event, "approval.requested"),
              ),
            ),
        );
        return rows.length;
      };
      return {
        scope,
        userId,
        messages,
        park,
        decide,
        history,
        requested,
      };
    }

    beforeAll(() => {
      vi.stubEnv(
        "AUTH_TOKEN_ENCRYPTION_KEY",
        Buffer.alloc(32, 17).toString("base64"),
      );
      if (!getCapability(CAPABILITY)) {
        registerCapability({
          name: CAPABILITY,
          domain: "test",
          description: "The write a parked call asked for.",
          mode: "sync" as const,
          surfaces: ["agent"] as const,
          layers: ["unit"] as const,
          sensitivity: "low" as const,
          defaultEffect: "allow" as const,
          defaultRoles: { org: {}, workspace: {} },
          input: z.object({ note: z.string() }),
          output: z.object({ ok: z.boolean() }),
        });
      }
      registerHandler(CAPABILITY, async () => write);
      setKernelIAMRuntime(iam, /* enforced */ true);
      setBillingAdmissionGate(credit);
    });

    beforeEach(() => {
      write.mockImplementation(async () => ({ ok: true }));
      iam.mockImplementation(async () => ({ outcome: "allow", principal: null }));
      credit.mockImplementation(async () => undefined);
      h.roles.mockResolvedValue(["Member"]);
      h.tools.mockResolvedValue({ nameMap: { [CAPABILITY]: CAPABILITY } });
      h.kill.mockResolvedValue(null);
      h.open.mockResolvedValue(recorder);
    });

    afterAll(async () => {
      clearKernelIAMRuntime();
      clearBillingAdmissionGate();
      if (orgIds.length > 0) {
        await withSystemDb(async (tx) => {
          await tx
            .delete(schema.approvalRequests)
            .where(inArray(schema.approvalRequests.orgId, orgIds));
          await tx
            .delete(schema.notifications)
            .where(inArray(schema.notifications.orgId, orgIds));
          await tx
            .delete(schema.messages)
            .where(inArray(schema.messages.orgId, orgIds));
          await tx
            .delete(schema.conversations)
            .where(inArray(schema.conversations.orgId, orgIds));
        });
      }
      vi.unstubAllEnvs();
    });

    it("runs the approved call once, reads access and credit again at the call, and runs nothing on a retry", async () => {
      const t = await tenant();
      const input = { note: "runs once" };
      // Two turns ask for the same write. One row holds it, and one card
      // reaches the person.
      const parked = await Promise.all(
        [t.messages[0]!, t.messages[1]!].map((m) => t.park(m, input)),
      );
      expect(parked[0]!.approvalId).toBe(parked[1]!.approvalId);
      const approval = parked[0]!;
      expect(await t.requested()).toBe(1);
      // Nothing about the call is decided while it waits.
      expect(h.roles).not.toHaveBeenCalled();
      expect(h.tools).not.toHaveBeenCalled();
      expect(iam).not.toHaveBeenCalled();
      expect(credit).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();

      const out = await t.decide(approval.approvalPublicId);
      expect(out.resolution).toBe("approved");
      expect(out.execution).toEqual({
        status: "succeeded",
        runId: RESUMED_RUN,
        reason: null,
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(
        input,
        expect.objectContaining({ userId: t.userId }),
      );
      // Read again at the call, as the person who asked: their roles, the
      // listing those roles admit, the kill switches, IAM and credit.
      expect(h.roles).toHaveBeenCalled();
      expect(h.tools).toHaveBeenCalledTimes(1);
      expect(h.tools).toHaveBeenCalledWith(
        expect.objectContaining({ userId: t.userId }),
        expect.objectContaining({
          allowlist: new Set([CAPABILITY]),
          callerRoles: { org: ["Member"], workspace: ["Member"] },
        }),
      );
      expect(h.kill).toHaveBeenCalledWith({
        capabilityId: CAPABILITY,
        readOnly: false,
      });
      expect(iam).toHaveBeenCalledTimes(1);
      expect(iam).toHaveBeenCalledWith(
        expect.objectContaining({ capability: CAPABILITY }),
      );
      expect(credit).toHaveBeenCalledWith(t.scope.orgId);

      // The worker's next pass finds nothing left to deliver, and a delivery
      // that arrives anyway claims nothing.
      expect(await listApprovalResumes(t.scope)).toEqual([]);
      expect(
        await resumeApprovedCall({ id: approval.approvalId, ...t.scope }),
      ).toBe("not_claimed");
      // A second decision on the same approval is refused.
      await expect(t.decide(approval.approvalPublicId)).rejects.toMatchObject({
        reason: "approval_expired",
      });
      // The next turn asks for the same write and gets the decided row back,
      // with no new card.
      const again = await t.park(t.messages[2]!, input);
      expect(again).toMatchObject({
        approvalId: approval.approvalId,
        resolution: "approved",
        resumeStatus: "succeeded",
        resumeError: null,
      });
      expect(await t.requested()).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(await t.history(approval.approvalPublicId)).toEqual({
        status: "succeeded",
        runId: RESUMED_RUN,
        reason: null,
      });
    });

    it("runs the call once when the worker races the deciding request", async () => {
      const t = await tenant();
      const approval = await t.park(t.messages[0]!, { note: "raced" });
      const ref = { id: approval.approvalId, ...t.scope };
      await Promise.all([
        t.decide(approval.approvalPublicId),
        resumeApprovedCall(ref),
        resumeApprovedCall(ref),
      ]);
      expect(write).toHaveBeenCalledTimes(1);
      expect(await t.history(approval.approvalPublicId)).toEqual({
        status: "succeeded",
        runId: RESUMED_RUN,
        reason: null,
      });
    });

    it("delivers a call the deciding request left queued through the worker, once", async () => {
      const t = await tenant();
      const approval = await t.park(t.messages[0]!, { note: "worker" });
      // The deciding process committed the decision and stopped before it
      // could deliver the call: the row is approved and still queued.
      await withSystemDb((tx) =>
        tx
          .update(schema.approvalRequests)
          .set({
            resolution: "approved",
            resolvedAt: new Date(),
            resolvedByUserId: t.userId,
            resumeStatus: "queued",
          })
          .where(
            and(
              eq(schema.approvalRequests.id, approval.approvalId),
              eq(schema.approvalRequests.orgId, t.scope.orgId),
            ),
          ),
      );
      const pass = async () => {
        const outcomes: string[] = [];
        for (const ref of await listApprovalResumes(t.scope))
          outcomes.push(await resumeApprovedCall(ref));
        return outcomes;
      };
      expect(await pass()).toEqual(["succeeded"]);
      expect(await pass()).toEqual([]);
      expect(write).toHaveBeenCalledTimes(1);
      expect(iam).toHaveBeenCalledTimes(1);
      expect(credit).toHaveBeenCalledTimes(1);
    });

    // Each re-check refuses before the handler starts. The call never runs,
    // the row says `failed` with the refusal's code, and the decision, the
    // history and the next turn all read that code back. Before #3127 the
    // IAM and credit refusals read as `indeterminate`: the person was told
    // the outcome was unknown for a call that never ran.
    const refusals: Array<{
      name: string;
      change: () => void;
      reason: string;
      runId: string | null;
    }> = [
      {
        name: "the person's access was revoked",
        change: () => h.roles.mockResolvedValue([]),
        reason: "requester_access_revoked",
        // Refused before the resume opened its run.
        runId: null,
      },
      {
        name: "IAM now denies the call",
        change: () =>
          iam.mockImplementation(async () => ({
            outcome: "deny",
            principal: null,
          })),
        reason: "authz_denied",
        runId: RESUMED_RUN,
      },
      {
        name: "the organization ran out of credit",
        change: () =>
          credit.mockImplementation(async () => {
            throw Object.assign(new Error("out of credit"), {
              code: "gau_exhausted",
            });
          }),
        reason: "gau_exhausted",
        runId: RESUMED_RUN,
      },
    ];
    it.each(refusals)(
      "refuses the call when $name, and says why",
      async ({ change, reason, runId }) => {
        const t = await tenant();
        const input = { note: reason };
        const approval = await t.park(t.messages[0]!, input);
        change();
        const out = await t.decide(approval.approvalPublicId);
        const refused = { status: "failed", runId, reason };
        expect(out.execution).toEqual(refused);
        expect(write).not.toHaveBeenCalled();
        expect(await t.history(approval.approvalPublicId)).toEqual(refused);
        // The next turn hears the refusal instead of parking the call again.
        expect(await t.park(t.messages[1]!, input)).toMatchObject({
          approvalId: approval.approvalId,
          resolution: "approved",
          resumeStatus: "failed",
          resumeError: reason,
        });
        // A refusal is final for this approval.
        expect(
          await resumeApprovedCall({ id: approval.approvalId, ...t.scope }),
        ).toBe("not_claimed");
        expect(write).not.toHaveBeenCalled();
      },
    );
  },
);
