/**
 * Unit tests for provision-enterprise-org's decision helpers, and for the one
 * ordering the script cannot get wrong: the IAM gate runs before any write.
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
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/** Swapped per test; `db()` below hands it out. */
let currentDb: unknown;

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...actual,
    db: () => currentDb,
    closeDatabase: async () => undefined,
  };
});

import { schema } from "@oxagen/database";
import {
  DEFAULT_ACTIONS_ANNUAL,
  DEFAULT_FLOOR_USD,
  formatCents,
  iamVerdict,
  isLocalHost,
  main,
  parseActionsAnnual,
  parseFloorUsd,
  sanitizeUrl,
  topUpCents,
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

describe("iamVerdict", () => {
  it("passes an org with an active human org Owner", () => {
    const v = iamVerdict({ principals: 4, humanOwners: 1 });
    expect(v.ready).toBe(true);
    expect(v.message).toContain("1 active human org Owner");
  });

  it("refuses an org with no principals, naming the backfill", () => {
    const v = iamVerdict({ principals: 0, humanOwners: 0 });
    expect(v.ready).toBe(false);
    expect(v.message).toContain("REFUSED");
    expect(v.message).toContain("db:backfill-iam");
  });

  it("refuses an org whose only principals are agents", () => {
    // The finding this test exists for: any principal used to pass. An agent
    // principal with no human Owner behind it cannot reopen a door the
    // default-deny resolver closes, so it is not readiness.
    const v = iamVerdict({ principals: 3, humanOwners: 0 });
    expect(v.ready).toBe(false);
    expect(v.message).toContain("REFUSED");
    expect(v.message).toContain("no ACTIVE HUMAN principal");
    expect(v.message).toContain("Owner");
  });
});

// ── The ordering test ────────────────────────────────────────────────────────
//
// `main()` against a fake database. The assertion is not what it prints; it is
// that `update` and `insert` are never reached for an org that fails the gate.
// A check that ran after the tier write would leave `plan_type = 'enterprise'`
// behind and exit 0, which is the state the finding describes.

interface Recorded {
  kind: "update" | "insert";
  table: unknown;
}

class FakeQuery {
  table: unknown;
  joined = false;
  constructor(private readonly rows: (q: FakeQuery) => unknown[]) {}
  from(table: unknown): this {
    this.table = table;
    return this;
  }
  innerJoin(): this {
    this.joined = true;
    return this;
  }
  where(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  set(): this {
    return this;
  }
  values(): this {
    return this;
  }
  then(
    onOk: (value: unknown[]) => unknown,
    onErr?: (reason: unknown) => unknown,
  ): Promise<unknown> {
    try {
      return Promise.resolve(this.rows(this)).then(onOk, onErr);
    } catch (error) {
      return Promise.reject(error).then(onOk, onErr);
    }
  }
}

function fakeDb(options: {
  writes: Recorded[];
  principals: number;
  humanOwners: number;
  org?: Record<string, unknown>;
}) {
  const org = options.org ?? {
    id: "11111111-1111-4111-8111-111111111111",
    publicId: "org_test",
    name: "Acme",
    slug: "acme",
    planType: "free",
    status: "active",
  };
  const rows = (q: FakeQuery): unknown[] => {
    if (q.table === schema.organizations) return [org];
    if (q.table === schema.principals)
      return [{ n: q.joined ? options.humanOwners : options.principals }];
    if (q.table === schema.subscriptions) return [];
    if (q.table === schema.orgBillingSettings)
      return [
        {
          id: "settings",
          assistantSpendCapCents: null,
          dunningState: "active",
        },
      ];
    if (q.table === schema.spendBudgets) return [];
    // A lot far above the floor, so the credit step grants nothing and the
    // billing mocks stay out of this test.
    if (q.table === schema.creditLots) return [{ remaining: 999_999_999_999n }];
    if (q.table === schema.workspaces) return [{ id: "ws" }];
    return [];
  };
  return {
    select: () => new FakeQuery(rows),
    selectDistinct: () => new FakeQuery(rows),
    // `negotiated_actions_annual` absent: the column probe is not what these
    // tests are about, and an empty answer keeps the org select narrow.
    execute: async () => [],
    update: (table: unknown) => {
      options.writes.push({ kind: "update", table });
      return new FakeQuery(() => []);
    },
    insert: (table: unknown) => {
      options.writes.push({ kind: "insert", table });
      return new FakeQuery(() => []);
    },
  };
}

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe("main — the IAM gate runs before any write", () => {
  const argv = process.argv;
  const databaseUrl = process.env["DATABASE_URL"];
  let logged: string[];

  beforeEach(() => {
    logged = [];
    process.env["DATABASE_URL"] = "postgres://u:p@localhost:5433/oxagen";
    process.argv = ["node", "provision", "--org", "acme", "--apply", "--yes"];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitError(code);
    }) as never);
  });

  afterEach(() => {
    process.argv = argv;
    if (databaseUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = databaseUrl;
    vi.restoreAllMocks();
  });

  async function run(): Promise<number | undefined> {
    try {
      await main();
      return undefined;
    } catch (error) {
      if (error instanceof ExitError) return error.code;
      throw error;
    }
  }

  it("writes nothing for an org with no principals, and exits non-zero", async () => {
    const writes: Recorded[] = [];
    currentDb = fakeDb({ writes, principals: 0, humanOwners: 0 });
    expect(await run()).toBe(1);
    expect(writes).toEqual([]);
    expect(logged.join("\n")).toContain("REFUSED");
  });

  it("writes nothing for an org whose principals carry no human org Owner", async () => {
    // plan_type must NOT have moved. This is the finding: the old check ran
    // after the tier write and only warned, so the org was left on enterprise
    // with a default-deny resolver and no owner to reopen it.
    const writes: Recorded[] = [];
    currentDb = fakeDb({ writes, principals: 5, humanOwners: 0 });
    expect(await run()).toBe(1);
    expect(writes.filter((w) => w.table === schema.organizations)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("upgrades an org that does have one, so the gate is a gate and not a wall", async () => {
    const writes: Recorded[] = [];
    currentDb = fakeDb({ writes, principals: 5, humanOwners: 1 });
    expect(await run()).toBeUndefined();
    expect(writes.some((w) => w.table === schema.organizations)).toBe(true);
  });
});
