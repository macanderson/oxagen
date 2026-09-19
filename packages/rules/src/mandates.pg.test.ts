/**
 * The mandate ledger and the decision-time check against Postgres (ADR-059
 * decisions 4 and 5; issue #2957 §8). Runs in the CI Postgres job and
 * locally with DATABASE_URL set; skipped otherwise.
 *
 * What is asserted:
 *   - a reservation is refused when the value exceeds per_call, and when it
 *     exceeds the period's remaining authority; a refusal writes nothing
 *   - 20 concurrent reserves against a period that fits 19 leave exactly one
 *     over_limit refusal, and the ledger's last balance_after is per_period
 *     minus 19 values with every balance distinct (the row lock serialised)
 *   - settle converts the reservation, records external_effect_id and leaves
 *     remaining unchanged; release gives the value back; both are idempotent
 *   - a new period starts from per_period again (period_key rollover)
 *   - a measure limited per call only never runs out of period authority:
 *     every reserve in one period is ok and its rows carry balance 0
 *   - a per_period changed inside a period binds the next reservation and
 *     what readAuthority reports: lowered under what is drawn → the next
 *     reserve is over_limit and remaining reads 0; raised → the room opens
 *   - the check: no covering mandate → no_mandate; a target outside the allow
 *     list → target_denied; a measure the version does not declare →
 *     measure_unreadable; a measure whose currently declared kind disagrees
 *     with the kind its limit was stamped with → measure_kind_changed; a
 *     value over human_above parks the call with a
 *     reservation held and an approval row carrying mandate_id, tool_call_id,
 *     rule_ids and input_digest; the same call after approval proceeds on
 *     the held reservation and marks the approval used, once; the settlement
 *     closure settles with the effect id read from the output
 *   - a capability that is no declared tool, or a tool with no consequence
 *     tag, yields no opinion and writes nothing
 *   - an approval past its window: expireApproval releases what the call
 *     holds and resolves the row expired, once; a retry of the same input
 *     after the window voids the lapsed row and parks afresh on one
 *     reservation, so the period holds no more than the open call
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(!process.env.DATABASE_URL)(
  "mandates against Postgres",
  async () => {
    const { isUniqueViolation, schema, withSystemDb, withTenantDb } =
      await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq, inArray } = await import("drizzle-orm");
    const {
      checkMandate,
      decideMandate,
      expireApproval,
      lockMandate,
      MANDATE_APPROVAL_TTL_MS,
      parseMandateRow,
      readAuthority,
      release,
      releaseParked,
      reserve,
      settle,
    } = await import("./mandates");
    const { periodKey } = await import("./mandates/measures");

    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const toolId = randomUUID();
    const versionId = randomUUID();
    const plainToolId = randomUUID();
    const plainVersionId = randomUUID();
    // One person who may resolve an approval in this org, seeded for real so
    // the mandate gate's `approval.requested` fan-out has somebody to reach.
    // Without it the fan-out writes nothing and a test asserting it would
    // pass on an empty result — which is the shape of the bug it guards.
    const approverUserId = randomUUID();
    const approverPrincipalId = randomUUID();
    const approverRoleId = randomUUID();
    const NOW = new Date("2026-09-14T12:00:00Z");
    const NEXT_MONTH = new Date("2026-10-02T12:00:00Z");
    const mandateIds: string[] = [];

    const inScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope({ orgId, workspaceId }, fn);
    const decide = (args: Parameters<typeof decideMandate>[0]) =>
      inScope(() => decideMandate(args));
    const check = (args: Parameters<typeof checkMandate>[0]) =>
      inScope(() => checkMandate(args));

    /** One active mandate for the payment tool, bound to `agent`; returns its uuid. */
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
            grantedBy: randomUUID(),
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
            approvalRules: {
              humanAbove: {},
              alwaysHumanFor: [],
              approvers: [],
            },
            purpose: "test",
            validFrom: new Date("2026-09-01T00:00:00Z"),
            validTo: new Date("2026-12-31T23:59:59Z"),
            status: "active",
            ...overrides,
          })
          .returning({ id: schema.mandates.id }),
      );
      mandateIds.push(row!.id);
      return row!.id;
    }

    const loadMandate = (id: string) =>
      withSystemDb(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.mandates)
          .where(eq(schema.mandates.id, id));
        return parseMandateRow(row!);
      });

    const notificationsForOrg = () =>
      withSystemDb((tx) =>
        tx
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.orgId, orgId)),
      );

    const ledgerOf = (mandateId: string) =>
      withSystemDb((tx) =>
        tx
          .select()
          .from(schema.mandateLedger)
          .where(eq(schema.mandateLedger.mandateId, mandateId))
          .orderBy(schema.mandateLedger.createdAt),
      );

    /** Each test binds its mandates to its own agent, so the covering-mandate lookup sees only its rows. */
    const checkArgs = (
      agent: string,
      input: unknown,
      extra: Record<string, unknown> = {},
    ) => ({
      capability: "stripe__create_payment",
      input,
      orgId,
      workspaceId,
      agentPrincipalId: agent,
      userId: null,
      now: () => NOW,
      ...extra,
    });

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        for (const [id, vid, slug, tags, measures] of [
          [
            toolId,
            versionId,
            "stripe__create_payment",
            ["moves_money"],
            {
              amount: {
                path: "amount.value",
                type: "amount",
                unit: "USD",
                scale: 2,
              },
              counterparty: { path: "vendor", type: "text", unit: "vendor" },
            },
          ],
          [plainToolId, plainVersionId, "read_file", [], {}],
        ] as const) {
          await tx.insert(schema.tools).values({
            id,
            orgId,
            workspaceId,
            name: slug,
            slug,
            source: "custom",
            enabled: true,
          });
          await tx.insert(schema.toolVersions).values({
            id: vid,
            orgId,
            workspaceId,
            toolId: id,
            versionNumber: 2,
            isLatest: true,
            inputSchema: {},
            riskGrade: "high",
            manifest: {},
            checksum: "0".repeat(64),
            consequenceTags: [...tags],
            measures,
            effectIdPath: "payment.id",
          });
          await tx
            .update(schema.tools)
            .set({ activeVersionId: vid })
            .where(eq(schema.tools.id, id));
        }
        // An org-scoped Owner — one of the roles `resolve_approval` admits —
        // held by an active human principal.
        await tx.insert(schema.roles).values({
          id: approverRoleId,
          orgId,
          scopeKind: "org",
          name: "Owner",
          isSystemDefault: true,
        });
        await tx.insert(schema.principals).values({
          id: approverPrincipalId,
          orgId,
          kind: "human",
          displayName: "Approver",
          status: "active",
          parentUserId: approverUserId,
        });
        await tx.insert(schema.principalRoleAssignments).values({
          principalId: approverPrincipalId,
          roleId: approverRoleId,
          orgId,
          workspaceId: null,
        });
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        if (mandateIds.length > 0) {
          await tx
            .delete(schema.approvalRequests)
            .where(inArray(schema.approvalRequests.mandateId, mandateIds));
          await tx
            .delete(schema.mandateLedger)
            .where(inArray(schema.mandateLedger.mandateId, mandateIds));
          await tx
            .delete(schema.mandates)
            .where(inArray(schema.mandates.id, mandateIds));
        }
        await tx
          .delete(schema.tools)
          .where(eq(schema.tools.workspaceId, workspaceId));
        await tx
          .delete(schema.toolVersions)
          .where(eq(schema.toolVersions.workspaceId, workspaceId));
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

    // ── the ledger ─────────────────────────────────────────────────────────────

    it("refuses a reservation over per_call and over the period's remaining authority, writing nothing", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent);
      const mandate = await loadMandate(id);
      const over = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          return reserve(tx, {
            mandate,
            toolCallId: randomUUID(),
            values: { amount: "250000001" },
            at: NOW,
          });
        }),
      );
      expect(over).toMatchObject({
        ok: false,
        reason: "over_limit",
        measure: "amount",
      });

      // Eight calls of 250 fit exactly under 2000; a ninth does not.
      for (let i = 0; i < 8; i++) {
        const r = await inScope(() =>
          withTenantDb(async (tx) => {
            await lockMandate(tx, id);
            return reserve(tx, {
              mandate,
              toolCallId: randomUUID(),
              values: { amount: "250000000" },
              at: NOW,
            });
          }),
        );
        expect(r.ok).toBe(true);
      }
      const ninth = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          return reserve(tx, {
            mandate,
            toolCallId: randomUUID(),
            values: { amount: "1" },
            at: NOW,
          });
        }),
      );
      expect(ninth).toMatchObject({ ok: false, reason: "over_limit" });
      const rows = await ledgerOf(id);
      expect(rows).toHaveLength(8);
      expect(rows.at(-1)!.balanceAfter).toBe("0");
      const [authority] = await inScope(() =>
        withTenantDb((tx) => readAuthority(tx, mandate, NOW)),
      );
      expect(authority).toMatchObject({
        measure: "amount",
        periodKey: "2026-09",
        remaining: "0",
        reserved: "2000000000",
        settled: "0",
      });
    });

    it("20 concurrent reserves against a period that fits 19 leave one refusal and a serialised balance trail", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent, {
        limits: {
          amount: {
            perPeriod: "1900000000",
            period: "monthly",
            currencyOrUnit: "USD",
          },
        },
      });
      const mandate = await loadMandate(id);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          inScope(() =>
            withTenantDb(async (tx) => {
              await lockMandate(tx, id);
              return reserve(tx, {
                mandate,
                toolCallId: randomUUID(),
                values: { amount: "100000000" },
                at: NOW,
              });
            }),
          ),
        ),
      );
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
      const rows = await ledgerOf(id);
      expect(rows).toHaveLength(19);
      const balances = rows.map((r) => BigInt(r.balanceAfter));
      expect(new Set(balances.map(String)).size).toBe(19);
      expect(rows.at(-1)!.balanceAfter).toBe("0");
      // Each row lowers the balance by exactly one value from the one before.
      const sorted = [...balances].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i - 1]! - sorted[i]!).toBe(100000000n);
      }
    });

    it("settle records the effect id and leaves remaining unchanged; release gives the value back; both are idempotent", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent);
      const mandate = await loadMandate(id);
      const settledCall = randomUUID();
      const releasedCall = randomUUID();
      await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          for (const toolCallId of [settledCall, releasedCall]) {
            await reserve(tx, {
              mandate,
              toolCallId,
              values: { amount: "250000000" },
              at: NOW,
            });
          }
        }),
      );
      const settled = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          const n = await settle(tx, {
            mandate,
            toolCallId: settledCall,
            externalEffectId: "pi_3Q",
          });
          const again = await settle(tx, {
            mandate,
            toolCallId: settledCall,
            externalEffectId: "pi_3Q",
          });
          return { n, again };
        }),
      );
      expect(settled).toEqual({ n: 1, again: 0 });
      const released = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          const n = await release(tx, { mandate, toolCallId: releasedCall });
          const again = await release(tx, {
            mandate,
            toolCallId: releasedCall,
          });
          return { n, again };
        }),
      );
      expect(released).toEqual({ n: 1, again: 0 });

      const rows = await ledgerOf(id);
      const settleRow = rows.find((r) => r.kind === "settle")!;
      expect(settleRow.toolCallId).toBe(settledCall);
      expect(settleRow.externalEffectId).toBe("pi_3Q");
      expect(settleRow.value).toBe("250000000");
      expect(rows.filter((r) => r.kind === "release")).toHaveLength(1);
      // Every row `reserve` and `closeReservations` wrote carries the
      // mandate's resolved kind for "amount" (ADR-108): the reserve stamps
      // it from `mandate.limits`, and settle/release carry the reserve row's
      // own stamp forward rather than re-deriving it, so all four rows agree.
      expect(rows.every((r) => r.measureKind === "money")).toBe(true);
      const [authority] = await inScope(() =>
        withTenantDb((tx) => readAuthority(tx, mandate, NOW)),
      );
      // 2000 - 250 (settled) = 1750 remaining; the released 250 came back.
      expect(authority).toMatchObject({
        remaining: "1750000000",
        settled: "250000000",
        reserved: "0",
      });
    });

    it("a new period starts from per_period again", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent);
      const mandate = await loadMandate(id);
      await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          await reserve(tx, {
            mandate,
            toolCallId: randomUUID(),
            values: { amount: "250000000" },
            at: NOW,
          });
        }),
      );
      const next = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          await reserve(tx, {
            mandate,
            toolCallId: randomUUID(),
            values: { amount: "250000000" },
            at: NEXT_MONTH,
          });
          return readAuthority(tx, mandate, NEXT_MONTH);
        }),
      );
      expect(next[0]).toMatchObject({
        periodKey: periodKey("monthly", NEXT_MONTH),
        remaining: "1750000000",
      });
      const rows = await ledgerOf(id);
      expect(rows.map((r) => r.periodKey).sort()).toEqual([
        "2026-09",
        "2026-10",
      ]);
    });

    it("a measure limited per call only never runs out of period authority", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent, {
        limits: {
          amount: {
            perCall: "250000000",
            period: "daily",
            currencyOrUnit: "USD",
          },
        },
      });
      const mandate = await loadMandate(id);
      for (let i = 0; i < 3; i++) {
        const r = await inScope(() =>
          withTenantDb(async (tx) => {
            await lockMandate(tx, id);
            return reserve(tx, {
              mandate,
              toolCallId: randomUUID(),
              values: { amount: "1000000" },
              at: NOW,
            });
          }),
        );
        expect(r).toEqual({ ok: true });
      }
      const rows = await ledgerOf(id);
      expect(rows.map((r) => r.balanceAfter)).toEqual(["0", "0", "0"]);
      const released = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          return release(tx, { mandate, toolCallId: rows[0]!.toolCallId });
        }),
      );
      expect(released).toBe(1);
      expect((await ledgerOf(id)).at(-1)!.balanceAfter).toBe("0");
      const [authority] = await inScope(() =>
        withTenantDb((tx) => readAuthority(tx, mandate, NOW)),
      );
      expect(authority).toMatchObject({
        perPeriod: null,
        remaining: null,
        reserved: "2000000",
      });
    });

    it("a per_period changed inside a period binds the next reservation and the reported remaining", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent);
      const limit = (perPeriod: string) => ({
        amount: {
          perCall: "250000000",
          perPeriod,
          period: "monthly" as const,
          currencyOrUnit: "USD",
        },
      });
      const reserveUnder = (
        mandate: Awaited<ReturnType<typeof loadMandate>>,
        value: string,
      ) =>
        inScope(() =>
          withTenantDb(async (tx) => {
            await lockMandate(tx, id);
            return reserve(tx, {
              mandate,
              toolCallId: randomUUID(),
              values: { amount: value },
              at: NOW,
            });
          }),
        );
      const setPerPeriod = async (perPeriod: string) => {
        await withSystemDb((tx) =>
          tx
            .update(schema.mandates)
            .set({ limits: limit(perPeriod) })
            .where(eq(schema.mandates.id, id)),
        );
        return loadMandate(id);
      };
      // 1000 of 2000 drawn.
      const original = await loadMandate(id);
      for (let i = 0; i < 4; i++) {
        expect((await reserveUnder(original, "250000000")).ok).toBe(true);
      }
      // Lowered under what is drawn: nothing more fits and remaining reads 0.
      const lowered = await setPerPeriod("500000000");
      expect(await reserveUnder(lowered, "1")).toMatchObject({
        ok: false,
        reason: "over_limit",
        detail: "1 exceeds remaining 0 USD this monthly period",
      });
      let [authority] = await inScope(() =>
        withTenantDb((tx) => readAuthority(tx, lowered, NOW)),
      );
      expect(authority).toMatchObject({
        remaining: "0",
        reserved: "1000000000",
      });
      // Raised: the next reservation reads the new ceiling.
      const raised = await setPerPeriod("5000000000");
      expect(await reserveUnder(raised, "250000000")).toEqual({ ok: true });
      [authority] = await inScope(() =>
        withTenantDb((tx) => readAuthority(tx, raised, NOW)),
      );
      expect(authority).toMatchObject({
        remaining: "3750000000",
        reserved: "1250000000",
      });
      expect((await ledgerOf(id)).at(-1)!.balanceAfter).toBe("3750000000");
    });

    // ── the check ──────────────────────────────────────────────────────────────

    it("has no opinion on a capability that is no declared tool, or a tool with no consequence tag", async () => {
      const agent = randomUUID();
      await expect(
        decide(checkArgs(agent, {}, { capability: "create_workspace" })),
      ).resolves.toEqual({ kind: "no_opinion" });
      await expect(
        decide(checkArgs(agent, {}, { capability: "read_file" })),
      ).resolves.toEqual({
        kind: "no_opinion",
      });
    });

    it("denies a tagged call with no covering mandate before any reservation", async () => {
      const agent = randomUUID();
      const out = await decide(checkArgs(agent, { amount: { value: "10" } }));
      expect(out).toMatchObject({ kind: "deny", reason: "no_mandate" });
      await expect(
        check(checkArgs(agent, { amount: { value: "10" } })),
      ).rejects.toMatchObject({
        code: "forbidden",
        reason: "no_mandate",
      });
    });

    it("denies a target outside the allow list, and a limit over a measure the version does not declare", async () => {
      const agent = randomUUID();
      const targeted = await insertMandate(agent, {
        targets: { counterparty: { allow: ["vendor:aws"], deny: ["*"] } },
      });
      const denied = await decide(
        checkArgs(agent, { amount: { value: "10" }, vendor: "vendor:evil" }),
      );
      expect(denied).toMatchObject({ kind: "deny", reason: "target_denied" });
      expect(await ledgerOf(targeted)).toHaveLength(0);
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({ status: "revoked" })
          .where(eq(schema.mandates.id, targeted)),
      );

      const undeclared = await insertMandate(agent, {
        limits: {
          rows: { perCall: "5", period: "daily", currencyOrUnit: "rows" },
        },
      });
      const out = await decide(checkArgs(agent, { amount: { value: "10" } }));
      expect(out).toMatchObject({ kind: "deny", reason: "measure_unreadable" });
      expect(await ledgerOf(undeclared)).toHaveLength(0);
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({ status: "revoked" })
          .where(eq(schema.mandates.id, undeclared)),
      );
    });

    // #3130 (ADR-108): an unpinned mandate pattern can still match a tool
    // version published after the mandate's limit was written. If that
    // version now declares the same measure with a different kind (count
    // vs. amount) under the same unit spelling, enforcing against a figure
    // entered under the old kind would be nonsense; this refuses the call
    // instead, the same way two matched tools disagreeing at write time
    // already refuses (measure_kind_conflict).
    it("denies a call whose measure's declared kind no longer matches the kind its limit was stamped with", async () => {
      const agent = randomUUID();
      const stale = await insertMandate(agent, {
        limits: {
          amount: {
            perCall: "250000000",
            perPeriod: "2000000000",
            period: "monthly",
            currencyOrUnit: "USD",
            kind: "count",
          },
        },
      });
      const out = await decide(
        checkArgs(agent, { amount: { value: "10" }, vendor: "vendor:aws" }),
      );
      expect(out).toMatchObject({
        kind: "deny",
        reason: "measure_kind_changed",
      });
      expect(await ledgerOf(stale)).toHaveLength(0);
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({ status: "revoked" })
          .where(eq(schema.mandates.id, stale)),
      );
    });

    // A legacy row's kind is `legacyMeasureKindGuess`'s fallback, not a
    // fact: the gate has always enforced it correctly by reading the
    // declaration directly, so the drift check above must never compare a
    // guess to the current declaration. Here the guess (from a non-currency
    // unit, "widgets") disagrees with the declared "amount"/money kind on
    // purpose, and the call still proceeds.
    it("does not deny a legacy row whose guessed kind disagrees with the declaration", async () => {
      const agent = randomUUID();
      const legacy = await insertMandate(agent, {
        limits: {
          amount: {
            perCall: "250000000",
            perPeriod: "2000000000",
            period: "monthly",
            currencyOrUnit: "widgets",
            // No `kind`: parseMandateRow guesses "count" from "widgets" (not
            // an ISO currency code), which disagrees with the tool's
            // declared "amount" (money).
          },
        },
      });
      const out = await decide(
        checkArgs(agent, { amount: { value: "10" }, vendor: "vendor:aws" }),
      );
      expect(out.kind).not.toBe("deny");
      await withSystemDb((tx) =>
        tx
          .update(schema.mandates)
          .set({ status: "revoked" })
          .where(eq(schema.mandates.id, legacy)),
      );
    });

    it("parks a call over human_above with the reservation held, then lets the approved retry proceed once and settles it from the output", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent, {
        approvalRules: {
          humanAbove: { amount: "100000000" },
          alwaysHumanFor: [],
          approvers: [],
        },
      });
      const input = { amount: { value: "150.00" }, vendor: "vendor:aws" };
      // Counted before, not asserted as a total: other cases in this file park
      // approvals against the same org, so a fixed expected count would make
      // this pass or fail on test order rather than on the fan-out.
      const feedBefore = await notificationsForOrg();

      const parked = await decide(checkArgs(agent, input, { userId: null }));
      expect(parked.kind).toBe("pending");
      const rows = await ledgerOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "reserve", value: "150000000" });
      const [approval] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.mandateId, id)),
      );
      expect(approval).toMatchObject({
        toolCallId: rows[0]!.toolCallId,
        capabilityName: "stripe__create_payment",
        riskLevel: "high",
        ruleIds: [
          expect.stringMatching(/^mandate:mnd_[0-9a-z]+:human_above:amount$/),
        ],
        messageId: null,
      });
      expect(approval!.inputDigest).toMatch(/^[0-9a-f]{64}$/);

      // MC spec §7.7. A mandate parks a call precisely because a rule decided
      // a person must see it, so the approval and the feed row that tells
      // somebody about it are written together. The fan-out used to live
      // inside the runtime's createApprovalRequest, which this path does not
      // call — so these approvals notified nobody and could only expire,
      // which reads in the record exactly like a considered refusal.
      const feedAfter = await notificationsForOrg();
      const notified = feedAfter.filter(
        (n) => !feedBefore.some((b) => b.id === n.id),
      );
      // Exactly one: the org has exactly one person who may resolve it, and a
      // second row would mean the same card twice in their feed.
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatchObject({
        userId: approverUserId,
        workspaceId,
        kind: "approval",
        event: "approval.requested",
        title: "Approval requested: stripe__create_payment",
      });
      // The risk and the window are what the card has to show to be actable.
      expect(notified[0]!.body).toContain("Risk high");
      expect(notified[0]!.body).toContain(
        new Date(NOW.getTime() + MANDATE_APPROVAL_TTL_MS).toISOString(),
      );
      // Retried while a person has not looked: the same row, the same held
      // reservation, no more authority drawn.
      await expect(check(checkArgs(agent, input))).rejects.toMatchObject({
        code: "pending_approval",
        accessRequestId: approval!.publicId,
      });
      expect(await ledgerOf(id)).toHaveLength(1);

      // A person approves; the retry of the same input rides the held reservation.
      await withSystemDb((tx) =>
        tx
          .update(schema.approvalRequests)
          .set({ resolution: "approved", resolvedAt: NOW })
          .where(eq(schema.approvalRequests.id, approval!.id)),
      );
      const settlement = await check(checkArgs(agent, input));
      expect(settlement).toBeDefined();
      const [used] = await withSystemDb((tx) =>
        tx
          .select({ tokenUsedAt: schema.approvalRequests.tokenUsedAt })
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.id, approval!.id)),
      );
      expect(used!.tokenUsedAt).not.toBeNull();
      // Still one reservation: the retry rode the held one.
      expect(await ledgerOf(id)).toHaveLength(1);

      await inScope(() => settlement!.settle({ payment: { id: "pi_held" } }));
      const after = await ledgerOf(id);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({
        kind: "settle",
        externalEffectId: "pi_held",
        value: "150000000",
      });

      // The approval is single-use: the same call again parks a new row.
      const again = await decide(checkArgs(agent, input));
      expect(again.kind).toBe("pending");
    });

    it("lets a call under the rule proceed on a fresh reservation and releases it when the handler fails", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent);
      const settlement = await check(
        checkArgs(agent, { amount: { value: "20.00" } }),
      );
      expect(settlement).toBeDefined();
      let rows = await ledgerOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "reserve",
        value: "20000000",
        balanceAfter: "1980000000",
      });
      await inScope(() => settlement!.release());
      rows = await ledgerOf(id);
      expect(rows[1]).toMatchObject({
        kind: "release",
        value: "20000000",
        balanceAfter: "2000000000",
      });
    });

    it("releaseParked gives back what parked calls hold and nothing else", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent, {
        approvalRules: {
          humanAbove: { amount: "1" },
          alwaysHumanFor: [],
          approvers: [],
        },
      });
      await decide(checkArgs(agent, { amount: { value: "30.00" } }));
      const mandate = await loadMandate(id);
      const n = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          const first = await releaseParked(tx, mandate);
          const second = await releaseParked(tx, mandate);
          return { first, second };
        }),
      );
      expect(n).toEqual({ first: 1, second: 0 });
      const rows = await ledgerOf(id);
      expect(rows.map((r) => r.kind)).toEqual(["reserve", "release"]);
      expect(rows[1]!.balanceAfter).toBe("2000000000");
    });

    it("an approval past its window gives back what it holds, once; a retry after the window parks afresh on one reservation", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent, {
        approvalRules: {
          humanAbove: { amount: "1" },
          alwaysHumanFor: [],
          approvers: [],
        },
      });
      const mandate = await loadMandate(id);
      const input = { amount: { value: "30.00" } };
      const parked = await decide(checkArgs(agent, input));
      expect(parked.kind).toBe("pending");
      const [approval] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.mandateId, id)),
      );
      expect(approval!.expiresAt.getTime()).toBe(
        NOW.getTime() + MANDATE_APPROVAL_TTL_MS,
      );
      const AFTER = new Date(NOW.getTime() + MANDATE_APPROVAL_TTL_MS + 1);

      // The sweep's unit of work.
      const n = await inScope(() =>
        withTenantDb(async (tx) => {
          await lockMandate(tx, id);
          const first = await expireApproval(tx, mandate, approval!, AFTER);
          const second = await expireApproval(tx, mandate, approval!, AFTER);
          return { first, second };
        }),
      );
      expect(n).toEqual({ first: 1, second: 0 });
      const [voided] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.id, approval!.id)),
      );
      expect(voided).toMatchObject({
        resolution: "expired",
        resolvedAt: AFTER,
      });
      let rows = await ledgerOf(id);
      expect(rows.map((r) => r.kind)).toEqual(["reserve", "release"]);
      let [authority] = await inScope(() =>
        withTenantDb((tx) => readAuthority(tx, mandate, AFTER)),
      );
      expect(authority).toMatchObject({
        remaining: "2000000000",
        reserved: "0",
      });

      // Parked again, then retried after the window with no sweep between:
      // the lapsed row is voided on the way and the retry holds one reservation.
      const again = await decide(checkArgs(agent, input));
      expect(again.kind).toBe("pending");
      const late = await decide(checkArgs(agent, input, { now: () => AFTER }));
      expect(late.kind).toBe("pending");
      if (again.kind !== "pending" || late.kind !== "pending") return;
      expect(late.approvalPublicId).not.toBe(again.approvalPublicId);
      rows = await ledgerOf(id);
      expect(rows.map((r) => r.kind)).toEqual([
        "reserve",
        "release",
        "reserve",
        "release",
        "reserve",
      ]);
      [authority] = await inScope(() =>
        withTenantDb((tx) => readAuthority(tx, mandate, AFTER)),
      );
      expect(authority).toMatchObject({
        remaining: "1970000000",
        reserved: "30000000",
      });
      const resolutions = await withSystemDb((tx) =>
        tx
          .select({ resolution: schema.approvalRequests.resolution })
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.mandateId, id)),
      );
      expect(resolutions.map((r) => r.resolution).sort()).toEqual([
        "expired",
        "expired",
        null,
      ]);
    });

    it("enforces the unique movement index as the database backstop", async () => {
      const agent = randomUUID();
      const id = await insertMandate(agent);
      const toolCallId = randomUUID();
      await expect(
        withSystemDb(async (tx) => {
          for (let i = 0; i < 2; i++) {
            await tx.insert(schema.mandateLedger).values({
              orgId,
              workspaceId,
              mandateId: id,
              toolCallId,
              kind: "reserve",
              measure: "amount",
              value: "1",
              unitOrCurrency: "USD",
              periodKey: "2026-09",
              balanceAfter: "1",
            });
          }
        }),
      ).rejects.toSatisfy(isUniqueViolation);
    });

    it("the check scopes to the mandate's own workspace", async () => {
      const agent = randomUUID();
      await insertMandate(agent);
      const out = await decide(
        checkArgs(
          agent,
          { amount: { value: "1" } },
          { workspaceId: randomUUID() },
        ),
      );
      // No declared tool in that workspace: nothing to gate.
      expect(out).toEqual({ kind: "no_opinion" });
    });
  },
);
