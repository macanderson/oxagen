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
 *   set     — an Owner writes the clause and it comes back stamped with the
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
import { z } from "zod";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  HandlerError,
  isHandlerError,
  registerCapability,
} from "@oxagen/oxagen";

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
    const { readRules, writeRules } = await import("./_approval_rule");
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
    const ownerUserId = randomUUID();
    const complianceUserId = randomUUID();
    const memberUserId = randomUUID();
    const paymentToolId = randomUUID();
    const paymentVersionId = randomUUID();
    let ownerPublicId = "";
    /** User rows individual tests insert; teardown removes them with the rest. */
    const extraUserIds: string[] = [];

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

    const set = (userId: string, rules: unknown[], saving?: string[]) =>
      inScope(() =>
        approvalRuleSetHandler({ rules, saving } as never, ctx(userId)),
      );
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

    /**
     * A declared, enabled tool whose slug names a registered capability, with
     * the consequence tags it carries in each of the two halves.
     *
     * The capability registration is not decoration: a classified declaration
     * whose slug names none is refused by `publish_tool_declaration`, and a
     * rule over it by `tool_not_registered`, so a fixture without it would be a
     * tool no workspace can hold.
     */
    async function declareCapabilityTool(
      slug: string,
      tags: { declared: string[]; classified: string[] },
    ): Promise<{ toolId: string; versionId: string }> {
      registerCapability({
        name: slug,
        domain: "testdom",
        description: `${slug} capability the declared fixture tool binds to`,
        mode: "sync",
        surfaces: ["api", "mcp"],
        layers: ["api", "mcp", "unit"],
        scoped: true,
        sensitivity: "high",
        defaultEffect: "deny",
        defaultRoles: { org: { Owner: "allow" }, workspace: {} },
        input: z.object({}),
        output: z.object({}),
      });
      const toolId = randomUUID();
      const versionId = randomUUID();
      await withSystemDb(async (tx) => {
        await tx.insert(schema.tools).values({
          id: toolId,
          orgId,
          workspaceId,
          name: slug,
          slug,
          source: "builtin",
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
          checksum: randomUUID().replace(/-/g, "").padEnd(64, "0"),
          consequenceTags: tags.declared,
          measures: {},
          // A whole `toolClassificationSchema` value, not the tag list alone:
          // a fixture carrying a key the schema does not have would document a
          // field that does not exist. The three classification columns move
          // together or not at all (`tool_versions_classification_check`), so
          // a classified fixture carries the grade and the time as well —
          // which is what `set_tool_classification` writes.
          ...(tags.classified.length === 0
            ? {}
            : {
                classification: {
                  sideEffect: "write",
                  egress: "local",
                  consequenceTags: tags.classified,
                  measures: {},
                  dataClasses: [],
                },
                classifiedRiskGrade: "high" as const,
                classifiedAt: new Date(),
              }),
        });
        await tx
          .update(schema.tools)
          .set({ activeVersionId: versionId })
          .where(eq(schema.tools.id, toolId));
      });
      return { toolId, versionId };
    }

    /** Tools before versions: `tools.active_version_id` references `tool_versions.id`. */
    async function removeTools(
      made: ReadonlyArray<{ toolId: string; versionId: string }>,
    ): Promise<void> {
      await withSystemDb(async (tx) => {
        for (const t of made) {
          await tx.delete(schema.tools).where(eq(schema.tools.id, t.toolId));
        }
        for (const t of made) {
          await tx
            .delete(schema.toolVersions)
            .where(eq(schema.toolVersions.id, t.versionId));
        }
      });
    }

    beforeAll(async () => {
      // The payment tool this file declares carries `moves_money` and
      // measures, which makes it a CLASSIFIED declaration — and
      // `publish_tool_declaration` refuses one whose slug names no registered
      // capability (`conflict` / `consequence_not_gated`), because the gate
      // that reads a classification lives inside `invoke()` and finds the tool
      // by slug. `assertRulesSavable` re-applies that same precondition to a
      // rule naming the tool (`tool_not_registered`).
      //
      // The fixture below inserts the tool row directly rather than through
      // the publisher, so nothing here would otherwise hold it to a
      // precondition the real writer enforces, and every case in this file
      // would be asserting against a tool that cannot exist. Registered
      // rather than relaxed: the capability is what makes the declaration
      // legal, so the fixture declares it.
      registerCapability({
        name: "stripe__create_payment",
        domain: "testdom",
        description: "payment capability the declared fixture tool binds to",
        mode: "sync",
        surfaces: ["api", "mcp"],
        layers: ["api", "mcp", "unit"],
        scoped: true,
        sensitivity: "high",
        defaultEffect: "deny",
        defaultRoles: { org: { Owner: "allow" }, workspace: {} },
        input: z.object({}),
        output: z.object({}),
      });
      // Owner, not Admin, and that is the point rather than a detail. The
      // payment tool below carries `moves_money`, whose default accountable
      // roles are Owner and Billing (DEFAULT_CONSEQUENCE_ROLES), and
      // `assertRulesSavable` puts that gate on the save path — a rule cannot
      // be saved that would widen an agent past its operator's own grants.
      // An Admin may run the other handlers here, and one does below, but an
      // Admin is not accountable for money and so cannot author this rule.
      doubles.roles.set(ownerUserId, "Owner");
      doubles.roles.set(complianceUserId, "Compliance");
      doubles.roles.set(memberUserId, null);
      await withSystemDb(async (tx) => {
        const [owner] = await tx
          .insert(schema.users)
          .values({
            id: ownerUserId,
            email: `owner-${tag}@rules.test`,
            status: "active",
          })
          .returning({ publicId: schema.users.publicId });
        ownerPublicId = owner!.publicId;
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
        await tx.delete(schema.users).where(eq(schema.users.id, ownerUserId));
        for (const id of extraUserIds) {
          await tx.delete(schema.users).where(eq(schema.users.id, id));
        }
      });
    });

    beforeEach(() => {
      doubles.events.length = 0;
      clearDecisionRulesCache();
    });

    // ── set ──────────────────────────────────────────────────────────────────

    it("writes the clause for a role accountable for the tool's consequences, stamps it, and leaves the rest of the settings bag alone", async () => {
      const out = await set(ownerUserId, [RULE]);
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).toMatchObject({
        id: RULE.id,
        createdBy: ownerPublicId,
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
        set(ownerUserId, [{ ...RULE, tools: ["linear__*"] }]),
      ).rejects.toSatisfy(conflict("no_tool_matches"));
    });

    it("refuses auto-approval for an external tool with no trusted measures", async () => {
      // Deny and human-approval rules now apply to this identity. Auto-approval
      // still needs provider measures, even when the author names no ceiling.
      const externalToolId = randomUUID();
      const externalVersionId = randomUUID();
      await withSystemDb(async (tx) => {
        await tx.insert(schema.tools).values({
          id: externalToolId,
          orgId,
          workspaceId,
          name: "mcp.acme.charge_card",
          slug: "mcp.acme.charge_card",
          source: "mcp",
          enabled: true,
        });
        await tx.insert(schema.toolVersions).values({
          id: externalVersionId,
          orgId,
          workspaceId,
          toolId: externalToolId,
          versionNumber: 1,
          isLatest: true,
          inputSchema: {},
          riskGrade: "high",
          manifest: {},
          checksum: "1".repeat(64),
          consequenceTags: [],
          measures: {},
        });
        await tx
          .update(schema.tools)
          .set({ activeVersionId: externalVersionId })
          .where(eq(schema.tools.id, externalToolId));
      });
      clearDecisionRulesCache();

      try {
        const before = await settingsOf();
        await expect(
          set(ownerUserId, [
            {
              ...RULE,
              id: "external-charges",
              tools: ["mcp.acme.charge_card@*"],
              maxMeasures: {},
              allowTargets: {},
            },
          ]),
        ).rejects.toSatisfy(conflict("external_auto_approval_unsupported"));
        // A refused rule writes nothing, the same as every other guard here.
        expect(await settingsOf()).toEqual(before);
        expect(doubles.events).toEqual([]);
      } finally {
        // Removed whatever the assertions did, so no later case in this file
        // reads a workspace this one changed. Tools before versions:
        // `tools.active_version_id` references `tool_versions.id`.
        await withSystemDb(async (tx) => {
          await tx
            .delete(schema.tools)
            .where(eq(schema.tools.id, externalToolId));
          await tx
            .delete(schema.toolVersions)
            .where(eq(schema.toolVersions.id, externalVersionId));
        });
      }
    });

    it("refuses a condition over a measure the matched tool does not declare", async () => {
      await expect(
        set(ownerUserId, [{ ...RULE, maxMeasures: { rows: "10" } }]),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
      await expect(
        set(ownerUserId, [{ ...RULE, allowTargets: { region: ["eu-*"] } }]),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
    });

    it("refuses a condition over a measure declared as the other kind", async () => {
      // `counterparty` is text and `amount` is an amount. A ceiling over text
      // and an allow list over a number both read as unreadable on every call,
      // so the rule would save cleanly and never fire.
      await expect(
        set(ownerUserId, [
          { ...RULE, maxMeasures: { counterparty: "10" }, allowTargets: {} },
        ]),
      ).rejects.toSatisfy(conflict("measure_wrong_type"));
      await expect(
        set(ownerUserId, [
          { ...RULE, maxMeasures: {}, allowTargets: { amount: ["1*"] } },
        ]),
      ).rejects.toSatisfy(conflict("measure_wrong_type"));
      // The right way round still saves.
      await expect(set(ownerUserId, [RULE])).resolves.toBeDefined();
    });

    it("refuses a caller who does not hold the role accountable for the tool's consequence", async () => {
      // moves_money defaults to Owner and Billing; Compliance is an org role
      // and still may not widen what an agent may do with money.
      await expect(set(complianceUserId, [RULE])).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
      // Nor may an Admin, and that is the one worth stating outright: Admin
      // passes the handler's own `{ org: ["Owner", "Admin"] }` gate and is
      // refused a step later by the consequence gate, because accountability
      // for money is not seniority. Every other handler in this file takes an
      // Admin; only authoring a rule over this tool does not.
      // Explicitly save the existing rule to exercise its authoring gate.
      // No user row: the consequence gate refuses before anything reads a
      // public id, and the role is the double's.
      const adminOnlyId = randomUUID();
      doubles.roles.set(adminOnlyId, "Admin");
      await expect(set(adminOnlyId, [RULE], [RULE.id])).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
    });

    it("reads the CLASSIFIED consequences at authoring time, so a classified tag cannot be authored around", async () => {
      // The bypass this closes, and it is the case that was passing and
      // should not have been. A tool with NO declared consequence tags that
      // `set_tool_classification` has marked `moves_money` used to present an
      // empty tag set to `assertRulesSavable`: an Admin cleared the handler's
      // own `{ org: ["Owner","Admin"] }` gate, never reached the consequence
      // gate that reserves money to Owner and Billing, and authored a rule
      // that `loadDeclaredTool` would then enforce against the very tag the
      // authoring gate never saw. The floor and the gate now read one fact.
      const adminId = randomUUID();
      doubles.roles.set(adminId, "Admin");
      await withSystemDb((tx) =>
        tx
          .update(schema.toolVersions)
          .set({
            consequenceTags: [],
            classification: {
              sideEffect: "write",
              egress: "third_party",
              consequenceTags: ["moves_money"],
              measures: {},
              dataClasses: [],
            },
            classifiedRiskGrade: "high",
            classifiedAt: new Date("2026-09-16T08:00:00.000Z"),
          })
          .where(eq(schema.toolVersions.id, paymentVersionId)),
      );
      try {
        await expect(set(adminId, [RULE], [RULE.id])).rejects.toSatisfy(
          forbidden("org_role_required"),
        );
        // An Owner is accountable for money and may still author it, so the
        // gate refuses the unaccountable caller rather than the tool.
        await expect(
          set(ownerUserId, [RULE], [RULE.id]),
        ).resolves.toBeDefined();
      } finally {
        await withSystemDb((tx) =>
          tx
            .update(schema.toolVersions)
            .set({
              consequenceTags: ["moves_money"],
              classification: null,
              classifiedRiskGrade: null,
              classifiedAt: null,
            })
            .where(eq(schema.toolVersions.id, paymentVersionId)),
        );
      }
    });

    it("stamps the consequences a rule was authored against, and re-stamps only on a write that re-checks them", async () => {
      // The ordering attack the stamp closes (#3133): the accountability gate
      // is on the WRITE, so authoring the rule while the tool is harmless and
      // classifying it `moves_money` afterwards reaches the same end without
      // the gate ever firing. The stamp is what the evaluation compares
      // against, so the rule stops releasing calls until someone saves it
      // again — and saving re-runs the gate.
      await set(ownerUserId, [RULE]);
      const authored = (await list(ownerUserId)).items[0]!;
      // Sorted and effective: the payment tool declares moves_money.
      expect(authored.authoredConsequences).toEqual(["moves_money"]);

      // Switching OFF takes no new authority, so it re-checks nothing and must
      // carry the stamp through rather than blessing whatever the tool carries
      // now.
      const off = await inScope(() =>
        approvalRuleEnabledSetHandler(
          { ruleId: RULE.id, enabled: false },
          ctx(ownerUserId),
        ),
      );
      expect(
        off.items.find((r) => r.id === RULE.id)!.authoredConsequences,
      ).toEqual(["moves_money"]);

      // A classification lands under the rule while it is off.
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
          .where(eq(schema.toolVersions.id, paymentVersionId)),
      );
      try {
        // Switching ON re-runs the gate, so it re-stamps — and the new tag is
        // in the stamp because the caller was just held accountable for it.
        const on = await inScope(() =>
          approvalRuleEnabledSetHandler(
            { ruleId: RULE.id, enabled: true },
            ctx(ownerUserId),
          ),
        );
        expect(
          on.items.find((r) => r.id === RULE.id)!.authoredConsequences,
        ).toEqual(["changes_access", "moves_money"]);
      } finally {
        await withSystemDb((tx) =>
          tx
            .update(schema.toolVersions)
            .set({
              classification: null,
              classifiedRiskGrade: null,
              classifiedAt: null,
            })
            .where(eq(schema.toolVersions.id, paymentVersionId)),
        );
      }
    });

    it("refuses a write whose `replaces` no longer matches the stored set, and writes nothing", async () => {
      // The one-rule save in the app reads the set, splices one rule in and
      // sends the read back as `replaces`. A rule deleted in between must not
      // be written back by that save.
      const other = { ...RULE, id: "release-tooling" };
      await set(ownerUserId, [RULE, other]);
      const read = [RULE, other];
      await inScope(() =>
        approvalRuleDeleteHandler({ ruleId: other.id }, ctx(ownerUserId)),
      );
      const before = await settingsOf();
      await expect(
        inScope(() =>
          approvalRuleSetHandler(
            {
              rules: [{ ...RULE, name: "Edited" }, other],
              replaces: read,
              saving: [RULE.id],
            } as never,
            ctx(ownerUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("rule_set_changed"));
      expect(await settingsOf()).toEqual(before);

      // Against the set as it stands now, the same edit goes through.
      const out = await inScope(() =>
        approvalRuleSetHandler(
          {
            rules: [{ ...RULE, name: "Edited" }],
            replaces: [RULE],
            saving: [RULE.id],
          } as never,
          ctx(ownerUserId),
        ),
      );
      expect(out.items.map((r) => [r.id, r.name])).toEqual([
        [RULE.id, "Edited"],
      ]);
    });

    it("keeps an unchanged rule's stamp when another rule is edited, and re-stamps a rule `saving` names", async () => {
      // Re-stamping an unchanged rule would re-authorise it without anyone
      // choosing to: a rule held back as `consequences_changed` would start
      // releasing calls because a different rule was edited.
      const other = { ...RULE, id: "release-tooling" };
      await set(ownerUserId, [RULE, other]);
      const before = (await list(ownerUserId)).items.find(
        (r) => r.id === other.id,
      )!;
      // Clear the stored stamp on the other rule, so a re-stamp would show.
      await inScope(() =>
        withTenantDb(async (tx) => {
          const stored = await readRules(tx, workspaceId);
          await writeRules(
            tx,
            workspaceId,
            stored.map((r) =>
              r.id === other.id ? { ...r, authoredConsequences: [] } : r,
            ),
          );
        }),
      );

      const edited = await inScope(() =>
        approvalRuleSetHandler(
          { rules: [{ ...RULE, name: "Edited" }, other] } as never,
          ctx(ownerUserId),
        ),
      );
      const kept = edited.items.find((r) => r.id === other.id)!;
      expect(kept.authoredConsequences).toEqual([]);
      expect(kept.createdAt).toBe(before.createdAt);

      const resaved = await inScope(() =>
        approvalRuleSetHandler(
          {
            rules: [{ ...RULE, name: "Edited" }, other],
            saving: [other.id],
          } as never,
          ctx(ownerUserId),
        ),
      );
      expect(
        resaved.items.find((r) => r.id === other.id)!.authoredConsequences,
      ).toEqual(["moves_money"]);
    });

    it("refuses two rules under one id and leaves the stored document as it was", async () => {
      await set(ownerUserId, [RULE]);
      const before = await settingsOf();
      // The contract refuses it at the edge; the handler's own parse of the
      // document it is about to store is the second guard, so a set that
      // reaches it still writes nothing.
      await expect(
        set(ownerUserId, [RULE, { ...RULE, name: "Same id, other name" }]),
      ).rejects.toThrow();
      expect(await settingsOf()).toEqual(before);
    });

    it("refuses to store a document the gate could not load", async () => {
      await set(ownerUserId, [RULE]);
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
      await set(ownerUserId, [RULE]);
      expect((await set(ownerUserId, [])).items).toEqual([]);
      expect((await list(ownerUserId)).items).toEqual([]);
    });

    it("saves a rule whose matched tools carry exactly the stamp's ceiling, and refuses one over it", async () => {
      // The stamp is a stored field with a bound, and the bound is reachable:
      // a version carries at most 16 declared tags and 32 classified ones, the
      // vocabulary is open, and a rule matches as many tools as its patterns
      // do. Before the guard, a rule every authoring check passed was refused
      // at the store as `rule_set_would_not_load` — a fact about a generated
      // field the author never wrote.
      //
      // The two cases straddle the ceiling, because a case that does not cross
      // it proves nothing about either side of the comparison: 16 + 48 is
      // exactly MAX_AUTHORED_CONSEQUENCES and saves, 17 + 48 is one over and
      // is refused with the count.
      const tags = (prefix: string, n: number) =>
        Array.from(
          { length: n },
          (_, i) => `${prefix}_${String(i).padStart(2, "0")}`,
        );
      const wide = await declareCapabilityTool("cap__wide", {
        // 16 declared is the publisher's ceiling; 32 classified is the
        // classifier's. 48 is everything one version can carry.
        declared: tags("wide_d", 16),
        classified: tags("wide_c", 32),
      });
      const atLimit = await declareCapabilityTool("cap__at_limit", {
        declared: tags("lim_d", 16),
        classified: [],
      });
      const overLimit = await declareCapabilityTool("cap__over_limit", {
        declared: tags("over_d", 16),
        classified: tags("over_c", 1),
      });

      try {
        const base = {
          ...RULE,
          id: "wide-surface",
          maxMeasures: {},
          allowTargets: {},
        };
        // Custom tags fall to DEFAULT_CONSEQUENCE_ROLES.other — Owner or
        // Admin — so the consequence gate is not what answers either case.
        const saved = await set(ownerUserId, [
          { ...base, tools: ["cap__wide@*", "cap__at_limit@*"] },
        ]);
        expect(saved.items).toHaveLength(1);
        const stored = (await settingsOf()).decisionRules as Record<
          string,
          unknown
        >;
        const rules = stored.autoApproval as Array<{
          authoredConsequences: string[];
        }>;
        expect(rules[0]!.authoredConsequences).toHaveLength(64);

        const before = await settingsOf();
        await expect(
          set(ownerUserId, [
            { ...base, tools: ["cap__wide@*", "cap__over_limit@*"] },
          ]),
        ).rejects.toSatisfy((e: unknown) => {
          if (!isHandlerError(e)) return false;
          return (
            e.code === "conflict" &&
            e.reason === "too_many_consequences" &&
            // The count and the limit, so the author learns what exceeded what.
            e.message.includes("65") &&
            e.message.includes("64")
          );
        });
        // The refusal leaves the rule that did save exactly as it was.
        expect(await settingsOf()).toEqual(before);

        await set(ownerUserId, []);
      } finally {
        await removeTools([wide, atLimit, overLimit]);
      }
    });

    // ── list and the counters ────────────────────────────────────────────────

    it("counts the calls a rule released and the calls it held over the window", async () => {
      await set(ownerUserId, [RULE]);
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

      const out = await list(ownerUserId);
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
      await set(ownerUserId, [RULE]);
      const off = await inScope(() =>
        approvalRuleEnabledSetHandler(
          { ruleId: RULE.id, enabled: false },
          ctx(ownerUserId),
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
            ctx(ownerUserId),
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
          ctx(ownerUserId),
        ),
      );
      expect(on.items[0]!.enabled).toBe(true);
    });

    it("stamps the toggle with whoever flipped it, not the rule's original author", async () => {
      // approvalRuleSchema documents createdBy/createdAt as whoever LAST wrote
      // the rule and when, and a toggle is the write that decides whether the
      // rule releases calls without a person. Attributing the currently active
      // state to the previous author is the one thing an auditor must not read
      // off this record.
      //
      // The flipper is an Admin, who could not have AUTHORED this rule — the
      // tool moves money and only Owner or Billing is accountable for that —
      // so the attribution visibly moves to someone other than the author
      // rather than passing by coincidence.
      const secondAdminId = randomUUID();
      extraUserIds.push(secondAdminId);
      doubles.roles.set(secondAdminId, "Admin");
      const secondAdminPublicId = await withSystemDb(async (tx) => {
        const [u] = await tx
          .insert(schema.users)
          .values({
            id: secondAdminId,
            email: `admin2-${tag}@rules.test`,
            status: "active",
          })
          .returning({ publicId: schema.users.publicId });
        return u!.publicId;
      });

      await set(ownerUserId, [RULE]);
      const authored = (await list(ownerUserId)).items[0]!;
      expect(authored.createdBy).toBe(ownerPublicId);

      const after = await inScope(() =>
        approvalRuleEnabledSetHandler(
          { ruleId: RULE.id, enabled: false },
          ctx(secondAdminId),
        ),
      );
      const toggled = after.items.find((r) => r.id === RULE.id)!;
      expect(toggled.enabled).toBe(false);
      expect(toggled.createdBy).toBe(secondAdminPublicId);
      expect(
        Date.parse(toggled.createdAt) >= Date.parse(authored.createdAt),
      ).toBe(true);
    });

    it("re-stamps only the rule it toggles", async () => {
      await set(ownerUserId, [RULE, { ...RULE, id: "release-tooling" }]);
      const before = await list(ownerUserId);
      const untouchedBefore = before.items.find(
        (r) => r.id === "release-tooling",
      )!;
      const after = await inScope(() =>
        approvalRuleEnabledSetHandler(
          { ruleId: RULE.id, enabled: false },
          ctx(ownerUserId),
        ),
      );
      const untouchedAfter = after.items.find(
        (r) => r.id === "release-tooling",
      )!;
      expect(untouchedAfter.createdAt).toBe(untouchedBefore.createdAt);
      expect(untouchedAfter.createdBy).toBe(untouchedBefore.createdBy);
      expect(untouchedAfter.enabled).toBe(untouchedBefore.enabled);
    });

    it("keeps both of two rules switched off at once, against a concurrent write", async () => {
      // The lost update this guards: both calls read the same array, each
      // changes its own rule, and the second stores a copy that still has the
      // first rule on. The row lock serialises them, so both stick.
      await set(ownerUserId, [RULE, { ...RULE, id: "release-tooling" }]);
      const toggle = (ruleId: string) =>
        inScope(() =>
          approvalRuleEnabledSetHandler(
            { ruleId, enabled: false },
            ctx(ownerUserId),
          ),
        );
      await Promise.all([toggle(RULE.id), toggle("release-tooling")]);
      const after = await list(ownerUserId);
      expect(after.items.map((r) => [r.id, r.enabled])).toEqual([
        [RULE.id, false],
        ["release-tooling", false],
      ]);
    });

    it("refuses to switch a rule that is not there", async () => {
      await set(ownerUserId, [RULE]);
      await expect(
        inScope(() =>
          approvalRuleEnabledSetHandler(
            { ruleId: "not-a-rule", enabled: false },
            ctx(ownerUserId),
          ),
        ),
      ).rejects.toSatisfy(notFound);
    });

    // ── delete ───────────────────────────────────────────────────────────────

    it("removes one rule and keeps the rest", async () => {
      await set(ownerUserId, [RULE, { ...RULE, id: "release-tooling" }]);
      const out = await inScope(() =>
        approvalRuleDeleteHandler({ ruleId: RULE.id }, ctx(ownerUserId)),
      );
      expect(out.items.map((r) => r.id)).toEqual(["release-tooling"]);
      expect(doubles.events.at(-1)).toEqual({
        eventType: "approval_rule.deleted",
        capability: "delete_approval_rule",
      });
      await expect(
        inScope(() =>
          approvalRuleDeleteHandler({ ruleId: RULE.id }, ctx(ownerUserId)),
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
          ctx(ownerUserId),
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
          ctx(ownerUserId),
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
        resolvedByUserId: ownerUserId,
      });
      const out = await inScope(() =>
        approvalAutoEligibilityGetHandler(
          { approvalId: row.publicId },
          ctx(ownerUserId),
        ),
      );
      expect(out.resolvedBy).toBe(`user:${ownerPublicId}`);
      expect(out.eligibility).toBeNull();
    });

    it("refuses an approval this workspace does not hold", async () => {
      await expect(
        inScope(() =>
          approvalAutoEligibilityGetHandler(
            { approvalId: randomUUID() },
            ctx(ownerUserId),
          ),
        ),
      ).rejects.toSatisfy(notFound);
    });
  },
);
