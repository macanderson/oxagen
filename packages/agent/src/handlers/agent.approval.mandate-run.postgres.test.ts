/**
 * A call the mandate gate parks names the run that raised it (#3478), so the
 * run's approvals list finds it and the run cannot answer it (ADR-175).
 *
 * The gate is the real one: `bootstrapDecisionRulesRuntime` builds it with the
 * real mandate check, and the kernel slot it registers into is read back here
 * instead of resolving an agent principal through IAM. The mandate, the
 * declared tool, the run, and the person who may resolve approvals are
 * seeded in Postgres. `list_approvals` and `resolve_approval` are the real
 * handlers.
 *
 * Before #3478 the gate wrote the row with no run. The filtered list came
 * back empty, and the run's own answer reached the mandate checks instead of
 * being refused as the run's.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type CapturedGate = (args: unknown) => Promise<unknown>;

const captured = vi.hoisted(() => ({ gate: null as CapturedGate | null }));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen/kernel")>()),
  setDecisionRulesGate: (gate: CapturedGate) => {
    captured.gate = gate;
  },
}));

describe.skipIf(!process.env.DATABASE_URL)(
  "a mandate-parked approval against Postgres",
  async () => {
    const { schema, withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq, inArray } = await import("drizzle-orm");
    const { bootstrapDecisionRulesRuntime } = await import("@oxagen/rules");
    const { agentApprovalList } = await import(
      "@oxagen/oxagen/contracts/agent.approval.list"
    );
    const { agentApprovalListHandler } = await import(
      "./agent.approval.list"
    );
    const { agentApprovalResolveHandler } = await import(
      "./agent.approval.resolve"
    );

    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const principalId = randomUUID();
    const roleId = randomUUID();
    const agentPrincipalId = randomUUID();
    const toolId = randomUUID();
    const versionId = randomUUID();
    const mandateId = randomUUID();
    const runId = randomUUID();
    let runPublicId = "";
    const scope = { orgId, workspaceId };
    const inScope = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
    const ctx = (extra: { runId?: string } = {}) => ({
      ...scope,
      userId,
      apiKeyId: null,
      requestId: randomUUID(),
      surface: "app" as const,
      messageId: null,
      ...extra,
    });

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.tools).values({
          id: toolId,
          orgId,
          workspaceId,
          name: "stripe__create_payment",
          slug: "stripe__create_payment",
          source: "custom",
          enabled: true,
        });
        await tx.insert(schema.toolVersions).values({
          id: versionId,
          orgId,
          workspaceId,
          toolId,
          versionNumber: 1,
          isLatest: true,
          inputSchema: {},
          riskGrade: "high",
          manifest: {},
          checksum: "0".repeat(64),
          impacts: ["moves_money"],
          measures: {
            amount: {
              path: "amount.value",
              type: "amount",
              unit: "USD",
              scale: 2,
            },
          },
          effectIdPath: "payment.id",
        });
        await tx
          .update(schema.tools)
          .set({ activeVersionId: versionId })
          .where(eq(schema.tools.id, toolId));
        await tx.insert(schema.mandates).values({
          id: mandateId,
          orgId,
          workspaceId,
          agentPrincipalId,
          grantedBy: randomUUID(),
          roleAtGrant: "Billing",
          impacts: ["moves_money"],
          limits: {
            amount: {
              perCall: "250000000",
              perPeriod: "2000000000",
              period: "monthly",
              currencyOrUnit: "USD",
            },
          },
          targets: {},
          tools: ["stripe__create_payment@*"],
          // Every payment over $100 waits for a person.
          approvalRules: {
            humanAbove: { amount: "100000000" },
            alwaysHumanFor: [],
            approvers: [],
          },
          purpose: "test",
          validFrom: new Date("2026-01-01T00:00:00Z"),
          validTo: new Date("2099-12-31T23:59:59Z"),
          status: "active",
        });
        const [run] = await tx
          .insert(schema.agentRuns)
          .values({
            id: runId,
            orgId,
            workspaceId,
            // A customer agent's run. "chat" and "api-chat" are the in-app
            // assistant's surfaces, and only the person who asked sees an
            // approval parked on one of those runs (ADR-235).
            surface: "external",
            spec: {},
          })
          .returning({ publicId: schema.agentRuns.publicId });
        runPublicId = run!.publicId;
        // An org Owner: a role `resolve_approval` admits, so the call reaches
        // the run check instead of stopping at the role gate.
        await tx.insert(schema.roles).values({
          id: roleId,
          orgId,
          scopeKind: "org",
          name: "Owner",
          isSystemDefault: true,
        });
        await tx.insert(schema.principals).values({
          id: principalId,
          orgId,
          kind: "human",
          displayName: "Approver",
          status: "active",
          parentUserId: userId,
        });
        await tx.insert(schema.principalRoleAssignments).values({
          principalId,
          roleId,
          orgId,
          workspaceId: null,
        });
      });
      bootstrapDecisionRulesRuntime();
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.approvalRequests)
          .where(eq(schema.approvalRequests.orgId, orgId));
        await tx
          .delete(schema.mandateLedger)
          .where(eq(schema.mandateLedger.mandateId, mandateId));
        await tx.delete(schema.mandates).where(eq(schema.mandates.id, mandateId));
        // tools.active_version_id points at a version, so the tool goes first.
        await tx
          .delete(schema.tools)
          .where(eq(schema.tools.workspaceId, workspaceId));
        await tx
          .delete(schema.toolVersions)
          .where(eq(schema.toolVersions.workspaceId, workspaceId));
        await tx
          .delete(schema.agentRuns)
          .where(inArray(schema.agentRuns.id, [runId]));
        await tx
          .delete(schema.notifications)
          .where(eq(schema.notifications.orgId, orgId));
        await tx
          .delete(schema.principalRoleAssignments)
          .where(eq(schema.principalRoleAssignments.orgId, orgId));
        await tx
          .delete(schema.principals)
          .where(eq(schema.principals.orgId, orgId));
        await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
      });
    });

    it("lists the parked call under its run, and refuses that run an answer", async () => {
      const gate = captured.gate;
      expect(gate).not.toBeNull();

      // The agent's $150 payment, made inside the run: the mandate parks it.
      const parked = await inScope(async () => {
        try {
          await gate!({
            capability: "stripe__create_payment",
            input: { amount: { value: "150.00" } },
            ctx: { orgId, workspaceId, userId: null, runId },
            principal: {
              id: agentPrincipalId,
              kind: "agent",
              orgId,
              workspaceId,
            },
          });
          return null;
        } catch (error) {
          return error as { code?: string; accessRequestId?: string };
        }
      });
      expect(parked).toMatchObject({ code: "pending_approval" });
      const approvalId = parked!.accessRequestId!;
      expect(approvalId).toMatch(/^apr_/);

      // The run's approvals list finds it; another run's does not.
      const listed = await inScope(() =>
        agentApprovalListHandler(
          agentApprovalList.input.parse({ runId: runPublicId }),
          ctx(),
        ),
      );
      expect(listed.items.map((item) => [item.id, item.runId])).toEqual([
        [approvalId, runPublicId],
      ]);
      expect(listed.items[0]?.mandateId).toMatch(/^mnd_/);
      const elsewhere = await inScope(() =>
        agentApprovalListHandler(
          agentApprovalList.input.parse({ runId: "arun_someotherrun" }),
          ctx(),
        ),
      );
      expect(elsewhere.items).toEqual([]);

      // The run that raised it cannot answer it, though it acts as an Owner.
      await expect(
        inScope(() =>
          agentApprovalResolveHandler(
            { approvalId, decision: "approved" },
            ctx({ runId }),
          ),
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        reason: "run_cannot_resolve_own_approval",
      });
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ resolution: schema.approvalRequests.resolution })
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.publicId, approvalId)),
      );
      expect(row?.resolution).toBeNull();
    });
  },
);
