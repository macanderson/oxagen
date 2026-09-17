/**
 * Unit tests for provision-enterprise-org's decision helpers.
 *
 * The helpers under test are the ones a wrong answer costs money or an outage:
 * `topUpCents` decides how much to grant (over-grant is harmless, under-grant
 * leaves the gate able to fire, and a NEGATIVE grant would be rejected by
 * `createCreditLot`'s `amountCents > 0` invariant at the worst moment), and
 * `parseFloorUsd` is the only thing standing between a fat-fingered flag and a
 * balance floor of NaN.
 *
 * The module's `main()` is guarded behind an invoked-directly check, so
 * importing it here opens no database connection.
 */
import { getTableColumns } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@oxagen/database";
import { describe, it, expect } from "vitest";
import { resolve, type Role } from "@oxagen/oxagen/iam";
import {
  DEFAULT_ACTIONS_ANNUAL,
  DEFAULT_FLOOR_USD,
  formatCents,
  isLocalHost,
  parseActionsAnnual,
  parseFloorUsd,
  orgWideSystemOwnerWhere,
  ownerReadiness,
  PLAN_ALLOWANCE_COLUMN,
  subscriptionAllowanceRefusal,
  subscriptionGuard,
  sanitizeUrl,
  shouldWriteAllowance,
  topUpCents,
  unprovisionableReason,
  usdToCents,
} from "./provision-enterprise-org";

describe("topUpCents", () => {
  it("grants the shortfall when the balance is below the floor", () => {
    expect(topUpCents(500n, 10_000n)).toBe(9_500n);
  });

  it("grants nothing when the balance already meets the floor", () => {
    expect(topUpCents(10_000n, 10_000n)).toBe(0n);
  });

  it("grants nothing when the balance exceeds the floor — never claws back", () => {
    // A negative return would be handed to createCreditLot, whose
    // `amountCents > 0` invariant throws. Converging on a floor means "top up
    // to", never "true up to".
    expect(topUpCents(50_000n, 10_000n)).toBe(0n);
  });

  it("grants the whole floor from a zero balance", () => {
    expect(topUpCents(0n, 100n)).toBe(100n);
  });

  it("treats a non-positive floor as no-op rather than a negative grant", () => {
    expect(topUpCents(0n, 0n)).toBe(0n);
    expect(topUpCents(0n, -1n)).toBe(0n);
  });

  it("is exact at the default floor", () => {
    const floor = usdToCents(DEFAULT_FLOOR_USD);
    expect(floor).toBe(10_000_000n);
    expect(topUpCents(1n, floor)).toBe(9_999_999n);
  });

  it("stays exact well past Number's integer range, for a floor set by flag", () => {
    // --floor-usd takes whatever an operator passes, and the arithmetic is
    // bigint throughout, so a figure beyond 2^53 cents is still exact.
    const huge = usdToCents(1_000_000_000);
    expect(huge).toBe(100_000_000_000n);
    expect(topUpCents(1n, huge)).toBe(99_999_999_999n);
  });
});

describe("parseFloorUsd", () => {
  it("defaults when the flag is absent", () => {
    expect(parseFloorUsd(undefined)).toBe(DEFAULT_FLOOR_USD);
  });

  it("accepts a positive whole number", () => {
    expect(parseFloorUsd("5000000")).toBe(5_000_000);
  });

  it("tolerates surrounding whitespace from shell quoting", () => {
    expect(parseFloorUsd(" 5000000 ")).toBe(5_000_000);
  });

  it("defaults to a figure a human reading the billing page can believe", () => {
    expect(DEFAULT_FLOOR_USD).toBe(100_000);
  });

  it.each(["0", "-1", "abc", "1.5", "", "   ", "Infinity", "NaN", "1e9"])(
    "rejects %o rather than producing a NaN floor",
    (raw) => {
      expect(() => parseFloorUsd(raw)).toThrow(/positive whole number/);
    },
  );
});

describe("parseActionsAnnual", () => {
  it("defaults to the figure the fallback already used, so provisioning bills no differently", () => {
    // The point of writing it down is not a new number; it is that the
    // allowance stops being ABSENT, which is what the meter alerts on.
    expect(parseActionsAnnual(undefined)).toBe(DEFAULT_ACTIONS_ANNUAL);
    expect(DEFAULT_ACTIONS_ANNUAL).toBe(1_500_000);
  });

  it("accepts a larger negotiated commitment", () => {
    expect(parseActionsAnnual("25000000")).toBe(25_000_000);
  });

  it("accepts zero — a commitment of no included actions is a real one", () => {
    expect(parseActionsAnnual("0")).toBe(0);
  });

  it.each(["-1", "abc", "1.5", "", "   ", "Infinity", "NaN", "1e9"])(
    "rejects %o rather than writing a corrupt allowance",
    (raw) => {
      expect(() => parseActionsAnnual(raw)).toThrow(
        /non-negative whole number/,
      );
    },
  );
});

describe("usdToCents", () => {
  it("converts whole dollars to credit cents", () => {
    expect(usdToCents(1)).toBe(100n);
    expect(usdToCents(DEFAULT_FLOOR_USD)).toBe(10_000_000n);
    expect(usdToCents(1_000_000_000)).toBe(100_000_000_000n);
  });
});

describe("formatCents", () => {
  it("renders credit cents as grouped USD", () => {
    expect(formatCents(0n)).toBe("$0.00");
    expect(formatCents(5n)).toBe("$0.05");
    expect(formatCents(12_345_678n)).toBe("$123,456.78");
    expect(formatCents(usdToCents(DEFAULT_FLOOR_USD))).toBe("$100,000.00");
    expect(formatCents(100_000_000_000n)).toBe("$1,000,000,000.00");
  });

  it("renders a negative balance without losing the sign", () => {
    expect(formatCents(-150n)).toBe("-$1.50");
  });
});

describe("sanitizeUrl", () => {
  it("strips credentials and keeps host and database", () => {
    expect(
      sanitizeUrl("postgres://u:secret@db.example.com:5432/oxagen"),
    ).toEqual({ host: "db.example.com:5432", database: "oxagen" });
  });

  it("defaults the port when the URL omits it", () => {
    expect(sanitizeUrl("postgres://u:p@db.example.com/oxagen").host).toBe(
      "db.example.com:5432",
    );
  });

  it("never throws on an unparseable URL — the banner must still print", () => {
    expect(sanitizeUrl("not a url")).toEqual({
      host: "(unparseable)",
      database: "(unparseable)",
    });
  });
});

describe("isLocalHost", () => {
  it.each(["localhost", "localhost:5433", "127.0.0.1:5432", "::1"])(
    "treats %o as local (no confirmation prompt)",
    (host) => {
      expect(isLocalHost(host)).toBe(true);
    },
  );

  it.each([
    "db.example.com:5432",
    "oxagen-prod.rds.amazonaws.com:5432",
    "localhost.evil.com:5432",
  ])("treats %o as remote, so --apply must be confirmed", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});

describe("shouldWriteAllowance", () => {
  // The documented recurring top-up command passes no --actions-annual, so
  // without this guard the default replaced a negotiated commitment and the
  // organisation began paying overage on terms nobody changed (#3140,
  // discussion_r4031855536).
  it("leaves a stored commitment alone when the flag was not given", () => {
    expect(shouldWriteAllowance(25_000_000n, false)).toBe(false);
    expect(shouldWriteAllowance(0n, false)).toBe(false);
  });

  it("writes when the operator supplied a figure", () => {
    expect(shouldWriteAllowance(25_000_000n, true)).toBe(true);
  });

  it("fills a column that holds nothing either way", () => {
    // An enterprise org with no recorded figure is the mis-provisioned state
    // billing_enterprise_allowance_missing alerts on, so leaving it empty is
    // not a kindness.
    expect(shouldWriteAllowance(null, false)).toBe(true);
    expect(shouldWriteAllowance(undefined, false)).toBe(true);
  });
});

describe("unprovisionableReason", () => {
  // org.list and workspace.list hide an organisation specifically while its
  // status is 'deleted'. The script writes status: 'active', and the target
  // queries never filtered on status, so provisioning resurrected a deleted
  // tenant and re-exposed its retained workspaces (#3140,
  // discussion_r4032251333).
  it("refuses a deleted organisation", () => {
    expect(unprovisionableReason("deleted")).toMatch(/re-expose the tenant/);
  });

  it("allows the statuses provisioning is meant to repair", () => {
    for (const status of ["active", "suspended", "past_due", "trialing"]) {
      expect(unprovisionableReason(status)).toBeUndefined();
    }
  });
});

describe("orgWideSystemOwnerWhere", () => {
  // The preflight exists to stop an organisation locking itself out when the
  // enterprise tier switches the default-deny resolver on. It joined through to
  // a system Owner role without constraining the ASSIGNMENT, so a
  // workspace-only Owner satisfied it (#3178, discussion_r4034318919).
  const compiled = () =>
    new PgDialect().sqlToQuery(
      orgWideSystemOwnerWhere(
        "11111111-1111-4111-8111-111111111111",
        new Date("2026-09-17T00:00:00.000Z"),
      ),
    );

  it("requires the assignment to be org-wide, not workspace-scoped", () => {
    const { sql } = compiled();
    // The clause a workspace-scoped Owner fails.
    expect(sql).toMatch(/"workspace_id" is null/i);
  });

  it("constrains the assignment to this organisation", () => {
    const { sql, params } = compiled();
    // Two org_id comparisons on principal_role_assignments and principals, plus
    // the role's: joining to a role this org owns does not scope the assignment.
    expect(sql.match(/"org_id" = \$/g)?.length).toBeGreaterThanOrEqual(3);
    expect(params).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("requires the ORG-scoped Owner, not the workspace one", () => {
    // iam-provision.ts seeds two system roles named "Owner" per organisation:
    // scope_kind 'org' from ORG_ROLES and scope_kind 'workspace' from
    // WORKSPACE_ROLES, both is_system_default. Resolver rule 7.5 grants
    // org-owner super-user only for scopeKind === "org", so an org-wide
    // assignment to the workspace Owner would pass a preflight the resolver
    // refuses (#3178, discussion on the ready review).
    const { sql, params } = compiled();
    expect(sql).toMatch(/"scope_kind" = \$/);
    expect(params).toContain("org");
  });

  it("requires the principal to lead back to a live user", () => {
    // fetch-authz resolves a human by matching their user id to
    // principals.parent_user_id and nothing else, so a null link is an Owner
    // principal no caller can ever resolve to (r4035774889). The column is
    // nullable, and a legacy or hand-made principal can carry NULL.
    const { sql, params } = compiled();
    expect(sql).toMatch(/"parent_user_id" is not null/i);
    // Non-null is only the first of the three the reviewer named. The user must
    // also be extant and not soft-deleted — extancy is the inner join at the
    // call site, which no predicate can carry, so this pins the two that live
    // here and the join test below pins the rest.
    expect(sql).toMatch(/"users"\."deleted_at" is null/i);
    expect(params).toContain("active");
  });

  it("keeps the clauses that were already right", () => {
    const { sql, params } = compiled();
    expect(sql).toMatch(/"kind" = \$/);
    expect(sql).toMatch(/"is_system_default" = \$/);
    expect(sql).toMatch(/"deleted_at" is null/i);
    expect(sql).toMatch(/"expires_at" is null/i);
    expect(params).toContain("human");
    expect(params).toContain("Owner");
  });
});

// ---------------------------------------------------------------------------
// The preflight and the resolver, checked against each other
// ---------------------------------------------------------------------------
//
// Three review findings on #3178 were the same defect on three different axes:
// the assignment's scope (r4034318919), the role's scope (r4034776760), and the
// principal's link to a real user (r4035774889). Each time the SQL predicate
// looked complete, and each clause was asserted through PgDialect. That is the
// lesson rather than the bug: an assertion shows a clause is PRESENT, never
// that the set is SUFFICIENT, and nothing tied the predicate to the resolver it
// was predicting.
//
// So the preflight stopped predicting. `ownerReadiness` asks `fetchAuthz` and
// rule 7.5's own exported predicate. These cases pin the two together by
// BEHAVIOUR over every lockout shape found so far: for each, the resolver must
// refuse and the preflight must refuse. A fourth axis added to this list fails
// here the moment the two disagree.

const ORG = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

const principal = {
  id: PRINCIPAL,
  kind: "human" as const,
  orgId: ORG,
  workspaceId: null,
};

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Owner",
    scopeKind: "org",
    orgId: ORG,
    principalIds: [PRINCIPAL],
    isSystemDefault: true,
    ...overrides,
  };
}

/** What the resolver decides for a capability with no grant of its own. */
function resolverOutcome(roles: readonly Role[]) {
  return resolve({
    principal,
    capability: "get_org",
    scope: { kind: "org" as const, orgId: ORG, workspaceId: WS },
    grants: [],
    roles,
    roleGrants: [],
    policies: [],
    defaultEffect: "deny",
  });
}

/** What the preflight decides, given what the resolver would return. */
function preflight(authz: {
  principal: { id: string } | null;
  roles: readonly Role[];
}) {
  return ownerReadiness({
    loadCandidates: async () => [{ principalId: PRINCIPAL, userId: USER }],
    fetchAuthzFor: async () => authz,
  });
}

describe("every known lockout shape is refused by BOTH the resolver and the preflight", () => {
  it("the positive control: a real org-scoped system Owner satisfies both", async () => {
    // Without this the suite could pass by refusing everything, which is the
    // failure mode a preflight has: a check that never says yes is not a check.
    const roles = [role()];
    const decided = resolverOutcome(roles);
    expect(decided.outcome).toBe("allow");
    expect(decided.trace.decidedBy.rule).toBe("7.5:org_owner_superuser");

    const ready = await preflight({ principal: { id: PRINCIPAL }, roles });
    expect(ready).toEqual({
      ready: true,
      considered: 1,
      confirmedUserId: USER,
    });
  });

  it("shape 1 — a workspace-scoped ASSIGNMENT (r4034318919)", async () => {
    // fetch-authz filters assignments to `workspace_id IS NULL OR = $ws`, so an
    // assignment made only in another workspace never puts this principal in
    // the role's principalIds. The role exists; the membership does not.
    const roles = [role({ principalIds: [] })];
    expect(resolverOutcome(roles).outcome).toBe("deny");

    const ready = await preflight({ principal: { id: PRINCIPAL }, roles });
    expect(ready.ready).toBe(false);
  });

  it("shape 2 — a workspace-scoped ROLE (r4034776760)", async () => {
    // Every org carries two system roles named Owner. Rule 7.5 grants
    // super-user for the org-scoped one alone.
    const roles = [role({ scopeKind: "workspace" })];
    expect(resolverOutcome(roles).outcome).toBe("deny");

    const ready = await preflight({ principal: { id: PRINCIPAL }, roles });
    expect(ready.ready).toBe(false);
  });

  it("shape 3 — a null parent_user_id (r4035774889)", async () => {
    // The resolver finds a human ONLY by matching the caller's user id to
    // principals.parent_user_id. A null link is an Owner principal that no
    // caller can ever resolve to, so fetchAuthz returns no principal at all —
    // and the preflight refuses on the authority's own answer rather than on a
    // clause predicting it.
    const ready = await preflight({ principal: null, roles: [role()] });
    expect(ready).toEqual({
      ready: false,
      considered: 1,
      confirmedUserId: null,
    });
  });

  it("shape 4 — an ORPHANED parent_user_id (r4035774889)", async () => {
    // Points at a user that was deleted or never existed. Indistinguishable
    // from shape 3 to the resolver, which is exactly why "IS NOT NULL" alone
    // does not cover it: non-null is necessary, not sufficient.
    const ready = await preflight({ principal: null, roles: [role()] });
    expect(ready.ready).toBe(false);
  });

  it("a role merely NAMED Owner is not one, on either side", async () => {
    const roles = [role({ isSystemDefault: false })];
    expect(resolverOutcome(roles).outcome).toBe("deny");
    expect(
      (await preflight({ principal: { id: PRINCIPAL }, roles })).ready,
    ).toBe(false);
  });
});

describe("ownerReadiness", () => {
  it("asks the resolver about every candidate until one confirms", async () => {
    const asked: string[] = [];
    const result = await ownerReadiness({
      loadCandidates: async () => [
        { principalId: "p1", userId: "u1" },
        { principalId: "p2", userId: "u2" },
        { principalId: "p3", userId: "u3" },
      ],
      fetchAuthzFor: async (userId) => {
        asked.push(userId);
        return userId === "u2"
          ? { principal: { id: "p2" }, roles: [role({ principalIds: ["p2"] })] }
          : { principal: { id: userId }, roles: [] };
      },
    });
    expect(result).toEqual({
      ready: true,
      considered: 3,
      confirmedUserId: "u2",
    });
    // Stops at the first confirmation: one super-user is what "not locked out"
    // means, so u3 is never asked about.
    expect(asked).toEqual(["u1", "u2"]);
  });

  it("refuses when the candidate query proposes nobody", async () => {
    expect(
      await ownerReadiness({
        loadCandidates: async () => [],
        fetchAuthzFor: async () => {
          throw new Error("must not be asked");
        },
      }),
    ).toEqual({ ready: false, considered: 0, confirmedUserId: null });
  });

  it("rejects a candidate the query should not have proposed", async () => {
    // The point of the inversion. A clause missing from the SQL now costs one
    // resolver call and a rejection, not an organisation locked out — so a
    // fourth axis nobody has found yet is already handled.
    const result = await ownerReadiness({
      loadCandidates: async () => [{ principalId: PRINCIPAL, userId: USER }],
      fetchAuthzFor: async () => ({
        principal: { id: PRINCIPAL },
        roles: [role({ scopeKind: "workspace" })],
      }),
    });
    expect(result.ready).toBe(false);
    expect(result.considered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Operator-facing remediation, checked against the schema
// ---------------------------------------------------------------------------

describe("subscriptionAllowanceRefusal", () => {
  // This message named `included_actions_annual` until migration
  // 20260915120000 dropped that column, so it told operators to edit something
  // that does not exist (r4036214061). Nothing caught it, because a string is
  // only wrong to the person already stuck on it.
  //
  // So the column is checked against the Drizzle table rather than against
  // another copy of the same literal. Drop or rename it and this fails here
  // instead of in front of an operator.
  it("names a column that exists in billing.plans", () => {
    const [schemaName, tableName, columnName] =
      PLAN_ALLOWANCE_COLUMN.split(".");
    expect(schemaName).toBe("billing");
    expect(tableName).toBe("plans");
    const columns = Object.values(getTableColumns(schema.plans)).map(
      (c) => c.name,
    );
    expect(columns).toContain(columnName);
    // And the column it used to name really is gone, so this test is not
    // passing on a coincidence of both being present.
    expect(columns).not.toContain("included_actions_annual");
  });

  it("converts the annual flag to the monthly figure the column stores", () => {
    // The caller passed --actions-annual; the column is monthly. Leaving them
    // to infer the x12 is how a plan gets set to twelve times its allowance.
    const message = subscriptionAllowanceRefusal("scale-v2", 1_200_000);
    expect(message).toContain("100,000");
    expect(message).toContain("1,200,000");
    expect(message).toMatch(/MONTHLY/);
    expect(message).toContain("billing.plans.included_gau_per_month");
  });

  it("rounds a figure that does not divide by twelve UP, never short", () => {
    // Rounding down would quietly record less than the operator negotiated.
    expect(subscriptionAllowanceRefusal("p", 13)).toContain(" 2 ");
  });

  it("names the plan the operator has to change", () => {
    expect(subscriptionAllowanceRefusal("enterprise-v2", 12)).toContain(
      "'enterprise-v2'",
    );
  });
});

// ── the two guards that turn on "is this organisation enterprise" (#3225) ────
//
// The script has two notions of enterprise: `organizations.plan_type`, and the
// EFFECTIVE tier, which `resolveOrgActionEntitlement` computes with an entitled
// subscription winning over the column. Both guards were written against the
// column. Both were the same mistake, eighty lines apart.
describe("subscriptionGuard", () => {
  const enterpriseSub = {
    status: "active",
    planSlug: "enterprise",
    planTier: "enterprise",
  };
  const scaleSub = { status: "active", planSlug: "scale", planTier: "scale" };

  it("lets an unsubscribed org through, and checks it for lockout", () => {
    // The ordinary case: nothing wins over `plan_type`, so this run really can
    // make the org enterprise and the Owner preflight has something to protect.
    expect(subscriptionGuard(undefined, false, 0)).toEqual({
      subscriptionWins: false,
      checkOwnerReadiness: true,
    });
  });

  it("does not check Owner readiness when the tier cannot change", () => {
    // The first defect. The preflight ran unconditionally, so a target with an
    // entitled Scale subscription and no usable org-wide Owner had its WHOLE
    // run refused — for a lockout that cannot happen, since the subscription
    // keeps winning and the human resolver stays bypassed. The refusal also
    // cost the credit-floor and billing-setting updates that the
    // `subscriptionOverrides` path applies deliberately while exiting 2.
    expect(subscriptionGuard(scaleSub, false, 0)).toEqual({
      subscriptionWins: true,
      checkOwnerReadiness: false,
    });
  });

  it("still checks it for an org already on an enterprise subscription", () => {
    // The tier write is not inert here — the subscription agrees with it — so
    // a lockout IS reachable and the preflight still applies.
    expect(subscriptionGuard(enterpriseSub, false, 0)).toEqual({
      subscriptionWins: false,
      checkOwnerReadiness: true,
    });
  });

  it("refuses --actions-annual for a NON-enterprise entitled subscription", () => {
    // The second defect, and the discriminating case. The refusal sat inside
    // the enterprise-plan branch, so this org skipped it: the script wrote
    // `negotiated_actions_annual`, reported it as set, and
    // `resolveOrgActionEntitlement` never read it — because it takes the
    // SUBSCRIBED plan's monthly allowance first, whatever tier that plan is on.
    const decision = subscriptionGuard(scaleSub, true, 24_000_000);
    expect(decision.refusal).toBeDefined();
    expect(decision.checkOwnerReadiness).toBe(false);
  });

  it("gives it the same message an enterprise-plan org gets", () => {
    // Same defect, same remediation, named for the plan the allowance actually
    // comes from. An operator who follows the enterprise message and moves the
    // subscription would otherwise re-run without the flag and have the
    // retained figure ignored, with nothing on screen to suggest it would be.
    const onScale = subscriptionGuard(scaleSub, true, 24_000_000).refusal;
    const onEnterprise = subscriptionGuard(
      enterpriseSub,
      true,
      24_000_000,
    ).refusal;
    expect(onScale).toBe(subscriptionAllowanceRefusal("scale", 24_000_000));
    expect(onEnterprise).toBe(
      subscriptionAllowanceRefusal("enterprise", 24_000_000),
    );
    // The same sentence modulo the plan it names, rather than two messages
    // that drifted apart.
    expect(onScale?.replace("'scale'", "'X'")).toBe(
      onEnterprise?.replace("'enterprise'", "'X'"),
    );
  });

  it("does not refuse --actions-annual for an org with no subscription", () => {
    // The figure is read for an unsubscribed enterprise org, which is the case
    // the flag exists for. Refusing here would be the mirror-image bug.
    expect(subscriptionGuard(undefined, true, 24_000_000)).toEqual({
      subscriptionWins: false,
      checkOwnerReadiness: true,
    });
  });
});
