/**
 * The five auto-approval rule handlers against Postgres (ADR-070; issue
 * #2970 §8). Runs in the CI Postgres job and locally with DATABASE_URL set;
 * skipped otherwise.
 *
 * The role gate is a double, as it is for the mandate handlers: `assertOrgRole`
 * resolves the role the test names for the caller and refuses when it is
 * outside the roles the handler asks for, so each test asserts WHICH roles the
 * handler asks for (INV-29) without seeding the IAM tables. The security-event
 * emitter is a double that records what was emitted.
 *
 * What is asserted:
 *   set     — an Admin writes the clause and it comes back stamped with the
 *             author and the time; a Member is refused; a pattern that matches
 *             no declared tool → no_tool_matches; a condition over a measure
 *             the matched tool does not declare → measure_not_declared; a
 *             Compliance user cannot write a rule over a tool that moves
 *             money, which is the spec's "a rule cannot be saved that would
 *             widen an agent past its operator's grants"; a refusal writes
 *             nothing; the gate clause beside it and every other settings key
 *             survive the write
 *   list    — the stored rules with the 30-day counters read off the approval
 *             rows: a call the rule released counts as a hit, one it was read
 *             against and did not counts as held, and a row outside the window
 *             counts as neither
 *   enabled — off needs no re-check; on re-checks the guards and refuses when
 *             the tool changed under it; an unknown id → not_found
 *   delete  — the rule goes and the rest stay; an unknown id → not_found
 *   get_auto_eligibility — the recorded evaluation and the approver, in both
 *             forms; an unresolved row reports no approver; an unknown id →
 *             not_found
 */
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";

const doubles = vi.hoisted(() => ({
  roles: new Map<string, string | null>(),
  events: [] as Array<{ eventType: string; capability: string | null }>,
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId: string | null }) => ctx.userId,
  assertOrgRole: async (
    ctx: { userId: string | null },
    required: { org: readonly string[] },
  ) => {
    if (!ctx.userId) {
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    }
    const held = doubles.roles.get(ctx.userId) ?? null;
    if (held && required.org.includes(held)) return held;
    throw new HandlerError({ code: "forbidden", reason: "org_role_required" });
  },
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: (e: { eventType: string; capability: string | null }) => {
    doubles.events.push({ eventType: e.eventType, capability: e.capability });
  },
  emitSecurityEventAsync: async (e: {
    eventType: string;
    capability: string | null;
  }) => {
    doubles.events.push({ eventType: e.eventType, capability: e.capability });
  },
}));

describe.skipIf(!process.env.DATABASE_URL)(
  "auto-approval rule handlers against Postgres",
  async () => {
    const { schema, withSystemDb, withTenantDb } = await import(
      "@oxagen/database"
    );
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq } = await import("drizzle-orm");
    const { clearDecisionRulesCache } = await import("@oxagen/rules");
    const { writeRules } = await import("./_approval_rule");
    const { approvalRuleListHandler } = await import("./approval_rule.list");
    const { approvalRuleSetHandler } = await import("./approval_rule.set");
    const { approvalRuleDeleteHandler } = await import(
      "./approval_rule.delete"
    );
    const { approvalRuleEnabledSetHandler } = await import(
      "./approval_rule.enabled.set"
    );
    const { approvalAutoEligibilityGetHandler } = await import(
      "./approval.auto_eligibility.get"
    );

    const tag = Date.now().toString(36).slice(-6);
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const adminUserId = randomUUID();
    const complianceUserId = randomUUID();
    const memberUserId = randomUUID();
    const paymentToolId = randomUUID();
    const paymentVersionId = randomUUID();
    let adminPublicId = "";

    const ctx = (userId: string | null): CapabilityContext => ({
      orgId,
      workspaceId,
      userId,
      apiKeyId: null,
      requestId: `req_${tag}`,
      surface: "api",
      messageId: null,
    });
    const inScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope({ orgId, workspaceId }, fn);

    const forbidden = (reason: string) => (e: unknown) =>
      isHandlerError(e) && e.code === "forbidden" && e.reason === reason;
    const conflict = (reason: string) => (e: unknown) =>
      isHandlerError(e) && e.code === "conflict" && e.reason === reason;
    const notFound = (e: unknown) =>
      isHandlerError(e) && e.code === "not_found";

    const RULE = {
      id: "small-vendor-payments",
      name: "Small vendor payments",
      tools: ["stripe__create_payment@*"],
      enabled: true,
      maxMeasures: { amount: "250000000" },
      allowTargets: { counterparty: ["vendor:*"] },
      standingWindowMs: null,
      businessHours: null,
    };

    const set = (userId: string, rules: unknown[]) =>
      inScope(() => approvalRuleSetHandler({ rules } as never, ctx(userId)));
    const list = (userId: string) =>
      inScope(() => approvalRuleListHandler({}, ctx(userId)));

    /** The stored settings bag, so a write can be checked not to have eaten a sibling key. */
    const settingsOf = async () =>
      withSystemDb(async (tx) => {
        const row = await tx.query.workspaces.findFirst({
          where: eq(schema.workspaces.id, workspaceId),
          columns: { settings: true },
        });
        return row?.settings as Record<string, unknown>;
      });

    /** One approval row with the recorded evaluation a read reports. */
    async function insertApproval(values: {
      autoRuleId: string | null;
      resolvedReasons?: string[];
      resolvedByPolicy?: string | null;
      resolvedByUserId?: string | null;
      createdAt?: Date;
    }): Promise<{ id: string; publicId: string }> {
      const [row] = await withSystemDb((tx) =>
        tx
          .insert(schema.approvalRequests)
          .values({
            orgId,
            workspaceId,
            capabilityName: "stripe__create_payment",
            inputPreview: {},
            riskLevel: "high",
            autoRuleId: values.autoRuleId,
            resolvedReasons: values.resolvedReasons ?? [],
            resolvedByPolicy: values.resolvedByPolicy ?? null,
            resolvedByUserId: values.resolvedByUserId ?? null,
            resolution: values.resolvedByPolicy ? "approved" : null,
            createdAt: values.createdAt ?? new Date(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          })
          .returning({
            id: schema.approvalRequests.id,
            publicId: schema.approvalRequests.publicId,
          }),
      );
      return row!;
    }

    beforeAll(async () => {
      doubles.roles.set(adminUserId, "Admin");
      doubles.roles.set(complianceUserId, "Compliance");
      doubles.roles.set(memberUserId, null);
      await withSystemDb(async (tx) => {
        const [admin] = await tx
          .insert(schema.users)
          .values({
            id: adminUserId,
            email: `admin-${tag}@rules.test`,
            status: "active",
          })
          .returning({ publicId: schema.users.publicId });
        adminPublicId = admin!.publicId;
        await tx.insert(schema.workspaces).values({
          id: workspaceId,
          orgId,
          name: "Finance",
          slug: `finance-rules-${tag}`,
          namespace: `fnr${tag}`.slice(0, 6),
          // A sibling key a rule write must leave alone, and the gate clause
          // the auto-approval clause sits beside.
          settings: {
            theme: "dark",
            decisionRules: {
              schema: "oxagen.decision-rules.v1",
              rules: [
                {
                  id: "approve-payments",
                  description: "a person looks at a payment",
                  capability: "stripe__create_payment",
                  effect: "require_approval",
                },
              ],
            },
          },
        });
        await tx.insert(schema.tools).values({
          id: paymentToolId,
          orgId,
          workspaceId,
          name: "stripe__create_payment",
          slug: "stripe__create_payment",
          source: "builtin",
          enabled: true,
        });
        await tx.insert(schema.toolVersions).values({
          id: paymentVersionId,
          orgId,
          workspaceId,
          toolId: paymentToolId,
          versionNumber: 1,
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
          .set({ activeVersionId: paymentVersionId })
          .where(eq(schema.tools.id, paymentToolId));
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.approvalRequests)
          .where(eq(schema.approvalRequests.workspaceId, workspaceId));
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
        await tx.delete(schema.users).where(eq(schema.users.id, adminUserId));
      });
    });

    beforeEach(() => {
      doubles.events.length = 0;
      clearDecisionRulesCache();
    });

    // ── set ──────────────────────────────────────────────────────────────────

    it("writes the clause for an Admin, stamps it, and leaves the rest of the settings bag alone", async () => {
      const out = await set(adminUserId, [RULE]);
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).toMatchObject({
        id: RULE.id,
        createdBy: adminPublicId,
        hits30d: 0,
        skipped30d: 0,
      });
      expect(Date.parse(out.items[0]!.createdAt)).not.toBeNaN();
      expect(out.windowDays).toBe(30);
      expect(doubles.events).toEqual([
        {
          eventType: "approval_rule.changed",
          capability: "set_approval_rules",
        },
      ]);

      const settings = await settingsOf();
      expect(settings.theme).toBe("dark");
      const stored = settings.decisionRules as Record<string, unknown>;
      expect(stored.schema).toBe("oxagen.decision-rules.v2");
      expect(stored.rules).toHaveLength(1);
      expect(stored.autoApproval).toHaveLength(1);
    });

    it("refuses a caller with no org role, and writes nothing", async () => {
      const before = await settingsOf();
      await expect(set(memberUserId, [])).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
      await expect(set(null as unknown as string, [])).rejects.toSatisfy(
        forbidden("no_principal"),
      );
      expect(await settingsOf()).toEqual(before);
      expect(doubles.events).toEqual([]);
    });

    it("refuses a tool pattern that matches no declared tool", async () => {
      await expect(
        set(adminUserId, [{ ...RULE, tools: ["linear__*"] }]),
      ).rejects.toSatisfy(conflict("no_tool_matches"));
    });

    it("refuses a condition over a measure the matched tool does not declare", async () => {
      await expect(
        set(adminUserId, [{ ...RULE, maxMeasures: { rows: "10" } }]),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
      await expect(
        set(adminUserId, [{ ...RULE, allowTargets: { region: ["eu-*"] } }]),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
    });

    it("refuses a condition over a measure declared as the other kind", async () => {
      // `counterparty` is text and `amount` is an amount. A ceiling over text
      // and an allow list over a number both read as unreadable on every call,
      // so the rule would save cleanly and never fire.
      await expect(
        set(adminUserId, [
          { ...RULE, maxMeasures: { counterparty: "10" }, allowTargets: {} },
        ]),
      ).rejects.toSatisfy(conflict("measure_wrong_type"));
      await expect(
        set(adminUserId, [
          { ...RULE, maxMeasures: {}, allowTargets: { amount: ["1*"] } },
        ]),
      ).rejects.toSatisfy(conflict("measure_wrong_type"));
      // The right way round still saves.
      await expect(set(adminUserId, [RULE])).resolves.toBeDefined();
    });

    it("refuses a caller who does not hold the role accountable for the tool's consequence", async () => {
      // moves_money defaults to Owner and Billing; Compliance is an org role
      // and still may not widen what an agent may do with money.
      await expect(set(complianceUserId, [RULE])).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
    });

    it("refuses two rules under one id and leaves the stored document as it was", async () => {
      await set(adminUserId, [RULE]);
      const before = await settingsOf();
      // The contract refuses it at the edge; the handler's own parse of the
      // document it is about to store is the second guard, so a set that
      // reaches it still writes nothing.
      await expect(
        set(adminUserId, [RULE, { ...RULE, name: "Same id, other name" }]),
      ).rejects.toThrow();
      expect(await settingsOf()).toEqual(before);
    });

    it("refuses to store a document the gate could not load", async () => {
      await set(adminUserId, [RULE]);
      const before = await settingsOf();
      await expect(
        inScope(() =>
          withTenantDb((tx) =>
            writeRules(tx, workspaceId, [
              { ...RULE, createdBy: null, createdAt: "not a timestamp" },
            ] as never),
          ),
        ),
      ).rejects.toSatisfy(conflict("rule_set_would_not_load"));
      expect(await settingsOf()).toEqual(before);
    });

    it("clears the clause when the caller sends no rules", async () => {
      await set(adminUserId, [RULE]);
      expect((await set(adminUserId, [])).items).toEqual([]);
      expect((await list(adminUserId)).items).toEqual([]);
    });

    // ── list and the counters ────────────────────────────────────────────────

    it("counts the calls a rule released and the calls it held over the window", async () => {
      await set(adminUserId, [RULE]);
      await insertApproval({
        autoRuleId: RULE.id,
        resolvedByPolicy: `policy:${RULE.id}`,
      });
      await insertApproval({
        autoRuleId: RULE.id,
        resolvedReasons: ["measure_above_ceiling:amount"],
      });
      await insertApproval({
        autoRuleId: RULE.id,
        resolvedReasons: ["tainted_input"],
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      });
      // A row no rule was read against counts for nothing.
      await insertApproval({ autoRuleId: null });

      const out = await list(adminUserId);
      expect(out.items[0]).toMatchObject({ hits30d: 1, skipped30d: 1 });
    });

    it("is readable by Compliance and refused to a caller with no role", async () => {
      await expect(list(complianceUserId)).resolves.toBeDefined();
      await expect(list(memberUserId)).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
    });

    // ── enabled ──────────────────────────────────────────────────────────────

    it("switches a rule off with no re-check and back on with one", async () => {
      await set(adminUserId, [RULE]);
      const off = await inScope(() =>
        approvalRuleEnabledSetHandler(
          { ruleId: RULE.id, enabled: false },
          ctx(adminUserId),
        ),
      );
      expect(off.items[0]!.enabled).toBe(false);
      expect(doubles.events.at(-1)).toEqual({
        eventType: "approval_rule.changed",
        capability: "set_approval_rule_enabled",
      });

      // The tool loses its declared measure while the rule is off; switching
      // the rule back on checks it against the workspace as it is now.
      await withSystemDb((tx) =>
        tx
          .update(schema.toolVersions)
          .set({ measures: {} })
          .where(eq(schema.toolVersions.id, paymentVersionId)),
      );
      await expect(
        inScope(() =>
          approvalRuleEnabledSetHandler(
            { ruleId: RULE.id, enabled: true },
            ctx(adminUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
      await withSystemDb((tx) =>
        tx
          .update(schema.toolVersions)
          .set({
            measures: {
              amount: {
                path: "amount.value",
                type: "amount",
                unit: "USD",
                scale: 2,
              },
              counterparty: { path: "vendor", type: "text", unit: "vendor" },
            },
          })
          .where(eq(schema.toolVersions.id, paymentVersionId)),
      );
      const on = await inScope(() =>
        approvalRuleEnabledSetHandler(
          { ruleId: RULE.id, enabled: true },
          ctx(adminUserId),
        ),
      );
      expect(on.items[0]!.enabled).toBe(true);
    });

    it("keeps both of two rules switched off at once, against a concurrent write", async () => {
      // The lost update this guards: both calls read the same array, each
      // changes its own rule, and the second stores a copy that still has the
      // first rule on. The row lock serialises them, so both stick.
      await set(adminUserId, [RULE, { ...RULE, id: "release-tooling" }]);
      const toggle = (ruleId: string) =>
        inScope(() =>
          approvalRuleEnabledSetHandler(
            { ruleId, enabled: false },
            ctx(adminUserId),
          ),
        );
      await Promise.all([toggle(RULE.id), toggle("release-tooling")]);
      const after = await list(adminUserId);
      expect(after.items.map((r) => [r.id, r.enabled])).toEqual([
        [RULE.id, false],
        ["release-tooling", false],
      ]);
    });

    it("refuses to switch a rule that is not there", async () => {
      await set(adminUserId, [RULE]);
      await expect(
        inScope(() =>
          approvalRuleEnabledSetHandler(
            { ruleId: "not-a-rule", enabled: false },
            ctx(adminUserId),
          ),
        ),
      ).rejects.toSatisfy(notFound);
    });

    // ── delete ───────────────────────────────────────────────────────────────

    it("removes one rule and keeps the rest", async () => {
      await set(adminUserId, [RULE, { ...RULE, id: "release-tooling" }]);
      const out = await inScope(() =>
        approvalRuleDeleteHandler({ ruleId: RULE.id }, ctx(adminUserId)),
      );
      expect(out.items.map((r) => r.id)).toEqual(["release-tooling"]);
      expect(doubles.events.at(-1)).toEqual({
        eventType: "approval_rule.deleted",
        capability: "delete_approval_rule",
      });
      await expect(
        inScope(() =>
          approvalRuleDeleteHandler({ ruleId: RULE.id }, ctx(adminUserId)),
        ),
      ).rejects.toSatisfy(notFound);
    });

    // ── get_auto_eligibility ─────────────────────────────────────────────────

    it("reports the recorded evaluation and the rule as the approver", async () => {
      const row = await insertApproval({
        autoRuleId: RULE.id,
        resolvedByPolicy: `policy:${RULE.id}`,
      });
      const out = await inScope(() =>
        approvalAutoEligibilityGetHandler(
          { approvalId: row.publicId },
          ctx(adminUserId),
        ),
      );
      expect(out).toEqual({
        approvalId: row.publicId,
        resolvedBy: `policy:${RULE.id}`,
        eligibility: {
          ruleId: RULE.id,
          ok: true,
          reasons: [],
          floor: false,
        },
      });
    });

    it("reports a floor reason as a floor, and reads the row uuid too", async () => {
      const row = await insertApproval({
        autoRuleId: RULE.id,
        resolvedReasons: ["tainted_input", "measure_above_ceiling:amount"],
      });
      const out = await inScope(() =>
        approvalAutoEligibilityGetHandler(
          { approvalId: row.id },
          ctx(adminUserId),
        ),
      );
      expect(out.resolvedBy).toBeNull();
      expect(out.eligibility).toEqual({
        ruleId: RULE.id,
        ok: false,
        reasons: ["tainted_input", "measure_above_ceiling:amount"],
        floor: true,
      });
    });

    it("names a person as the approver when one answered", async () => {
      const row = await insertApproval({
        autoRuleId: null,
        resolvedByUserId: adminUserId,
      });
      const out = await inScope(() =>
        approvalAutoEligibilityGetHandler(
          { approvalId: row.publicId },
          ctx(adminUserId),
        ),
      );
      expect(out.resolvedBy).toBe(`user:${adminPublicId}`);
      expect(out.eligibility).toBeNull();
    });

    it("refuses an approval this workspace does not hold", async () => {
      await expect(
        inScope(() =>
          approvalAutoEligibilityGetHandler(
            { approvalId: randomUUID() },
            ctx(adminUserId),
          ),
        ),
      ).rejects.toSatisfy(notFound);
    });
  },
);
