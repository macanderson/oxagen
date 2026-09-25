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
 *   retire  — grant and request take the agent row lock retire_agent holds,
 *             so one in flight makes them wait and then refuse; a draft a
 *             concurrent grant rebinds to another agent is not revoked; an
 *             agent already archived with an active mandate still has it
 *             revoked, and its recorded retirement is unchanged
 *   limits  — validTo before validFrom → validity_inverted; a change over an
 *             undeclared measure is refused; a change records and emits, and
 *             a per_period changed inside the period reports remaining
 *             against what the period already drew; two limitChanges to two
 *             measures both survive, merged under the row lock (ADR-102)
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
    const { and, eq, inArray } = await import("drizzle-orm");
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
    const { agentRetireHandler } = await import("./agent.retire");

    const tag = Date.now().toString(36).slice(-6);
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const billingUserId = randomUUID();
    const complianceUserId = randomUUID();
    const operatorUserId = randomUUID();
    const otherOperatorUserId = randomUUID();
    const ownerUserId = randomUUID();
    const invoiceBotPrincipal = randomUUID();
    const otherBotPrincipal = randomUUID();
    const retiringBotPrincipal = randomUUID();
    let invoiceBotId = "";
    let otherBotId = "";
    let retiringBotId = "";
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
      doubles.roles.set(ownerUserId, { org: "Owner", workspace: null });
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
            createdById: operatorUserId,
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
            createdById: otherOperatorUserId,
          })
          .returning({ publicId: schema.agents.publicId });
        otherBotId = other!.publicId;
        const [retiring] = await tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "retiring-bot",
            name: "Retiring bot",
            agentType: "custom",
            principalId: retiringBotPrincipal,
            createdById: operatorUserId,
          })
          .returning({ publicId: schema.agents.publicId });
        retiringBotId = retiring!.publicId;
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
      // The built-in measure is exempt from the declared-measure check, not
      // from having a correct unit: the gate reads it as a call ceiling while
      // every screen reads `USD` as money, so 250000000 is 250 million calls
      // and $250.00 at once.
      for (const unit of ["USD", "rows", "Calls"]) {
        await expect(
          grant(billingUserId, {
            ...body(),
            limits: {
              calls: {
                perPeriod: "250000000",
                period: "daily",
                currencyOrUnit: unit,
              },
            },
          }),
        ).rejects.toSatisfy(conflict("measure_unit_mismatch"));
      }
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

    // #3138 (ADR-107): request_mandate and list_mandates now admit the same
    // roles, so IAM lets a non-accountable reader reach the handler; this
    // pins what readerFilter's creator-narrowing does with that admission:
    // a reader who created nothing reads nothing, not the whole ledger.
    it("list: a reader with no accountable role who created no agent reads nothing", async () => {
      const bystanderUserId = randomUUID();
      doubles.roles.set(bystanderUserId, { org: null, workspace: "Member" });
      const bystander = await inScope(() =>
        mandateListHandler({ limit: 50 }, ctx(bystanderUserId)),
      );
      expect(bystander.items).toEqual([]);
    });

    // #3440: readerFilter's workspace leg must run its own assertOrgRole
    // check against Owner/Member, not treat every signed-in user the org
    // leg refused as a narrowed reader. This matters beyond enterprise
    // orgs: checkIAM allows every capability unconditionally on a
    // non-enterprise tier, so this handler-level check is the only gate a
    // Free/Build/Scale org actually runs, and a workspace Viewer (or an
    // Owner/Member demoted after creating an agent) must not pass it.
    it("list/get: a workspace Viewer is refused, not treated as a narrowed reader", async () => {
      const viewerUserId = randomUUID();
      doubles.roles.set(viewerUserId, { org: null, workspace: "Viewer" });
      await expect(
        inScope(() => mandateListHandler({ limit: 50 }, ctx(viewerUserId))),
      ).rejects.toSatisfy(forbidden("org_role_required"));
      const m = await grant(billingUserId, body());
      await expect(
        inScope(() =>
          mandateGetHandler(
            { mandateId: m.id, ledgerLimit: 100 },
            ctx(viewerUserId),
          ),
        ),
      ).rejects.toSatisfy(forbidden("org_role_required"));
      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
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

    // #3440 (ADR-107 widened): request_mandate admits a workspace Owner or
    // Member to request a mandate for ANY agent, not only one they created,
    // so readerFilter's creator-only narrowing let a requester create a
    // draft they could never read back for an agent someone else operates.
    // list_mandates and get_mandate now also admit a mandate the caller
    // requested themselves, whichever agent it names.
    it("list/get: a requester who does not operate the agent still reads the draft they requested", async () => {
      const draft = await inScope(() =>
        mandateRequestHandler(
          mandateGrant.input.parse({ ...body(), agentId: otherBotId }),
          ctx(operatorUserId),
        ),
      );
      expect(draft.agentId).toBe(otherBotId);

      // operatorUserId created invoiceBotId, not otherBotId, so only the
      // requestedBy match admits them here.
      const asRequester = await inScope(() =>
        mandateListHandler(
          { limit: 50, agentId: otherBotId },
          ctx(operatorUserId),
        ),
      );
      expect(asRequester.items.map((m) => m.id)).toContain(draft.id);

      const getAsRequester = await inScope(() =>
        mandateGetHandler(
          { mandateId: draft.id, ledgerLimit: 100 },
          ctx(operatorUserId),
        ),
      );
      expect(getAsRequester.mandate.id).toBe(draft.id);

      // otherOperatorUserId created otherBotId, so the creator path still
      // admits them independently of who requested this particular draft.
      const asCreator = await inScope(() =>
        mandateListHandler(
          { limit: 50, agentId: otherBotId },
          ctx(otherOperatorUserId),
        ),
      );
      expect(asCreator.items.map((m) => m.id)).toContain(draft.id);

      // A bystander who neither created the agent nor requested the draft
      // reads neither the list row nor the record.
      const bystanderUserId = randomUUID();
      doubles.roles.set(bystanderUserId, { org: null, workspace: "Member" });
      const asBystander = await inScope(() =>
        mandateListHandler(
          { limit: 50, agentId: otherBotId },
          ctx(bystanderUserId),
        ),
      );
      expect(asBystander.items.map((m) => m.id)).not.toContain(draft.id);
      await expect(
        inScope(() =>
          mandateGetHandler(
            { mandateId: draft.id, ledgerLimit: 100 },
            ctx(bystanderUserId),
          ),
        ),
      ).rejects.toSatisfy(forbidden("org_role_required"));
    });

    it("list/get: a requester's grant does not survive the agent's soft-delete", async () => {
      const softDeletedAgentPrincipal = randomUUID();
      const [softDeletedAgent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            // Agent slugs are capped at 18 characters for the 32-char
            // agentKey budget (agent.enforce_agent_slug_length()).
            slug: `del-bot-${randomUUID().slice(0, 8)}`,
            name: "Soft-deleted bot",
            agentType: "custom",
            principalId: softDeletedAgentPrincipal,
            createdById: otherOperatorUserId,
          })
          .returning({ publicId: schema.agents.publicId }),
      );
      const draft = await inScope(() =>
        mandateRequestHandler(
          mandateGrant.input.parse({
            ...body(),
            agentId: softDeletedAgent!.publicId,
          }),
          ctx(operatorUserId),
        ),
      );

      // Before the soft-delete, the requester grant works the same as the
      // still-live case above.
      const beforeDelete = await inScope(() =>
        mandateListHandler(
          { limit: 50, agentId: softDeletedAgent!.publicId },
          ctx(operatorUserId),
        ),
      );
      expect(beforeDelete.items.map((m) => m.id)).toContain(draft.id);

      await withSystemDb((tx) =>
        tx
          .update(schema.agents)
          .set({ deletedAt: new Date() })
          .where(eq(schema.agents.publicId, softDeletedAgent!.publicId)),
      );

      // Once the agent is soft-deleted, neither list nor get admits the
      // requester through the requester grant: a row that hasn't been purged
      // yet is not the same as a live agent, and the requester's visibility
      // must not outlive the agent it was requested for. Listed with no
      // `agentId` filter, since that filter alone already excludes a
      // soft-deleted agent's mandates (line ~33 above) and would pass even
      // without the fix this test protects.
      const afterDelete = await inScope(() =>
        mandateListHandler({ limit: 500 }, ctx(operatorUserId)),
      );
      expect(afterDelete.items.map((m) => m.id)).not.toContain(draft.id);
      await expect(
        inScope(() =>
          mandateGetHandler(
            { mandateId: draft.id, ledgerLimit: 100 },
            ctx(operatorUserId),
          ),
        ),
      ).rejects.toSatisfy(forbidden("org_role_required"));
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

      // Renaming the window while 150 is reserved would orphan that draw under
      // the old periodKey and make the new daily balance read as unused.
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            {
              mandateId: m.id,
              limits: {
                amount: {
                  perCall: "100000000",
                  perPeriod: "500000000",
                  period: "daily",
                  currencyOrUnit: "USD",
                },
              },
            },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("period_drawn"));

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
          // Stamped from the declared `amount` measure (ADR-108), not
          // supplied by this request.
          kind: "money",
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

    // The lost update ADR-102 closes, against the real row. Two operators
    // change two different measures on one mandate. Each sends only what it
    // changed, the handler merges it over the record its own lock returned, and
    // both changes stand — where a read-merge-replace round trip would have let
    // the second write restore the amount cap the first one lowered.
    it("limits: two changes to different measures both survive, and an unnamed field is kept", async () => {
      const m = await grant(billingUserId, body());
      const lower = await inScope(() =>
        mandateLimitsUpdateHandler(
          {
            mandateId: m.id,
            limitChanges: { amount: { perPeriod: "500000000" } },
          },
          ctx(billingUserId),
        ),
      );
      // Second depth: the per-call bound, the window and the currency were not
      // named, so they stand. Dropping any of them is unbounded authority for
      // that sublimit.
      expect(lower.limits.amount).toEqual({
        perCall: "250000000",
        perPeriod: "500000000",
        period: "monthly",
        currencyOrUnit: "USD",
        kind: "money",
      });
      const capped = await inScope(() =>
        mandateLimitsUpdateHandler(
          { mandateId: m.id, limitChanges: { calls: { perPeriod: "40" } } },
          ctx(billingUserId),
        ),
      );
      expect(capped.limits).toEqual({
        // Still 500, not the 2,000 the record held when the calls change was
        // composed.
        amount: {
          perCall: "250000000",
          perPeriod: "500000000",
          period: "monthly",
          currencyOrUnit: "USD",
          kind: "money",
        },
        // First depth for the calls cap, and its window is kept: the change
        // named a figure and said nothing about the period. The built-in
        // measure is always `count` (ADR-108).
        calls: {
          perPeriod: "40",
          period: "daily",
          currencyOrUnit: "calls",
          kind: "count",
        },
      });
      // The declared-measure and unit checks run on the merged record, so a
      // change is refused exactly as a replacement is.
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            {
              mandateId: m.id,
              limitChanges: { amount: { currencyOrUnit: "EUR" } },
            },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("measure_unit_mismatch"));
      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
    });

    it("list: a narrowed reader with no live agent to narrow by reads nothing, never every mandate in the workspace", async () => {
      const m = await grant(billingUserId, body());
      const bystanderUserId = randomUUID();
      doubles.roles.set(bystanderUserId, { org: null, workspace: "Member" });
      // Every agent in the workspace soft-deleted at once: `createdByOperator`
      // and `livePrincipalIds` both resolve empty, the exact state that made
      // `or(undefined, undefined)` collapse `readerScope` to `undefined` and
      // fall through the surrounding `and(...)` to an unfiltered read.
      // Restored in `finally` since `invoiceBotId`/`otherBotId` are shared
      // fixtures every other test in this file depends on being live.
      await withSystemDb((tx) =>
        tx
          .update(schema.agents)
          .set({ deletedAt: new Date() })
          .where(eq(schema.agents.workspaceId, workspaceId)),
      );
      try {
        const asBystander = await inScope(() =>
          mandateListHandler({ limit: 500 }, ctx(bystanderUserId)),
        );
        expect(asBystander.items).toEqual([]);
      } finally {
        await withSystemDb((tx) =>
          tx
            .update(schema.agents)
            .set({ deletedAt: null })
            .where(eq(schema.agents.workspaceId, workspaceId)),
        );
      }
      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
    });

    // #3130 (ADR-108 §4): a measure's kind is only re-derived from the
    // active declaration when the operator actually touches that measure's
    // limit. An update that names only validTo, targets or approval must
    // leave every measure's stored kind exactly as it was, or a mandate the
    // gate had started refusing under measure_kind_changed would silently
    // start passing again (or worse, a money limit would silently become a
    // count limit) without anyone looking at its figures.
    it("limits: a validTo-only change never re-derives a measure's kind", async () => {
      const m = await grant(billingUserId, body());
      expect(m.limits.amount).toMatchObject({ kind: "money" });
      // Simulate the state after a tool republish changed `amount`'s kind:
      // the stored limit disagrees with what a fresh stamp would produce
      // (the fixture's active declaration still says "amount"/money), which
      // is exactly the state a real drift leaves behind.
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({
            limits: {
              amount: { ...m.limits.amount, kind: "count" },
            },
          })
          .where(eq(schema.mandates.publicId, m.id)),
      );
      const untouched = await inScope(() =>
        mandateLimitsUpdateHandler(
          {
            mandateId: m.id,
            validTo: "2026-12-30T23:59:59.000Z",
          },
          ctx(billingUserId),
        ),
      );
      expect(untouched.limits.amount).toMatchObject({ kind: "count" });
      // Touching the measure explicitly is still how an operator confirms
      // the new kind and re-derives it.
      const touched = await inScope(() =>
        mandateLimitsUpdateHandler(
          {
            mandateId: m.id,
            limitChanges: { amount: { perCall: "300000000" } },
          },
          ctx(billingUserId),
        ),
      );
      expect(touched.limits.amount).toMatchObject({ kind: "money" });
      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
    });

    it("list: an enterprise org's custom role reaches the handler without a workspace Owner/Member fallback", async () => {
      // A separate org, so resolveOrgTierDetailed reads its own row rather
      // than the shared fixture's (which has none, and so resolves
      // `established: false` and always takes the workspace-role branch).
      // This stands in for a custom `role_grants` entry that admitted the
      // caller through checkIAM's real resolver without either an
      // accountable org role or a built-in workspace Owner/Member role: the
      // mocked `assertOrgRole` refuses both legs for this user exactly as a
      // custom-role-only grant would refuse them under the real resolver,
      // and readerFilter must still let the call through rather than
      // refusing a caller the kernel already admitted (#3440 follow-on).
      const enterpriseOrgId = randomUUID();
      const enterpriseWorkspaceId = randomUUID();
      const customRoleUserId = randomUUID();
      doubles.roles.set(customRoleUserId, {
        org: "CustomAuditor",
        workspace: null,
      });
      await withSystemDb((tx) =>
        tx.insert(schema.organizations).values({
          id: enterpriseOrgId,
          name: "Enterprise Co",
          slug: `enterprise-${tag}`,
          namespace: `ent${tag}`.slice(0, 6),
          planType: "enterprise",
          status: "active",
        }),
      );
      await withSystemDb((tx) =>
        tx.insert(schema.workspaces).values({
          id: enterpriseWorkspaceId,
          orgId: enterpriseOrgId,
          name: "Enterprise Workspace",
          slug: `entws-${tag}`,
          namespace: `entw${tag}`.slice(0, 6),
        }),
      );
      const enterpriseCtx: CapabilityContext = {
        orgId: enterpriseOrgId,
        workspaceId: enterpriseWorkspaceId,
        userId: customRoleUserId,
        apiKeyId: null,
        requestId: `req_${tag}_ent`,
        surface: "api",
        messageId: null,
      };
      await expect(
        runInTenantScope(
          { orgId: enterpriseOrgId, workspaceId: enterpriseWorkspaceId },
          () => mandateListHandler({ limit: 50 }, enterpriseCtx),
        ),
      ).resolves.toMatchObject({ items: [] });
      await withSystemDb((tx) =>
        tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.id, enterpriseWorkspaceId)),
      );
      await withSystemDb((tx) =>
        tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, enterpriseOrgId)),
      );
    });

    it("list: an agent-run call never runs the human workspace-role fallback", async () => {
      // Mirrors the enterprise custom-grant case above, but for an agent
      // principal on the shared fixture org's non-enterprise tier.
      // checkIAM never gives an agent principal the tier_gate bypass
      // (packages/iam/src/check-iam.ts): an agent run resolves the full
      // delegation-ceiling resolver at every tier, before the tier check
      // is even consulted, so an agent explicitly authorized for this
      // capability already cleared the kernel the same way an enterprise
      // custom grant does. readerFilter's workspace-role fallback exists
      // only to close the gap the tier_gate bypass leaves for human/
      // service calls; running it for an agent-run call would refuse an
      // agent the kernel already admitted (#3440 follow-on finding).
      const agentUserId = randomUUID();
      doubles.roles.set(agentUserId, { org: null, workspace: null });
      const agentCtx = {
        ...ctx(agentUserId),
        agentRun: { principalKind: "agent" },
      } as unknown as CapabilityContext;
      await expect(
        inScope(() => mandateListHandler({ limit: 50 }, agentCtx)),
      ).resolves.toMatchObject({ items: [] });
    });

    it("limits: a kind change is refused while the ledger still holds authority drawn under the old kind", async () => {
      const m = await grant(billingUserId, body());
      const toolCallId = randomUUID();
      await seedReservation(m.id, "150000000", toolCallId);
      // Same drift simulation as the validTo-only test above: the stored
      // limit now disagrees with what a fresh stamp of the active
      // declaration would produce, which is what touching the measure would
      // change it back to. The reservation just seeded is a live "amount"
      // row filed under the "count" kind this update would move away from.
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({
            limits: {
              amount: { ...m.limits.amount, kind: "count" },
            },
          })
          .where(eq(schema.mandates.publicId, m.id)),
      );
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            {
              mandateId: m.id,
              limitChanges: { amount: { perCall: "300000000" } },
            },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("measure_kind_drawn"));

      // Releasing the reservation nets the ledger's "amount" row to zero, so
      // periodSums and hasOpenReservation both read no live draw under the
      // old kind, and the same explicit change now succeeds.
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ id: schema.mandates.id })
          .from(schema.mandates)
          .where(eq(schema.mandates.publicId, m.id)),
      );
      // `hasDrawnInCurrentPeriod` sums by the current monthly key, the same
      // one `seedReservation` filed the reservation under: a release under
      // any other key would leave that sum still seeing the reservation as
      // drawn, refusing the change below all over again.
      const releasedAt = new Date();
      const monthly = `${releasedAt.getUTCFullYear()}-${String(releasedAt.getUTCMonth() + 1).padStart(2, "0")}`;
      await withSystemDb((tx) =>
        tx.insert(schema.mandateLedger).values({
          orgId,
          workspaceId,
          mandateId: row!.id,
          toolCallId,
          kind: "release",
          measure: "amount",
          value: "150000000",
          unitOrCurrency: "USD",
          periodKey: monthly,
          balanceAfter: "2000000000",
        }),
      );
      const freed = await inScope(() =>
        mandateLimitsUpdateHandler(
          {
            mandateId: m.id,
            limitChanges: { amount: { perCall: "300000000" } },
          },
          ctx(billingUserId),
        ),
      );
      expect(freed.limits.amount).toMatchObject({ kind: "money" });
      await withSystemDb((tx) =>
        tx
          .delete(schema.mandateLedger)
          .where(
            and(
              eq(schema.mandateLedger.mandateId, row!.id),
              eq(schema.mandateLedger.measure, "amount"),
            ),
          ),
      );
      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
    });

    it("limits: a kind change is never refused for a legacy measure with no stored kind, once its unstamped reservation clears", async () => {
      const m = await grant(billingUserId, body());
      const toolCallId = randomUUID();
      await seedReservation(m.id, "150000000", toolCallId);
      // Strip the stored kind entirely, the pre-ADR-108 shape: a stored
      // `limits.amount` with no `kind` key at all, not merely a wrong one.
      // `parseMandateRow` resolves this via `legacyMeasureKindGuess`, and
      // `locked.legacyKindMeasures` records that the resolved kind is a
      // guess, not a fact this reservation was ever drawn against.
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({
            limits: {
              amount: {
                perCall: m.limits.amount!.perCall,
                perPeriod: m.limits.amount!.perPeriod,
                period: m.limits.amount!.period,
                currencyOrUnit: m.limits.amount!.currencyOrUnit,
              },
            },
          })
          .where(eq(schema.mandates.publicId, m.id)),
      );
      // `seedReservation`'s row carries no `measureKind` (the pre-ADR-108
      // shape), so `hasUnstampedLedgerHistory` still sees it as live and
      // unverified authority until it is released: the guess being wrong
      // does not excuse a genuinely open reservation from that check.
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ id: schema.mandates.id })
          .from(schema.mandates)
          .where(eq(schema.mandates.publicId, m.id)),
      );
      await withSystemDb((tx) =>
        tx.insert(schema.mandateLedger).values({
          orgId,
          workspaceId,
          mandateId: row!.id,
          toolCallId,
          kind: "release",
          measure: "amount",
          value: "150000000",
          unitOrCurrency: "USD",
          periodKey: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`,
          balanceAfter: "2000000000",
        }),
      );
      const touched = await inScope(() =>
        mandateLimitsUpdateHandler(
          {
            mandateId: m.id,
            limitChanges: { amount: { perCall: "300000000" } },
          },
          ctx(billingUserId),
        ),
      );
      expect(touched.limits.amount).toMatchObject({ kind: "money" });
      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
    });

    it("limits: a kind change is refused for a legacy measure whose unstamped reservation is still open", async () => {
      const m = await grant(billingUserId, body());
      await seedReservation(m.id, "150000000", randomUUID());
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({
            limits: {
              amount: {
                perCall: m.limits.amount!.perCall,
                perPeriod: m.limits.amount!.perPeriod,
                period: m.limits.amount!.period,
                currencyOrUnit: m.limits.amount!.currencyOrUnit,
              },
            },
          })
          .where(eq(schema.mandates.publicId, m.id)),
      );
      let thrown: unknown;
      try {
        await inScope(() =>
          mandateLimitsUpdateHandler(
            {
              mandateId: m.id,
              limitChanges: { amount: { perCall: "300000000" } },
            },
            ctx(billingUserId),
          ),
        );
      } catch (e) {
        thrown = e;
      }
      expect(
        isHandlerError(thrown) && thrown.reason === "measure_kind_drawn",
      ).toBe(true);
      await inScope(() =>
        mandateRevokeHandler(
          { mandateId: m.id, reason: "done" },
          ctx(billingUserId),
        ),
      );
    });

    // ── retirement (ADR-106, #3124) ────────────────────────────────────────────
    // A mandate does not survive its agent's retirement: request_mandate,
    // grant_mandate and update_mandate_limits refuse to create or widen
    // authority against a retired identity, while list_mandates, get_mandate
    // and revoke_mandate (proven above against invoiceBotId/otherBotId, which
    // never retire) stay unchanged. retire_agent revokes what is live the
    // same way it revokes credentials and host enrollments.
    const retiredAgent = (e: unknown) =>
      isHandlerError(e) &&
      e.code === "conflict" &&
      e.reason === "agent_retired";

    it("retire_agent revokes every active and draft mandate bound to the agent, and request/grant/limits refuse it afterward", async () => {
      const active = await grant(billingUserId, {
        ...body(),
        agentId: retiringBotId,
      });
      const draft = await inScope(() =>
        mandateRequestHandler(
          mandateGrant.input.parse({ ...body(), agentId: retiringBotId }),
          ctx(operatorUserId),
        ),
      );
      expect(active.status).toBe("active");
      expect(draft.status).toBe("draft");

      const out = await inScope(() =>
        agentRetireHandler(
          { agentId: retiringBotId, reason: "retirement test" },
          ctx(ownerUserId),
        ),
      );
      expect(out.revokedMandates).toBe(2);

      const rows = await withSystemDb((tx) =>
        tx
          .select({
            publicId: schema.mandates.publicId,
            status: schema.mandates.status,
            revokedReason: schema.mandates.revokedReason,
          })
          .from(schema.mandates)
          .where(inArray(schema.mandates.publicId, [active.id, draft.id])),
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("revoked");
        expect(row.revokedReason).toBe("retirement test");
      }

      // list_mandates and get_mandate keep reading the retired agent's
      // mandates; revoke_mandate on an already-revoked row is unchanged
      // (mandate_ended), not a new agent_retired refusal.
      const listed = await inScope(() =>
        mandateListHandler(
          { agentId: retiringBotId, limit: 10 },
          ctx(billingUserId),
        ),
      );
      expect(listed.items.map((m) => m.id).sort()).toEqual(
        [active.id, draft.id].sort(),
      );
      const got = await inScope(() =>
        mandateGetHandler(
          { mandateId: active.id, ledgerLimit: 100 },
          ctx(billingUserId),
        ),
      );
      expect(got.mandate.id).toBe(active.id);
      await expect(
        inScope(() =>
          mandateRevokeHandler(
            { mandateId: active.id, reason: "again" },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(conflict("mandate_ended"));

      // Creating or widening authority against the retired identity refuses.
      await expect(
        inScope(() =>
          mandateRequestHandler(
            mandateGrant.input.parse({ ...body(), agentId: retiringBotId }),
            ctx(operatorUserId),
          ),
        ),
      ).rejects.toSatisfy(retiredAgent);
      await expect(
        grant(billingUserId, { ...body(), agentId: retiringBotId }),
      ).rejects.toSatisfy(retiredAgent);
    });

    it("grant_mandate refuses to activate a draft whose agent retired after the request was made", async () => {
      const secondBotPrincipal = randomUUID();
      const [secondAgent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "second-retiree-bot",
            name: "Second retiring bot",
            agentType: "custom",
            principalId: secondBotPrincipal,
            createdById: operatorUserId,
          })
          .returning({ publicId: schema.agents.publicId }),
      );
      const secondAgentId = secondAgent!.publicId;

      const draft = await inScope(() =>
        mandateRequestHandler(
          mandateGrant.input.parse({ ...body(), agentId: secondAgentId }),
          ctx(operatorUserId),
        ),
      );
      await inScope(() =>
        agentRetireHandler(
          { agentId: secondAgentId, reason: "retired mid-draft" },
          ctx(ownerUserId),
        ),
      );
      await expect(
        grant(billingUserId, {
          ...body(),
          agentId: secondAgentId,
          requestId: draft.id,
        }),
      ).rejects.toSatisfy(retiredAgent);
    });

    it("grant and request wait on a retirement in flight, then refuse the agent it archived", async () => {
      // The race the row lock closes: without it, a grant reads the agent as
      // active, retirement commits around it and finishes its mandate scan,
      // and the grant then inserts an active mandate against a retired agent.
      // This transaction stands in for retire_agent between its FOR UPDATE
      // and its commit. If either handler stops locking the agent row, it
      // finishes while the lock is held and the "still pending" check fails.
      const racePrincipal = randomUUID();
      const [raceAgent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "racing-retiree-bot",
            name: "Racing retiring bot",
            agentType: "custom",
            principalId: racePrincipal,
            createdById: operatorUserId,
          })
          .returning({ publicId: schema.agents.publicId }),
      );
      const raceAgentId = raceAgent!.publicId;

      let granted: Promise<unknown> = Promise.resolve();
      let requested: Promise<unknown> = Promise.resolve();
      let settled = 0;
      await withSystemDb(async (tx) => {
        await tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(eq(schema.agents.publicId, raceAgentId))
          .for("update");
        granted = grant(billingUserId, { ...body(), agentId: raceAgentId });
        requested = inScope(() =>
          mandateRequestHandler(
            mandateGrant.input.parse({ ...body(), agentId: raceAgentId }),
            ctx(operatorUserId),
          ),
        );
        // Observe both without letting an early rejection go unhandled.
        for (const p of [granted, requested]) {
          p.then(
            () => settled++,
            () => settled++,
          );
        }
        await new Promise((r) => setTimeout(r, 300));
        expect(settled).toBe(0);
        await tx
          .update(schema.agents)
          .set({ status: "archived" })
          .where(eq(schema.agents.publicId, raceAgentId));
      });

      await expect(granted).rejects.toSatisfy(retiredAgent);
      await expect(requested).rejects.toSatisfy(retiredAgent);
      const [race] = await withSystemDb((tx) =>
        tx
          .select({ principalId: schema.agents.principalId })
          .from(schema.agents)
          .where(eq(schema.agents.publicId, raceAgentId)),
      );
      const rows = await withSystemDb((tx) =>
        tx
          .select({ id: schema.mandates.id })
          .from(schema.mandates)
          .where(eq(schema.mandates.agentPrincipalId, race!.principalId!)),
      );
      expect(rows).toHaveLength(0);
    });

    it("retire_agent leaves alone a draft that a concurrent grant rebound to another agent", async () => {
      // The race the re-read under the row lock closes: retire_agent selects
      // the retiring agent's live mandates, then locks each one. If a grant
      // activates one of those drafts for a different agent in between, the
      // locked row is active but no longer the retiring agent's, and
      // retirement must not revoke it. This transaction stands in for that
      // grant between its mandate row lock and its commit.
      const fromPrincipal = randomUUID();
      const toPrincipal = randomUUID();
      const [fromAgent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "rebound-from-bot",
            name: "Rebound from bot",
            agentType: "custom",
            principalId: fromPrincipal,
            createdById: operatorUserId,
          })
          .returning({ publicId: schema.agents.publicId }),
      );
      const fromAgentId = fromAgent!.publicId;
      const draft = await inScope(() =>
        mandateRequestHandler(
          mandateGrant.input.parse({ ...body(), agentId: fromAgentId }),
          ctx(operatorUserId),
        ),
      );

      let retired: Promise<{ revokedMandates: number }> | undefined;
      let settled = false;
      await withSystemDb(async (tx) => {
        await tx
          .select({ id: schema.mandates.id })
          .from(schema.mandates)
          .where(eq(schema.mandates.publicId, draft.id))
          .for("update");
        retired = inScope(() =>
          agentRetireHandler(
            { agentId: fromAgentId, reason: "retired during a rebind" },
            ctx(ownerUserId),
          ),
        );
        retired.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await new Promise((r) => setTimeout(r, 300));
        // retire_agent is parked on the mandate row lock this holds.
        expect(settled).toBe(false);
        await tx
          .update(schema.mandates)
          .set({
            agentPrincipalId: toPrincipal,
            status: "active",
            grantedBy: billingUserId,
            roleAtGrant: "Billing",
          })
          .where(eq(schema.mandates.publicId, draft.id));
      });

      const out = await retired!;
      expect(out.revokedMandates).toBe(0);
      const [row] = await withSystemDb((tx) =>
        tx
          .select({
            status: schema.mandates.status,
            agentPrincipalId: schema.mandates.agentPrincipalId,
          })
          .from(schema.mandates)
          .where(eq(schema.mandates.publicId, draft.id)),
      );
      expect(row).toEqual({ status: "active", agentPrincipalId: toPrincipal });
    });

    it("update_mandate_limits refuses to widen a mandate whose agent retired after it was granted", async () => {
      const thirdBotPrincipal = randomUUID();
      const [thirdAgent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "third-retiring-bot",
            name: "Third retiring bot",
            agentType: "custom",
            principalId: thirdBotPrincipal,
            createdById: operatorUserId,
          })
          .returning({ publicId: schema.agents.publicId }),
      );
      const thirdAgentId = thirdAgent!.publicId;

      const m = await grant(billingUserId, {
        ...body(),
        agentId: thirdAgentId,
      });
      // Flip the agent's status directly rather than through retire_agent:
      // that handler already revokes every live mandate as part of
      // retirement (proven above), so going through it here would only ever
      // exercise mandate_ended and never reach update_mandate_limits' own
      // check. This isolates that check for the state it defends —
      // an active mandate whose agent is archived by any means.
      await withSystemDb((tx) =>
        tx
          .update(schema.agents)
          .set({ status: "archived" })
          .where(eq(schema.agents.publicId, thirdAgentId)),
      );
      await expect(
        inScope(() =>
          mandateLimitsUpdateHandler(
            {
              mandateId: m.id,
              limitChanges: { amount: { perPeriod: "1" } },
            },
            ctx(billingUserId),
          ),
        ),
      ).rejects.toSatisfy(retiredAgent);
    });

    it("retire_agent on an already-archived agent revokes the mandates it still holds and leaves the retirement as recorded", async () => {
      // An agent archived before retirement revoked mandates (#3437), or by a
      // direct write, keeps its active mandates. A repeat retire_agent must
      // revoke them, not answer already with nothing revoked (#3446).
      const fourthBotPrincipal = randomUUID();
      const [fourthAgent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: "archived-bot",
            name: "Archived holder bot",
            agentType: "custom",
            principalId: fourthBotPrincipal,
            createdById: operatorUserId,
          })
          .returning({ publicId: schema.agents.publicId }),
      );
      const fourthAgentId = fourthAgent!.publicId;
      const m = await grant(billingUserId, {
        ...body(),
        agentId: fourthAgentId,
      });
      expect(m.status).toBe("active");

      const archivedAt = new Date("2026-01-02T03:04:05.000Z");
      await withSystemDb((tx) =>
        tx
          .update(schema.agents)
          .set({
            status: "archived",
            validUntil: archivedAt,
            updatedAt: archivedAt,
          })
          .where(eq(schema.agents.publicId, fourthAgentId)),
      );

      doubles.events.length = 0;
      const out = await inScope(() =>
        agentRetireHandler(
          { agentId: fourthAgentId, reason: "stranded mandate" },
          ctx(ownerUserId),
        ),
      );
      expect(out.revokedMandates).toBe(1);
      expect(out.revokedCredentials).toBe(0);
      expect(out.revokedHosts).toBe(0);
      expect(out.retiredAt).toBe(archivedAt.toISOString());
      expect(doubles.events).toEqual([
        { eventType: "mandate.revoked", capability: "retire_agent" },
      ]);

      const [row] = await withSystemDb((tx) =>
        tx
          .select({
            status: schema.mandates.status,
            revokedReason: schema.mandates.revokedReason,
          })
          .from(schema.mandates)
          .where(eq(schema.mandates.publicId, m.id)),
      );
      expect(row).toEqual({
        status: "revoked",
        revokedReason: "stranded mandate",
      });

      // The agent row keeps the recorded retirement.
      const [agentRow] = await withSystemDb((tx) =>
        tx
          .select({
            status: schema.agents.status,
            updatedAt: schema.agents.updatedAt,
          })
          .from(schema.agents)
          .where(eq(schema.agents.publicId, fourthAgentId)),
      );
      expect(agentRow).toEqual({ status: "archived", updatedAt: archivedAt });

      // A third call finds nothing left to revoke and emits nothing.
      doubles.events.length = 0;
      const again = await inScope(() =>
        agentRetireHandler({ agentId: fourthAgentId }, ctx(ownerUserId)),
      );
      expect(again.revokedMandates).toBe(0);
      expect(doubles.events).toEqual([]);
    });
  },
);
