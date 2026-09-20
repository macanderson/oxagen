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
import type { AutoApprovalRule } from "@oxagen/oxagen/approval-rules/schemas";
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
    const { evaluateAutoApproval, REASON } = await import("./auto-approval");
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
    const runId = randomUUID();
    let runPublicId = "";
    const mandateIds: string[] = [];
    const NOW = new Date("2026-09-16T12:00:00.000Z");

    const inScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope({ orgId, workspaceId }, fn);

    const RULE: AutoApprovalRule = {
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
      // What `set_approval_rules` would actually have stored for this rule:
      // the effective tags of the tool its pattern matches, which is the
      // declared `moves_money` with no classification on top. Stamped with the
      // real value rather than whatever makes the assertions pass — a fixture
      // stamped to go green would leave every case below asserting only its
      // own self-consistency.
      authoredConsequences: ["moves_money"],
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

    const autoApprove = async (
      input: unknown,
      rules: unknown[],
      runId?: string | null,
    ) => {
      await storeRuleSet(v2(rules));
      return inScope(() =>
        autoApproveParkedCall({
          capability: "stripe__create_payment",
          input,
          ruleSet: v2(rules) as never,
          verdict: VERDICT,
          ctx: { orgId, workspaceId, userId, runId },
          now: () => NOW,
        }),
      );
    };

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
        // The run an auto-approved call's receipt attaches to (#3153).
        const [run] = await tx
          .insert(schema.agentRuns)
          .values({
            id: runId,
            orgId,
            workspaceId,
            surface: "api-chat",
            spec: {},
          })
          .returning({ publicId: schema.agentRuns.publicId });
        runPublicId = run!.publicId;
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.approvalRequests)
          .where(eq(schema.approvalRequests.workspaceId, workspaceId));
        await tx.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
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

    it("loads the clause and observes a committed change without cache invalidation", async () => {
      await storeRuleSet(v2([RULE]));
      const first = await inScope(() =>
        loadWorkspaceRuleSet({ orgId, workspaceId }),
      );
      expect(first?.autoApproval).toHaveLength(1);
      expect(first?.schema).toBe("oxagen.decision-rules.v2");

      // A committed change must be visible to the next decision read.
      await withSystemDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ settings: { decisionRules: v2([]) } })
          .where(eq(schema.workspaces.id, workspaceId)),
      );
      expect(
        (await inScope(() => loadWorkspaceRuleSet({ orgId, workspaceId })))
          ?.autoApproval,
      ).toHaveLength(0);
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
      // toEqual, not toMatchObject, on purpose: this asserts the whole shape
      // every consumer of `subject.tool` sees, so a loader that gains a field
      // has to come through here and say what the new field means.
      // `sideEffect` is null rather than absent because the version carries no
      // classification and the field is always present on the subject —
      // "the record says nothing" rather than "this key may not exist", so no
      // reader has to handle undefined.
      expect(subject.tool).toEqual({
        slug: "stripe__create_payment",
        version: 3,
        riskGrade: "high",
        sideEffect: null,
        consequenceTags: ["moves_money"],
      });
      expect(subject.measures).toEqual({ amount: "12500000" });
      expect(subject.targets).toEqual({ counterparty: "vendor:aws" });
      expect(subject.tainted).toBe(false);
      expect(subject.standingApprovalAt?.toISOString()).toBe(
        "2026-09-16T09:00:00.000Z",
      );
    });

    it("skips the standing-approval lookup when no applicable rule asks for one", async () => {
      // The lookup is a read of approval history sorted by resolved_at, on the
      // decision path, and only a rule with a standing window reads it. Handed
      // the rules, the builder runs it only when the rule that will answer for
      // this call names a window — so a workspace whose rules are all off,
      // cover other tools, or set no window pays nothing for it.
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
          resolvedByUserId: userId,
          resolvedAt: new Date("2026-09-16T09:00:00.000Z"),
          expiresAt: new Date("2026-09-17T00:00:00.000Z"),
        }),
      );
      const build = (rules?: readonly AutoApprovalRule[]) =>
        inScope(() =>
          withTenantDb((tx) =>
            buildAutoApprovalSubject(tx, {
              capability: "stripe__create_payment",
              input: CALL,
              workspaceId,
              rules,
              now: NOW,
            }),
          ),
        );

      // RULE sets standingWindowMs: null, so the fact is not read.
      expect((await build([RULE])).standingApprovalAt).toBeNull();
      // A rule covering another tool is not the rule that answers.
      expect(
        (
          await build([
            { ...RULE, tools: ["linear__*"], standingWindowMs: 60_000 },
          ])
        ).standingApprovalAt,
      ).toBeNull();
      // A disabled rule is not the rule that answers either.
      expect(
        (await build([{ ...RULE, enabled: false, standingWindowMs: 60_000 }]))
          .standingApprovalAt,
      ).toBeNull();
      // A rule that does ask for a window gets the fact.
      expect(
        (
          await build([{ ...RULE, standingWindowMs: 60_000 }])
        ).standingApprovalAt?.toISOString(),
      ).toBe("2026-09-16T09:00:00.000Z");
      // No rules handed over at all: the lookup still runs, so a caller that
      // does not know the clause is never given a subject quietly missing it.
      expect((await build()).standingApprovalAt?.toISOString()).toBe(
        "2026-09-16T09:00:00.000Z",
      );
    });

    it("unions the classified consequence tags with the declared ones, so a classification can only ever raise the floor", async () => {
      // The asymmetry that makes reading the jsonb safe. The column is written
      // by publish_tool_declaration behind assertConsequenceRole; the jsonb by
      // set_tool_classification behind Owner/Admin. Replacement would let an
      // Owner clear a declared tag and lower an approval floor without passing
      // the consequence-role gate. Union cannot: it only ever adds reasons a
      // call needs a person.
      const classify = (body: Record<string, unknown> | null) =>
        withSystemDb((tx) =>
          tx
            .update(schema.toolVersions)
            .set({
              classification: body,
              classifiedRiskGrade: body === null ? null : "medium",
              classifiedAt:
                body === null ? null : new Date("2026-09-16T08:00:00.000Z"),
            })
            .where(eq(schema.toolVersions.id, versionId)),
        );
      const tags = async () =>
        (
          await inScope(() =>
            withTenantDb((tx) =>
              buildAutoApprovalSubject(tx, {
                capability: "stripe__create_payment",
                input: CALL,
                workspaceId,
                now: NOW,
              }),
            ),
          )
        ).tool;

      // The declared column carries moves_money throughout this file.
      try {
        // Classified adds a tag the manifest never declared: the floor gains
        // it. This is the fix — an administrator RAISES the floor.
        await classify({
          sideEffect: "irreversible",
          consequenceTags: ["destroys_data"],
        });
        const raised = await tags();
        // Sorted, and the assertion is exact on purpose: `unionConsequenceTags`
        // guarantees the order (see its contract), so a literal here tests a
        // real promise rather than an incidental one. Unsorted, the order
        // depended on which half contributed the tag first — the same
        // unspecified-representation hazard the digest canonicaliser sorts Map
        // entries and Set members to avoid, one level up.
        expect(raised?.consequenceTags).toEqual([
          "destroys_data",
          "moves_money",
        ]);
        expect(raised?.sideEffect).toBe("irreversible");

        // Classified names NO tags: the declared one survives. An
        // administrator cannot lower what the manifest declared, which is the
        // bypass union rules out.
        await classify({ sideEffect: "read", consequenceTags: [] });
        const notLowered = await tags();
        expect(notLowered?.consequenceTags).toEqual(["moves_money"]);

        // A classification that is not the shape we expect contributes
        // nothing rather than throwing away the declared tags.
        await classify({ nonsense: true });
        expect((await tags())?.consequenceTags).toEqual(["moves_money"]);
      } finally {
        await classify(null);
      }
      const restored = await tags();
      expect(restored?.consequenceTags).toEqual(["moves_money"]);
      expect(restored?.sideEffect).toBeNull();
    });

    it("reads the classified risk grade over the declared one, so an administrator can raise the critical_hazard floor", async () => {
      // `set_tool_classification` writes classified_risk_grade and leaves
      // risk_grade — the manifest's own, checksummed — alone, and the tool
      // registry shows `classifiedRiskGrade ?? riskGrade`. The floor has to
      // read the same effective grade, or classifying a version `critical`
      // over a lower declared grade is ignored by the decision and the call
      // skips a person while the record says a rule judged it.
      // The three classification columns move together — the row's own CHECK
      // says all null or all set — and the version is shared by every test in
      // this file, so the classification is put back in `finally`.
      const classify = (on: boolean) =>
        withSystemDb((tx) =>
          tx
            .update(schema.toolVersions)
            .set({
              // The real stored shape (toolClassificationSchema), not an
              // invented key: this row is what loadDeclaredTool reads.
              classification: on
                ? {
                    sideEffect: "write",
                    egress: "third_party",
                    consequenceTags: [],
                    measures: {},
                    dataClasses: [],
                  }
                : null,
              classifiedRiskGrade: on ? "critical" : null,
              classifiedAt: on ? new Date("2026-09-16T08:00:00.000Z") : null,
            })
            .where(eq(schema.toolVersions.id, versionId)),
        );
      await classify(true);
      try {
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
        // The declared grade is still "high" on the row; the subject carries
        // the classified one.
        expect(subject.tool?.riskGrade).toBe("critical");
        const judged = evaluateAutoApproval([RULE], subject);
        expect(judged?.ok).toBe(false);
        expect(judged?.floor).toBe(true);
        expect(judged?.reasons).toContain(REASON.criticalHazard);
      } finally {
        await classify(false);
      }
      // Back to the declared grade: the floor does not fire and the same rule
      // qualifies, so nothing leaks into the tests after this one.
      const restored = await inScope(() =>
        withTenantDb((tx) =>
          buildAutoApprovalSubject(tx, {
            capability: "stripe__create_payment",
            input: CALL,
            workspaceId,
            now: NOW,
          }),
        ),
      );
      expect(restored.tool?.riskGrade).toBe("high");
      expect(evaluateAutoApproval([RULE], restored)?.reasons).not.toContain(
        REASON.criticalHazard,
      );
    });

    it("stops releasing calls when the tool gains a consequence the rule was not written against", async () => {
      // The ordering attack, at the decision layer this time (#3133): the
      // accountability gate is on the write, so classifying the tool AFTER the
      // rule was authored reaches the same end without the gate firing. The
      // stamp is what closes it, and this asserts the mechanism FIRES rather
      // than only that a correctly-stamped rule still passes — a fixture
      // stamped to go green would prove nothing without this case beside it.
      await withSystemDb((tx) =>
        tx
          .update(schema.toolVersions)
          .set({
            classification: {
              sideEffect: "write",
              egress: "third_party",
              consequenceTags: ["changes_access"],
              measures: {},
              dataClasses: [],
            },
            classifiedRiskGrade: "high",
            classifiedAt: new Date("2026-09-16T08:00:00.000Z"),
          })
          .where(eq(schema.toolVersions.id, versionId)),
      );
      try {
        const decision = await autoApprove(CALL, [RULE]);
        expect(decision?.ok).toBe(false);
        expect(decision?.reasons).toContain("consequences_changed");
        // Not a floor: the rule is out of date rather than wrong.
        expect(decision?.floor).toBe(false);
        // And nothing was written, so no receipt says a rule released it.
        expect(decision?.commit).toBeUndefined();
      } finally {
        await withSystemDb((tx) =>
          tx
            .update(schema.toolVersions)
            .set({
              classification: null,
              classifiedRiskGrade: null,
              classifiedAt: null,
            })
            .where(eq(schema.toolVersions.id, versionId)),
        );
      }
      // Restored: the same call qualifies again, so the case above is about
      // the classification and not about some leftover state.
      expect((await autoApprove(CALL, [RULE]))?.ok).toBe(true);
    });

    it("ignores a stale passed rule set after a committed disable", async () => {
      await storeRuleSet(v2([{ ...RULE, enabled: false }]));
      const outcome = await inScope(() =>
        autoApproveParkedCall({
          capability: "stripe__create_payment",
          input: CALL,
          ruleSet: v2([RULE]) as never,
          verdict: VERDICT,
          ctx: { orgId, workspaceId, userId },
          now: () => NOW,
        }),
      );
      expect(outcome).toBeNull();
    });

    it("refuses release if the rule is disabled after evaluation but before commit", async () => {
      const decision = await autoApprove(CALL, [RULE]);
      expect(decision?.ok).toBe(true);
      if (!decision?.commit) throw new Error("Missing approval commit");
      await storeRuleSet(v2([{ ...RULE, enabled: false }]));
      await expect(inScope(decision.commit)).rejects.toMatchObject({
        reason: "approval_policy_changed",
      });
      expect(await approvalsOf()).toHaveLength(0);
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

      // The commit runs in the caller's tenant scope, as it does in
      // production: the kernel wraps the decision gate and the handler in one
      // runInTenantScope (kernel.ts), and the gate calls `commit` from inside it.
      await inScope(async () => {
        await decision?.commit?.();
      });
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

    // #3153: the receipt names the run the call belonged to, the same way
    // resolve_approval's rows do, so list_resolved_approvals can find it by
    // run.
    it("attaches the receipt to the call's run when one was in scope", async () => {
      const decision = await autoApprove(CALL, [RULE], runId);
      await inScope(async () => {
        await decision?.commit?.();
      });
      const [row] = await approvalsOf();
      expect(row?.runPublicId).toBe(runPublicId);
    });

    it("leaves run_public_id null for a call with no run in scope, never a fabricated one", async () => {
      const decision = await autoApprove(CALL, [RULE], null);
      await inScope(async () => {
        await decision?.commit?.();
      });
      const [row] = await approvalsOf();
      expect(row?.runPublicId).toBeNull();
    });

    it("leaves run_public_id null for a run id that does not resolve in this workspace (negative)", async () => {
      const decision = await autoApprove(CALL, [RULE], randomUUID());
      await inScope(async () => {
        await decision?.commit?.();
      });
      const [row] = await approvalsOf();
      expect(row?.runPublicId).toBeNull();
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
