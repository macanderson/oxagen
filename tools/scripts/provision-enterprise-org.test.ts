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
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_ACTIONS_ANNUAL,
  DEFAULT_FLOOR_USD,
  formatCents,
  isLocalHost,
  parseActionsAnnual,
  parseFloorUsd,
  orgWideSystemOwnerWhere,
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
