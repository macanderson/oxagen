/**
 * The auto-approval decision path against Postgres (ADR-070; issue #2970 §8).
 * Runs in the CI Postgres job and locally with DATABASE_URL set; skipped
 * otherwise.
 *
 * What is asserted:
 *   - the rule set loads out of the workspace settings bag, is cached, and a
 *     cleared cache re-reads it; a v1 document reads as no clause; a document
 *     that does not parse reads as no rule set at all
 *   - the subject the evaluator judges is assembled from the record: the
 *     declared tool's classification, every measure and target the version
 *     declares paths for, and the last time a person approved this digest
 *   - a qualifying rule writes an approval row that is already resolved, with
 *     `policy:<rule id>` as its approver, its token spent and no user on it —
 *     the receipt's evidence that no person looked
 *   - a rule that does not qualify writes nothing, and a workspace with no
 *     clause is never asked
 *   - the mandate park records the evaluation beside the row it parks and
 *     parks it anyway, because a mandate's own approval rule outranks any
 *     workspace rule
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe.skipIf(!process.env.DATABASE_URL)(
  "auto-approval against Postgres",
  async () => {
    const { schema, withSystemDb, withTenantDb } = await import(
      "@oxagen/database"
    );
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { and, eq } = await import("drizzle-orm");
    const { autoApproveParkedCall } = await import("./auto-approval-path");
    const { buildAutoApprovalSubject, inputDigest } = await import(
      "./call-facts"
    );
    const { decideMandate } = await import("./mandates");
    const { clearDecisionRulesCache, loadWorkspaceRuleSet } = await import(
      "./rule-store"
    );

    const tag = Date.now().toString(36).slice(-6);
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const toolId = randomUUID();
    const versionId = randomUUID();
    const userId = randomUUID();
    const mandateIds: string[] = [];
    const NOW = new Date("2026-09-16T12:00:00.000Z");

    const inScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope({ orgId, workspaceId }, fn);

    const RULE = {
      id: "small-vendor-payments",
      name: "Small vendor payments",
      tools: ["stripe__create_payment@*"],
      enabled: true,
      maxMeasures: { amount: "250000000" },
      allowTargets: { counterparty: ["vendor:*"] },
      standingWindowMs: null,
      businessHours: null,
      createdBy: null,
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const VERDICT = {
      effect: "require_approval" as const,
      ruleId: "approve-payments",
      description: "a person looks at a payment",
    };
    const CALL = { amount: { value: "12.50" }, vendor: "vendor:aws" };

    /** Write a rule set document into the workspace's settings bag. */
    async function storeRuleSet(document: unknown): Promise<void> {
      await withSystemDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ settings: { theme: "dark", decisionRules: document } })
          .where(eq(schema.workspaces.id, workspaceId)),
      );
      clearDecisionRulesCache();
    }

    const v2 = (rules: unknown[]) => ({
      schema: "oxagen.decision-rules.v2",
      rules: [],
      autoApproval: rules,
    });

    const approvalsOf = () =>
      withSystemDb((tx) =>
        tx
          .select()
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.workspaceId, workspaceId)),
      );

    const autoApprove = (input: unknown, rules: unknown[]) =>
      inScope(() =>
        autoApproveParkedCall({
          capability: "stripe__create_payment",
          input,
          ruleSet: v2(rules) as never,
          verdict: VERDICT,
          ctx: { orgId, workspaceId, userId },
          now: () => NOW,
        }),
      );

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.workspaces).values({
          id: workspaceId,
          orgId,
          name: "Finance",
          slug: `finance-auto-${tag}`,
          namespace: `fna${tag}`.slice(0, 6),
        });
        await tx.insert(schema.users).values({
          id: userId,
          email: `auto-${tag}@rules.test`,
          status: "active",
        });
        await tx.insert(schema.tools).values({
          id: toolId,
          orgId,
          workspaceId,
          name: "stripe__create_payment",
          slug: "stripe__create_payment",
          source: "builtin",
          enabled: true,
        });
        await tx.insert(schema.toolVersions).values({
          id: versionId,
          orgId,
          workspaceId,
          toolId,
          versionNumber: 3,
          isLatest: true,
          inputSchema: {},
          riskGrade: "high",
          manifest: {},
          checksum: "0".repeat(64),
          consequenceTags: ["moves_money"],
          measures: {
            amount: {
              path: "amount.value",
              type: "amount",
              unit: "USD",
              scale: 2,
            },
            counterparty: { path: "vendor", type: "text", unit: "vendor" },
          },
          effectIdPath: "payment.id",
        });
        await tx
          .update(schema.tools)
          .set({ activeVersionId: versionId })
          .where(eq(schema.tools.id, toolId));
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.approvalRequests)
          .where(eq(schema.approvalRequests.workspaceId, workspaceId));
        for (const id of mandateIds) {
          await tx
            .delete(schema.mandateLedger)
            .where(eq(schema.mandateLedger.mandateId, id));
          await tx.delete(schema.mandates).where(eq(schema.mandates.id, id));
        }
        // `tools.active_version_id` references `tool_versions.id`, so the
        // referencing rows go first (the order mandates.pg.test.ts uses).
        await tx
          .delete(schema.tools)
          .where(eq(schema.tools.workspaceId, workspaceId));
        await tx
          .delete(schema.toolVersions)
          .where(eq(schema.toolVersions.workspaceId, workspaceId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId));
        await tx.delete(schema.users).where(eq(schema.users.id, userId));
      });
    });

    beforeEach(async () => {
      clearDecisionRulesCache();
      await withSystemDb((tx) =>
        tx
          .delete(schema.approvalRequests)
          .where(eq(schema.approvalRequests.workspaceId, workspaceId)),
      );
    });

    // ── the store ────────────────────────────────────────────────────────────

    it("loads the clause out of the settings bag, caches it, and re-reads it once cleared", async () => {
      await storeRuleSet(v2([RULE]));
      const first = await inScope(() =>
        loadWorkspaceRuleSet({ orgId, workspaceId }),
      );
      expect(first?.autoApproval).toHaveLength(1);
      expect(first?.schema).toBe("oxagen.decision-rules.v2");

      // Cached: the row changes underneath and the loader still answers the
      // version it read.
      await withSystemDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ settings: { decisionRules: v2([]) } })
          .where(eq(schema.workspaces.id, workspaceId)),
      );
      expect(
        (await inScope(() => loadWorkspaceRuleSet({ orgId, workspaceId })))
          ?.autoApproval,
      ).toHaveLength(1);
      clearDecisionRulesCache(workspaceId);
      expect(
        (await inScope(() => loadWorkspaceRuleSet({ orgId, workspaceId })))
          ?.autoApproval,
      ).toHaveLength(0);
    });

    it("reads a v1 document as a rule set with no clause, and an unparseable one as none at all", async () => {
      await storeRuleSet({ schema: "oxagen.decision-rules.v1", rules: [] });
      expect(
        (await inScope(() => loadWorkspaceRuleSet({ orgId, workspaceId })))
          ?.autoApproval,
      ).toEqual([]);

      await storeRuleSet({ schema: "nonsense" });
      expect(
        await inScope(() => loadWorkspaceRuleSet({ orgId, workspaceId })),
      ).toBeNull();
    });

    it("answers null for a call with no workspace", async () => {
      expect(
        await loadWorkspaceRuleSet({ orgId, workspaceId: null }),
      ).toBeNull();
    });

    // ── the subject ──────────────────────────────────────────────────────────

    it("assembles the subject from the record: classification, measures, targets, standing approval", async () => {
      const digest = inputDigest(CALL);
      await withSystemDb((tx) =>
        tx.insert(schema.approvalRequests).values({
          orgId,
          workspaceId,
          capabilityName: "stripe__create_payment",
          inputPreview: {},
          riskLevel: "high",
          inputDigest: digest,
          resolution: "approved",
          resolvedAt: new Date("2026-09-16T09:00:00.000Z"),
          resolvedByUserId: userId,
          expiresAt: new Date("2026-09-17T00:00:00.000Z"),
        }),
      );
      const subject = await inScope(() =>
        withTenantDb((tx) =>
          buildAutoApprovalSubject(tx, {
            capability: "stripe__create_payment",
            input: CALL,
            workspaceId,
            now: NOW,
          }),
        ),
      );
      expect(subject.tool).toEqual({
        slug: "stripe__create_payment",
        version: 3,
        riskGrade: "high",
        consequenceTags: ["moves_money"],
      });
      expect(subject.measures).toEqual({ amount: "12500000" });
      expect(subject.targets).toEqual({ counterparty: "vendor:aws" });
      expect(subject.tainted).toBe(false);
      expect(subject.standingApprovalAt?.toISOString()).toBe(
        "2026-09-16T09:00:00.000Z",
      );
    });

    it("never reads a person's approval of a DIFFERENT capability with the same input", async () => {
      // The digest is over the input alone, so these two calls share one. A
      // person approving the first must not open a standing window for the
      // second (ADR-070 decision 3).
      const digest = inputDigest(CALL);
      await withSystemDb((tx) =>
        tx.insert(schema.approvalRequests).values({
          orgId,
          workspaceId,
          capabilityName: "stripe__refund_payment",
          inputPreview: {},
          riskLevel: "high",
          inputDigest: digest,
          resolution: "approved",
          resolvedAt: new Date("2026-09-16T09:00:00.000Z"),
          resolvedByUserId: userId,
          expiresAt: new Date("2026-09-17T00:00:00.000Z"),
        }),
      );
      const other = await inScope(() =>
        withTenantDb((tx) =>
          buildAutoApprovalSubject(tx, {
            capability: "stripe__create_payment",
            input: CALL,
            workspaceId,
            now: NOW,
          }),
        ),
      );
      expect(other.standingApprovalAt).toBeNull();

      const same = await inScope(() =>
        withTenantDb((tx) =>
          buildAutoApprovalSubject(tx, {
            capability: "stripe__refund_payment",
            input: CALL,
            workspaceId,
            now: NOW,
          }),
        ),
      );
      expect(same.standingApprovalAt?.toISOString()).toBe(
        "2026-09-16T09:00:00.000Z",
      );
    });

    it("never reads an auto-approval as the standing approval that opens the next one", async () => {
      const digest = inputDigest(CALL);
      await withSystemDb((tx) =>
        tx.insert(schema.approvalRequests).values({
          orgId,
          workspaceId,
          capabilityName: "stripe__create_payment",
          inputPreview: {},
          riskLevel: "high",
          inputDigest: digest,
          autoRuleId: RULE.id,
          resolution: "approved",
          resolvedAt: new Date("2026-09-16T09:00:00.000Z"),
          resolvedByPolicy: `policy:${RULE.id}`,
          expiresAt: new Date("2026-09-16T09:00:00.000Z"),
        }),
      );
      const subject = await inScope(() =>
        withTenantDb((tx) =>
          buildAutoApprovalSubject(tx, {
            capability: "stripe__create_payment",
            input: CALL,
            workspaceId,
            now: NOW,
          }),
        ),
      );
      expect(subject.standingApprovalAt).toBeNull();
    });

    it("carries no tool and no measures for a capability the workspace has not declared", async () => {
      const subject = await inScope(() =>
        withTenantDb((tx) =>
          buildAutoApprovalSubject(tx, {
            capability: "send_email",
            input: CALL,
            workspaceId,
            now: NOW,
          }),
        ),
      );
      expect(subject.tool).toBeNull();
      expect(subject.measures).toEqual({});
      expect(subject.standingApprovalAt).toBeNull();
    });

    // ── the decision ─────────────────────────────────────────────────────────

    it("writes nothing until the caller commits, then records the receipt", async () => {
      const decision = await autoApprove(CALL, [RULE]);
      expect(decision).toMatchObject({
        ruleId: RULE.id,
        ok: true,
        reasons: [],
      });
      // The evaluation alone leaves no trace: a mandate can still park this
      // call, and a receipt saying no person looked would then be a lie.
      expect(await approvalsOf()).toEqual([]);

      await decision?.commit?.();
      const [row] = await approvalsOf();
      expect(row).toMatchObject({
        capabilityName: "stripe__create_payment",
        resolution: "approved",
        resolvedByPolicy: `policy:${RULE.id}`,
        resolvedByUserId: null,
        autoRuleId: RULE.id,
        resolvedReasons: [],
        riskLevel: "high",
        ruleIds: [VERDICT.ruleId],
        inputDigest: inputDigest(CALL),
      });
      expect(row!.tokenUsedAt?.toISOString()).toBe(NOW.toISOString());
      expect(row!.resolvedAt?.toISOString()).toBe(NOW.toISOString());
    });

    it("writes nothing when the call does not qualify, and reports why", async () => {
      const outcome = await autoApprove(
        { amount: { value: "900.00" }, vendor: "person:someone" },
        [RULE],
      );
      expect(outcome).toMatchObject({ ok: false, floor: false });
      expect(outcome?.commit).toBeUndefined();
      expect(outcome?.reasons).toEqual([
        "measure_above_ceiling:amount",
        "target_not_allowed:counterparty",
      ]);
      expect(await approvalsOf()).toEqual([]);
    });

    it("is not asked at all when the workspace has no clause, or no rule covers the call", async () => {
      expect(await autoApprove(CALL, [])).toBeNull();
      expect(
        await autoApprove(CALL, [{ ...RULE, tools: ["linear__*"] }]),
      ).toBeNull();
      expect(await approvalsOf()).toEqual([]);
    });

    // ── the mandate park ─────────────────────────────────────────────────────

    it("records the evaluation beside a call the mandate parks, and parks it anyway", async () => {
      await storeRuleSet(v2([RULE]));
      const agentPrincipalId = randomUUID();
      const [mandate] = await withSystemDb((tx) =>
        tx
          .insert(schema.mandates)
          .values({
            orgId,
            workspaceId,
            agentPrincipalId,
            grantedBy: userId,
            roleAtGrant: "Billing",
            consequenceTags: ["moves_money"],
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
            // The mandate asks for a person above one dollar; the rule would
            // release the call at twelve-fifty.
            approvalRules: {
              humanAbove: { amount: "1000000" },
              alwaysHumanFor: [],
              approvers: [],
            },
            purpose: "test",
            validFrom: new Date("2026-09-01T00:00:00Z"),
            validTo: new Date("2026-12-31T23:59:59Z"),
            status: "active",
          })
          .returning({ id: schema.mandates.id }),
      );
      mandateIds.push(mandate!.id);

      const outcome = await inScope(() =>
        decideMandate({
          capability: "stripe__create_payment",
          input: CALL,
          orgId,
          workspaceId,
          agentPrincipalId,
          userId,
          now: () => NOW,
        }),
      );
      expect(outcome.kind).toBe("pending");

      const [row] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.approvalRequests)
          .where(
            and(
              eq(schema.approvalRequests.workspaceId, workspaceId),
              eq(schema.approvalRequests.mandateId, mandate!.id),
            ),
          ),
      );
      // The rule qualified — and the row is still waiting for a person.
      expect(row).toMatchObject({
        autoRuleId: RULE.id,
        resolvedReasons: [],
        resolution: null,
        resolvedByPolicy: null,
      });
    });
  },
);
