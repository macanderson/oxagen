/**
 * The six mandate handlers against Postgres (ADR-059; issue #2957 §8). Runs
 * in the CI Postgres job and locally with DATABASE_URL set; skipped otherwise.
 *
 * The role gate is a double: `assertOrgRole` resolves the role the test
 * names for the caller and refuses when it is outside the roles the handler
 * asks for, so each test asserts WHICH roles the handler asks for against
 * the workspace's consequence roles (INV-29) without seeding the IAM tables.
 * The security-event emitter is a double that records what was emitted.
 *
 * Guards and their negatives:
 *   grant   — a Billing user grants moves_money; a Compliance user is refused;
 *             an override to [Compliance] flips both; two tags with no common
 *             role → no_role_covers_all_tags before any read; a pattern that
 *             matches no tool, or only an untagged tool → no_tool_matches;
 *             a limit over an undeclared
 *             measure → measure_not_declared; nothing is inserted on refusal;
 *             requestId on an active row → not_a_draft; the grant records
 *             grantedBy, roleAtGrant, status active and emits mandate.granted
 *   request — a workspace Member writes a draft with requestedBy and no event
 *   list    — the office sees every mandate; an operator sees only the
 *             mandates of agents they created; agentId narrows
 *   get     — the operator of another agent is refused; the office reads
 *             the ledger rows newest first; an unknown id → not_found
 *   revoke  — releases the parked reservation, expires the parked approval,
 *             records the reason and emits mandate.revoked; a second revoke
 *             → mandate_ended; a draft is declined the same way
 *   limits  — validTo before validFrom → validity_inverted; a change over an
 *             undeclared measure is refused; a change records and emits, and
 *             a per_period changed inside the period reports remaining
 *             against what the period already drew
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
  /** userId → org role name the double resolves. */
  roles: new Map<string, { org: string | null; workspace: string | null }>(),
  events: [] as Array<{ eventType: string; capability: string | null }>,
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId: string | null }) => ctx.userId,
  assertOrgRole: async (
    ctx: { userId: string | null },
    required: { org: readonly string[]; workspace?: readonly string[] },
  ) => {
    if (!ctx.userId) {
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    }
    const held = doubles.roles.get(ctx.userId) ?? {
      org: null,
      workspace: null,
    };
    if (held.org && required.org.includes(held.org)) return held.org;
    if (held.workspace && required.workspace?.includes(held.workspace)) {
      return held.workspace;
    }
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
  "mandate handlers against Postgres",
  async () => {
    const { schema, withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq, inArray } = await import("drizzle-orm");
    const { SPEC_MANDATE_BODY } = await import(
      "@oxagen/oxagen/mandates/schemas.sample"
    );
    const { mandateGrant } = await import(
      "@oxagen/oxagen/contracts/mandate.grant"
    );
    const { mandateGrantHandler } = await import("./mandate.grant");
    const { mandateRequestHandler } = await import("./mandate.request");
    const { mandateListHandler } = await import("./mandate.list");
    const { mandateGetHandler } = await import("./mandate.get");
    const { mandateRevokeHandler } = await import("./mandate.revoke");
    const { mandateLimitsUpdateHandler } = await import(
      "./mandate.limits.update"
    );

    const tag = Date.now().toString(36).slice(-6);
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const billingUserId = randomUUID();
    const complianceUserId = randomUUID();
    const operatorUserId = randomUUID();
    const otherOperatorUserId = randomUUID();
    const invoiceBotPrincipal = randomUUID();
    const otherBotPrincipal = randomUUID();
    let invoiceBotId = "";
    let otherBotId = "";
    let billingPublicId = "";

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

    const body = () => ({
      ...SPEC_MANDATE_BODY,
      agentId: invoiceBotId,
      tools: ["stripe__create_payment@*"],
    });
    const grant = (userId: string, input: Record<string, unknown>) =>
      inScope(() =>
        mandateGrantHandler(mandateGrant.input.parse(input), ctx(userId)),
      );

    const forbidden = (reason: string) => (e: unknown) =>
      isHandlerError(e) && e.code === "forbidden" && e.reason === reason;
    const conflict = (reason: string) => (e: unknown) =>
      isHandlerError(e) && e.code === "conflict" && e.reason === reason;
    const notFound = (e: unknown) =>
      isHandlerError(e) && e.code === "not_found";

    beforeAll(async () => {
      doubles.roles.set(billingUserId, { org: "Billing", workspace: null });
      doubles.roles.set(complianceUserId, {
        org: "Compliance",
        workspace: null,
      });
      doubles.roles.set(operatorUserId, { org: null, workspace: "Member" });
      doubles.roles.set(otherOperatorUserId, {
        org: null,
        workspace: "Member",
      });
      await withSystemDb(async (tx) => {
        const [billing] = await tx
          .insert(schema.users)
          .values({
            id: billingUserId,
            email: `billing-${tag}@mandates.test`,
            status: "active",
          })
          .returning({ publicId: schema.users.publicId });
        billingPublicId = billing!.publicId;
        await tx.insert(schema.workspaces).values({
          id: workspaceId,
          orgId,
          name: "Finance",
          slug: `finance-${tag}`,
          namespace: `fin${tag}`.slice(0, 6),
        });
        const [bot] = await tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "invoice-bot",
            name: "Invoice bot",
            agentType: "custom",
            principalId: invoiceBotPrincipal,
            createdByUserId: operatorUserId,
          })
          .returning({ publicId: schema.agents.publicId });
        invoiceBotId = bot!.publicId;
        const [other] = await tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "other-bot",
            name: "Other bot",
            agentType: "custom",
            principalId: otherBotPrincipal,
            createdByUserId: otherOperatorUserId,
          })
          .returning({ publicId: schema.agents.publicId });
        otherBotId = other!.publicId;
        const toolId = randomUUID();
        const versionId = randomUUID();
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
          .set({ activeVersionId: versionId })
          .where(eq(schema.tools.id, toolId));
        // An untagged tool: the gate has no opinion on it, so no mandate may name it.
        const untaggedId = randomUUID();
        const untaggedVersionId = randomUUID();
        await tx.insert(schema.tools).values({
          id: untaggedId,
          orgId,
          workspaceId,
          name: "stripe__list_payments",
          slug: "stripe__list_payments",
          source: "builtin",
          enabled: true,
        });
        await tx.insert(schema.toolVersions).values({
          id: untaggedVersionId,
          orgId,
          workspaceId,
          toolId: untaggedId,
          versionNumber: 1,
          isLatest: true,
          inputSchema: {},
          riskGrade: "low",
          manifest: {},
          checksum: "1".repeat(64),
          measures: {
            amount: { path: "amount", type: "amount", unit: "USD", scale: 2 },
          },
        });
        await tx
          .update(schema.tools)
          .set({ activeVersionId: untaggedVersionId })
          .where(eq(schema.tools.id, untaggedId));
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        const ids = (
          await tx
            .select({ id: schema.mandates.id })
            .from(schema.mandates)
            .where(eq(schema.mandates.workspaceId, workspaceId))
        ).map((r) => r.id);
        if (ids.length > 0) {
          await tx
            .delete(schema.approvalRequests)
            .where(inArray(schema.approvalRequests.mandateId, ids));
          await tx
            .delete(schema.mandateLedger)
            .where(inArray(schema.mandateLedger.mandateId, ids));
          await tx
            .delete(schema.mandates)
            .where(inArray(schema.mandates.id, ids));
        }
        await tx
          .delete(schema.tools)
          .where(eq(schema.tools.workspaceId, workspaceId));
        await tx
          .delete(schema.toolVersions)
          .where(eq(schema.toolVersions.workspaceId, workspaceId));
        await tx
          .delete(schema.agents)
          .where(eq(schema.agents.workspaceId, workspaceId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId));
        await tx.delete(schema.users).where(eq(schema.users.id, billingUserId));
      });
    });

    beforeEach(() => {
      doubles.events.length = 0;
    });

    /**
     * One reservation of `amount` micros and one call, as the gate writes
     * them: a reserve row per limited measure filed under the current
     * period, balance_after the remaining after the row. Returns the row id
     * of the mandate.
     */
    async function seedReservation(
      mandatePublicId: string,
      amount: string,
      toolCallId: string,
    ): Promise<string> {
      const at = new Date();
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ id: schema.mandates.id })
          .from(schema.mandates)
          .where(eq(schema.mandates.publicId, mandatePublicId)),
      );
      const monthly = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
      const daily = `${monthly}-${String(at.getUTCDate()).padStart(2, "0")}`;
      await withSystemDb((tx) =>
        tx.insert(schema.mandateLedger).values([
          {
            orgId,
            workspaceId,
            mandateId: row!.id,
            toolCallId,
            kind: "reserve",
            measure: "amount",
            value: amount,
            unitOrCurrency: "USD",
            periodKey: monthly,
            balanceAfter: (2000000000n - BigInt(amount)).toString(),
          },
          {
            orgId,
            workspaceId,
            mandateId: row!.id,
            toolCallId,
            kind: "reserve",
            measure: "calls",
            value: "1",
            unitOrCurrency: "calls",
            periodKey: daily,
            balanceAfter: "49",
          },
        ]),
      );
      return row!.id;
    }

    const countMandates = () =>
      withSystemDb(
        async (tx) =>
          (
            await tx
              .select({ id: schema.mandates.id })
              .from(schema.mandates)
              .where(eq(schema.mandates.workspaceId, workspaceId))
          ).length,
      );

    // ── grant ──────────────────────────────────────────────────────────────────

    it("grant: the role the workspace names for the consequence grants; another accountable role is refused; nothing is written on refusal", async () => {
      const before = await countMandates();
      await expect(grant(complianceUserId, body())).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
      expect(await countMandates()).toBe(before);
      expect(doubles.events).toEqual([]);

      const out = await grant(billingUserId, body());
      expect(out).toMatchObject({
        agentId: invoiceBotId,
        agentSlug: "invoice-bot",
        grantedBy: billingPublicId,
        roleAtGrant: "Billing",
        status: "active",
        consequenceTags: ["moves_money"],
        requestedBy: null,
      });
      expect(out.id).toMatch(/^mnd_/);
      expect(out.authority).toEqual([
        expect.objectContaining({
          measure: "amount",
          remaining: "2000000000",
          reserved: "0",
          settled: "0",
        }),
        expect.objectContaining({ measure: "calls", remaining: "50" }),
      ]);
      expect(doubles.events).toEqual([
        { eventType: "mandate.granted", capability: "grant_mandate" },
      ]);
    });

    it("grant: a consequence-role override moves the authority to the role it names", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ consequenceRoles: { moves_money: ["Compliance"] } })
          .where(eq(schema.workspaces.id, workspaceId)),
      );
      try {
        await expect(grant(billingUserId, body())).rejects.toSatisfy(
          forbidden("org_role_required"),
        );
        const out = await grant(complianceUserId, body());
        expect(out.roleAtGrant).toBe("Compliance");
      } finally {
        await withSystemDb((tx) =>
          tx
            .update(schema.workspaces)
            .set({ consequenceRoles: {} })
            .where(eq(schema.workspaces.id, workspaceId)),
        );
      }
    });

    it("grant: two tags with no role in common are refused before anything is read", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({
            consequenceRoles: {
              moves_money: ["Billing"],
              changes_access: ["Compliance"],
            },
          })
          .where(eq(schema.workspaces.id, workspaceId)),
      );
      try {
        await expect(
          grant(billingUserId, {
            ...body(),
            consequenceTags: ["moves_money", "changes_access"],
          }),
        ).rejects.toSatisfy(forbidden("no_role_covers_all_tags"));
      } finally {
        await withSystemDb((tx) =>
          tx
            .update(schema.workspaces)
            .set({ consequenceRoles: {} })
            .where(eq(schema.workspaces.id, workspaceId)),
        );
      }
    });

    it("grant: denied by construction — a pattern matching no tool or only an untagged one, and a limit over a measure the tool does not declare", async () => {
      const before = await countMandates();
      await expect(
        grant(billingUserId, { ...body(), tools: ["aws_billing__purchase@*"] }),
      ).rejects.toSatisfy(conflict("no_tool_matches"));
      await expect(
        grant(billingUserId, { ...body(), tools: ["stripe__list_payments"] }),
      ).rejects.toSatisfy(conflict("no_tool_matches"));
      await expect(
        grant(billingUserId, {
          ...body(),
          limits: {
            rows_affected: {
              perPeriod: "10",
              period: "daily",
              currencyOrUnit: "rows",
            },
          },
        }),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
      await expect(
        grant(billingUserId, {
          ...body(),
          targets: { region: { allow: ["eu-*"], deny: [] } },
        }),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
      // A text measure cannot carry a limit; a target over an amount measure is allowed to be named.
      await expect(
        grant(billingUserId, {
          ...body(),
          limits: {
            counterparty: {
              perCall: "1",
              period: "daily",
              currencyOrUnit: "vendor",
            },
          },
        }),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
      // The unit is the third field of the same declaration and the gate reads
      // the call by it, so a limit denominated differently is enforced in the
      // tool's unit while every screen shows the operator's. `amount` is
      // declared in USD; a limit calling it EUR, or "cents", would be approved
      // as one thing and enforced as another.
      for (const unit of ["EUR", "cents", "usd", "GB"]) {
        await expect(
          grant(billingUserId, {
            ...body(),
            limits: {
              amount: {
                perCall: "1000000",
                period: "daily",
                currencyOrUnit: unit,
              },
            },
          }),
        ).rejects.toSatisfy(conflict("measure_unit_mismatch"));
      }
      expect(await countMandates()).toBe(before);
      expect(doubles.events).toEqual([]);
    });

    it("grant: an unknown agent is not found; requestId must name a draft", async () => {
      await expect(
        grant(billingUserId, {
          ...body(),
          agentId: "agt_0123456789abcdefghjkmn",
        }),
      ).rejects.toSatisfy(notFound);
      const active = await grant(billingUserId, body());
      await expect(
        grant(billingUserId, { ...body(), requestId: active.id }),
      ).rejects.toSatisfy(conflict("not_a_draft"));
    });

    // ── request → grant, list, get ─────────────────────────────────────────────

    it("request: a workspace member records a draft that grants nothing, and the office activates it by requestId", async () => {
      const draft = await inScope(() =>
        mandateRequestHandler(
          mandateGrant.input.parse(body()),
          ctx(operatorUserId),
        ),
      );
      expect(draft).toMatchObject({
        status: "draft",
        grantedBy: null,
        roleAtGrant: null,
      });
      expect(draft.requestedBy).toBeNull(); // the operator has no users row in this fixture
      expect(doubles.events).toEqual([]);

      const granted = await grant(billingUserId, {
        ...body(),
        requestId: draft.id,
        purpose: "granted as asked",
      });
      expect(granted).toMatchObject({
        id: draft.id,
        status: "active",
        roleAtGrant: "Billing",
        purpose: "granted as asked",
      });
    });

    it("list: the office sees every mandate; an operator sees only the mandates of agents they created; agentId narrows", async () => {
      const otherBotMandate = await grant(billingUserId, {
        ...body(),
        agentId: otherBotId,
      });
      const office = await inScope(() =>
        mandateListHandler({ limit: 50 }, ctx(billingUserId)),
      );
      expect(office.items.map((m) => m.id)).toContain(otherBotMandate.id);
      expect(new Set(office.items.map((m) => m.agentId))).toEqual(
        new Set([invoiceBotId, otherBotId]),
      );

      const operator = await inScope(() =>
        mandateListHandler({ limit: 50 }, ctx(operatorUserId)),
      );
      expect(operator.items.length).toBeGreaterThan(0);
      expect(new Set(operator.items.map((m) => m.agentId))).toEqual(
        new Set([invoiceBotId]),
      );

      const narrowed = await inScope(() =>
        mandateListHandler(
          { limit: 50, agentId: otherBotId, status: "active" },
          ctx(billingUserId),
        ),
      );
      expect(narrowed.items.map((m) => m.id)).toEqual([otherBotMandate.id]);

      const operatorNarrowed = await inScope(() =>
        mandateListHandler(
          { limit: 50, agentId: otherBotId },
          ctx(operatorUserId),
        ),
      );
      expect(operatorNarrowed.items).toEqual([]);
      await expect(
        inScope(() => mandateListHandler({ limit: 50 }, ctx(null))),
      ).rejects.toSatisfy(forbidden("no_principal"));
    });

    it("get: the operator of another agent is refused; the office reads the ledger newest first; an unknown id is not found", async () => {
      const m = await grant(billingUserId, body());
      await seedReservation(m.id, "150000000", randomUUID());
      await expect(
        inScope(() =>
          mandateGetHandler(
            { mandateId: m.id, ledgerLimit: 100 },
            ctx(otherOperatorUserId),
          ),
        ),
      ).rejects.toSatisfy(forbidden("org_role_required"));

      const asOperator = await inScope(() =>
        mandateGetHandler(
          { mandateId: m.id, ledgerLimit: 100 },
          ctx(operatorUserId),
        ),
      );
      expect(asOperator.mandate.id).toBe(m.id);

      const out = await inScope(() =>
        mandateGetHandler(
          { mandateId: m.id, ledgerLimit: 100 },
          ctx(billingUserId),
        ),
      );
      expect(out.ledger).toHaveLength(2);
      expect(out.ledger.map((r) => r.measure).sort()).toEqual([
        "amount",
        "calls",
      ]);
      expect(out.ledger.find((r) => r.measure === "amount")).toMatchObject({
        kind: "reserve",
        value: "150000000",
        balanceAfter: "1850000000",
      });
      expect(
        out.mandate.authority.find((a) => a.measure === "amount"),
      ).toMatchObject({
        remaining: "1850000000",
        reserved: "150000000",
      });
      await expect(
        inScope(() =>
          mandateGetHandler(
            { mandateId: "mnd_0123456789abcdefghjkmn", ledgerLimit: 100 },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(notFound);
    });

    // ── revoke, limits ─────────────────────────────────────────────────────────

    it("revoke: releases what parked calls hold, expires the parked approval, records the reason and emits; a second revoke is a conflict", async () => {
      const m = await grant(billingUserId, body());
      const toolCallId = randomUUID();
      const mandateRowId = await seedReservation(m.id, "200000000", toolCallId);
      await withSystemDb((tx) =>
        tx.insert(schema.approvalRequests).values({
          orgId,
          workspaceId,
          toolCallId,
          capabilityName: "stripe__create_payment",
          inputPreview: {},
          riskLevel: "high",
          mandateId: mandateRowId,
          ruleIds: [`mandate:${m.id}:human_above:amount`],
          inputDigest: "0".repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      doubles.events.length = 0;

      await expect(
        inScope(() =>
          mandateRevokeHandler(
            { mandateId: m.id, reason: "PO closed" },
            ctx(complianceUserId),
          ),
        ),
      ).rejects.toSatisfy(forbidden("org_role_required"));

      const out = await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "PO closed" },
          ctx(billingUserId),
        ),
      );
      expect(out).toMatchObject({
        status: "revoked",
        revokedReason: "PO closed",
        revokedBy: billingPublicId,
      });
      expect(out.revokedAt).not.toBeNull();
      expect(out.authority.find((a) => a.measure === "amount")).toMatchObject({
        remaining: "2000000000",
        reserved: "0",
      });
      const [approval] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.mandateId, mandateRowId)),
      );
      expect(approval!.resolution).toBe("expired");
      expect(doubles.events).toEqual([
        { eventType: "mandate.revoked", capability: "revoke_mandate" },
      ]);

      await expect(
        inScope(() =>
          mandateRevokeHandler(
            { mandateId: m.id, reason: "again" },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("mandate_ended"));
    });

    it("revoke: a draft is declined the same way", async () => {
      const draft = await inScope(() =>
        mandateRequestHandler(
          mandateGrant.input.parse(body()),
          ctx(operatorUserId),
        ),
      );
      const out = await inScope(() =>
        mandateRevokeHandler(
          { mandateId: draft.id, reason: "not needed" },
          ctx(billingUserId),
        ),
      );
      expect(out.status).toBe("revoked");
    });

    it("limits: validity cannot invert, an undeclared measure is refused, and a change records, emits and binds the period already drawn on", async () => {
      const m = await grant(billingUserId, body());
      await seedReservation(m.id, "150000000", randomUUID());
      doubles.events.length = 0;
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            { mandateId: m.id, validTo: "2026-08-01T00:00:00Z" },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("validity_inverted"));
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            {
              mandateId: m.id,
              limits: {
                rows: { perCall: "1", period: "daily", currencyOrUnit: "rows" },
              },
            },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("measure_not_declared"));
      // Widening a limit is the other path that writes one, and it goes
      // through the same assertion.
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            {
              mandateId: m.id,
              limits: {
                amount: {
                  perCall: "1000000",
                  period: "daily",
                  currencyOrUnit: "EUR",
                },
              },
            },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("measure_unit_mismatch"));
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            { mandateId: m.id, validTo: "2027-01-31T00:00:00Z" },
            ctx(complianceUserId),
          ),
        ),
      ).rejects.toSatisfy(forbidden("org_role_required"));
      expect(doubles.events).toEqual([]);

      // The same monthly period the 150 was drawn in: the new ceiling
      // applies to it, so remaining is 500 − 150.
      const out = await inScope(() =>
        mandateLimitsUpdateHandler(
          {
            mandateId: m.id,
            limits: {
              amount: {
                perCall: "100000000",
                perPeriod: "500000000",
                period: "monthly",
                currencyOrUnit: "USD",
              },
            },
            validTo: "2027-01-31T00:00:00Z",
          },
          ctx(billingUserId),
        ),
      );
      expect(out.limits).toEqual({
        amount: {
          perCall: "100000000",
          perPeriod: "500000000",
          period: "monthly",
          currencyOrUnit: "USD",
        },
      });
      expect(out.validTo).toBe("2027-01-31T00:00:00.000Z");
      expect(out.authority).toEqual([
        expect.objectContaining({
          measure: "amount",
          period: "monthly",
          remaining: "350000000",
          reserved: "150000000",
        }),
      ]);
      expect(doubles.events).toEqual([
        {
          eventType: "mandate.limits_changed",
          capability: "update_mandate_limits",
        },
      ]);

      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            { mandateId: m.id, validTo: "2027-02-01T00:00:00Z" },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("mandate_ended"));
    });
  },
);
