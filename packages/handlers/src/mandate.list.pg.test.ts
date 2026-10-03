/**
 * `list_mandates` against Postgres, for two defects of the same read (#3130,
 * absorbing #3152 and #3450). Runs in the CI Postgres job and locally with
 * DATABASE_URL set; skipped otherwise.
 *
 *   one instant — every row of an answer is counted at the instant the
 *     answer returns as `asOf`. The read used to ask the clock once per row,
 *     so two rows read on either side of a UTC period boundary sat in two
 *     periods in one answer. The page test is two rows at an instant one
 *     millisecond before a month ends: each row's period key is the one that
 *     instant names. Put the per-row clock read back and both keys are
 *     today's, and the test fails.
 *   fleet size — a narrowed reader's read costs the same statements and the
 *     same bind parameters with two agents in the workspace as with three
 *     hundred. It used to select every live agent and send the list back as
 *     parameters, so the cost grew with the fleet whatever the page asked.
 *
 * The role gate is the same double `mandate.handlers.pg.test.ts` uses.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";

const doubles = vi.hoisted(() => ({
  roles: new Map<string, { org: string | null; workspace: string | null }>(),
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

describe.skipIf(!process.env.DATABASE_URL)(
  "list_mandates against Postgres",
  async () => {
    const { schema, withSystemDb, withTenantDb } = await import(
      "@oxagen/database"
    );
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq, inArray } = await import("drizzle-orm");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { periodKey } = await import("@oxagen/rules");
    const { mandateListHandler } = await import("./mandate.list");
    const { mapMandates } = await import("./_mandate");

    const tag = Date.now().toString(36).slice(-6);
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const officeUserId = randomUUID();
    const readerUserId = randomUUID();
    const otherUserId = randomUUID();
    const ownPrincipal = randomUUID();
    const otherPrincipal = randomUUID();
    let ownAgentId = "";
    let otherAgentId = "";
    let dailyMandate = "";
    let monthlyMandate = "";
    let requestedDraft = "";

    const ctx = (userId: string): CapabilityContext => ({
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

    /** One mandate row on `agent`; returns its public id. */
    async function insertMandate(
      agent: string,
      overrides: Partial<typeof schema.mandates.$inferInsert> = {},
    ): Promise<string> {
      const [row] = await withSystemDb((tx) =>
        tx
          .insert(schema.mandates)
          .values({
            orgId,
            workspaceId,
            agentPrincipalId: agent,
            grantedBy: officeUserId,
            roleAtGrant: "Billing",
            impacts: ["moves_money"],
            limits: {
              amount: {
                perPeriod: "2000000000",
                period: "monthly",
                currencyOrUnit: "USD",
                kind: "money",
              },
            },
            targets: {},
            tools: ["stripe__create_payment@*"],
            approvalRules: {
              humanAbove: {},
              alwaysHumanFor: [],
              approvers: [],
            },
            purpose: "test",
            validFrom: new Date("2020-01-01T00:00:00Z"),
            validTo: new Date("2099-12-31T00:00:00Z"),
            status: "active",
            ...overrides,
          })
          .returning({ publicId: schema.mandates.publicId }),
      );
      return row!.publicId;
    }

    /** Agents created by someone other than the reader, to grow the fleet. */
    async function addFleet(count: number, offset: number): Promise<void> {
      await withSystemDb((tx) =>
        tx.insert(schema.agents).values(
          Array.from({ length: count }, (_, i) => ({
            orgId,
            workspaceId,
            // Agent slugs are capped at 18 characters
            // (agent.enforce_agent_slug_length()).
            slug: `f${offset + i}-${tag}`,
            name: `Fleet ${offset + i}`,
            agentType: "custom",
            principalId: randomUUID(),
            createdById: otherUserId,
          })),
        ),
      );
    }

    beforeAll(async () => {
      doubles.roles.set(officeUserId, { org: "Billing", workspace: null });
      doubles.roles.set(readerUserId, { org: null, workspace: "Member" });
      await withSystemDb(async (tx) => {
        await tx.insert(schema.workspaces).values({
          id: workspaceId,
          orgId,
          name: "Ledger",
          slug: `ledger-${tag}`,
          namespace: `ldg${tag}`.slice(0, 6),
        });
        const [own] = await tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: `own-${tag}`,
            name: "Own bot",
            agentType: "custom",
            principalId: ownPrincipal,
            createdById: readerUserId,
          })
          .returning({ publicId: schema.agents.publicId });
        ownAgentId = own!.publicId;
        const [other] = await tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId,
            slug: `other-${tag}`,
            name: "Other bot",
            agentType: "custom",
            principalId: otherPrincipal,
            createdById: otherUserId,
          })
          .returning({ publicId: schema.agents.publicId });
        otherAgentId = other!.publicId;
      });
      dailyMandate = await insertMandate(ownPrincipal, {
        limits: {
          calls: {
            perPeriod: "50",
            period: "daily",
            currencyOrUnit: "calls",
            kind: "count",
          },
        },
      });
      monthlyMandate = await insertMandate(ownPrincipal);
      // The reader asked for this one on an agent they did not create, so
      // only the requester grant admits it (ADR-107).
      requestedDraft = await insertMandate(otherPrincipal, {
        status: "draft",
        requestedBy: readerUserId,
        grantedBy: null,
        roleAtGrant: null,
      });
      // Granted to the other agent and not requested by the reader, so the
      // reader never sees it.
      await insertMandate(otherPrincipal);
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.mandates)
          .where(eq(schema.mandates.workspaceId, workspaceId));
        await tx
          .delete(schema.agents)
          .where(eq(schema.agents.workspaceId, workspaceId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId));
      });
    });

    // ── one instant ──────────────────────────────────────────────────────────

    it("counts every row of a page at the one instant it is given", async () => {
      // One millisecond before January ends: a clock read a moment later is
      // in February, and a clock read today is in neither.
      const at = new Date("2020-01-31T23:59:59.999Z");
      const out = await inScope(() =>
        withTenantDb(async (tx) => {
          const rows = await tx
            .select()
            .from(schema.mandates)
            .where(
              inArray(schema.mandates.publicId, [dailyMandate, monthlyMandate]),
            );
          return mapMandates(tx, workspaceId, rows, at);
        }),
      );
      expect(
        out
          .flatMap((m) => m.authority.map((a) => [a.measure, a.periodKey]))
          .sort(),
      ).toEqual([
        ["amount", "2020-01"],
        ["calls", "2020-01-31"],
      ]);
    });

    it("returns the instant it counted every row at", async () => {
      const out = await inScope(() =>
        mandateListHandler({ limit: 50 }, ctx(officeUserId)),
      );
      expect(out.asOf).toBeDefined();
      const asOf = new Date(out.asOf);
      expect(Number.isNaN(asOf.getTime())).toBe(false);
      const authority = out.items.flatMap((m) => m.authority);
      expect(authority.length).toBeGreaterThanOrEqual(2);
      for (const a of authority) {
        expect(a.periodKey).toBe(periodKey(a.period, asOf));
      }
    });

    it("returns the instant when the agent it names is not there", async () => {
      const out = await inScope(() =>
        mandateListHandler(
          { limit: 50, agentId: "agt_0123456789abcdefghjkmn" },
          ctx(officeUserId),
        ),
      );
      expect(out.items).toEqual([]);
      expect(Number.isNaN(Date.parse(out.asOf))).toBe(false);
    });

    // ── fleet size ───────────────────────────────────────────────────────────

    /**
     * The reader's answer, and every statement it sent to the tables the read
     * touches. Each statement is compiled through the dialect first, so a spy
     * there sees every one with its parameters. The role and tier checks
     * `readerFilter` runs read other tables and are left out.
     */
    async function measured(input: { limit: number; agentId?: string }) {
      const compiled = vi.spyOn(PgDialect.prototype, "sqlToQuery");
      const out = await inScope(() =>
        mandateListHandler(input, ctx(readerUserId)),
      );
      const statements = compiled.mock.results
        .map((r) => r.value as { sql: string; params: unknown[] })
        .filter((q) => /"(mandates|agents|mandate_ledger|users)"/.test(q.sql))
        .map((q) => ({ sql: q.sql, params: q.params.length }));
      compiled.mockRestore();
      return { ids: out.items.map((m) => m.id).sort(), statements };
    }

    it("costs a narrowed reader the same with three hundred agents as with two", async () => {
      // Warm once, so a cache in the role or tier checks cannot change what
      // the two measured reads send.
      await measured({ limit: 50 });
      const small = await measured({ limit: 50 });
      const smallOne = await measured({ limit: 50, agentId: otherAgentId });
      await addFleet(300, 0);
      const large = await measured({ limit: 50 });
      const largeOne = await measured({ limit: 50, agentId: otherAgentId });

      // What the reader sees: the mandates of the agent they created, and the
      // draft they requested of someone else's.
      const expected = [dailyMandate, monthlyMandate, requestedDraft].sort();
      expect(small.ids).toEqual(expected);
      expect(large.ids).toEqual(expected);
      expect(smallOne.ids).toEqual([requestedDraft]);
      expect(largeOne.ids).toEqual([requestedDraft]);

      // The spy saw the read at all: a spy on a copy of drizzle the package
      // does not use would count nothing and pass the comparisons below.
      expect(
        small.statements.some((q) => q.sql.includes('"mandates"')),
      ).toBe(true);

      // The same statements with the same parameter counts. Three hundred
      // agents more add nothing to either read.
      expect(large.statements).toEqual(small.statements);
      expect(largeOne.statements).toEqual(smallOne.statements);
      // The bound stated in the pull request: the mandate rows, then the
      // users, the agents and the ledger sums they name, and the agent the
      // request names when it names one.
      expect(small.statements.length).toBeLessThanOrEqual(4);
      expect(smallOne.statements.length).toBeLessThanOrEqual(5);
    });

    it("reads one agent, not the fleet, when the request names one", async () => {
      const one = await measured({ limit: 50, agentId: ownAgentId });
      expect(one.ids).toEqual([dailyMandate, monthlyMandate].sort());
      // No statement selects agents by workspace alone: the agent lookup
      // names the agent, and the mapping names the rows' principals.
      for (const q of one.statements.filter((s) =>
        s.sql.includes('"agents"'),
      )) {
        expect(q.sql).toMatch(/"public_id" = \$\d+|"principal_id" in \(/);
      }
    });
  },
);
