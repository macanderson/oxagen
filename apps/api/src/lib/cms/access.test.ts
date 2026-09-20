/**
 * Unit tests for the ebook access logic (access.ts).
 *
 * The real drizzle schema is used (so the sql`` fragments referencing real
 * columns build correctly) and only withSystemDb is mocked — it invokes the
 * callback with a scripted fake transaction whose query builders resolve to
 * queued results. This exercises the real branching (single-use, rotation,
 * expiry, unknown edition) without a live database, so it runs in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ tx: null as unknown }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...actual,
    // Run access.ts's transaction body against the per-test scripted fake tx.
    withSystemDb: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(h.tx),
  };
});

import { and, eq, ne } from "drizzle-orm";
import { schema } from "@oxagen/database";
import {
  generateAccessCode,
  isEditionSlug,
  resolveMarketingUrl,
  readerUrl,
  captureLead,
  captureLeadAndIssueCode,
  finalizeCodeDelivery,
  findLeadByEmail,
  issueCodeForLead,
  redeemAndRotate,
} from "./access";

const { bookAccessCodes, leads } = schema;

/**
 * A fake drizzle tx: every builder method (`from`, `where`, `limit`, `for`,
 * `values`, `set`, `onConflictDoUpdate`, `returning`, …) returns the same
 * awaitable chain, which resolves to the next queued result for that verb.
 */
function makeFakeTx(opts: {
  selects?: unknown[][];
  inserts?: unknown[][];
  onConflictSets?: Record<string, unknown>[];
}) {
  let si = 0;
  let ii = 0;
  const chain = (resolveVal: () => unknown) => {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(resolveVal());
        }
        return (arg?: unknown) => {
          if (
            prop === "onConflictDoUpdate" &&
            arg &&
            typeof arg === "object" &&
            "set" in arg &&
            opts.onConflictSets
          ) {
            opts.onConflictSets.push(
              (arg as { set: Record<string, unknown> }).set,
            );
          }
          return proxy;
        };
      },
      apply() {
        return proxy;
      },
    });
    return proxy;
  };
  return {
    select: () => chain(() => opts.selects?.[si++] ?? []),
    insert: () => chain(() => opts.inserts?.[ii++] ?? []),
    update: () => chain(() => []),
  };
}

const ENV = process.env.MARKETING_URL;
beforeEach(() => {
  vi.clearAllMocks();
  if (ENV === undefined) delete process.env.MARKETING_URL;
  else process.env.MARKETING_URL = ENV;
});

describe("pure helpers", () => {
  it("generateAccessCode: 26 crockford chars, unique across calls", () => {
    const a = generateAccessCode();
    const b = generateAccessCode();
    expect(a).toHaveLength(26);
    expect(a).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]+$/);
    expect(a).not.toBe(b);
    expect(generateAccessCode(10)).toHaveLength(10);
  });

  it("isEditionSlug narrows known slugs only", () => {
    expect(isEditionSlug("field-manual")).toBe(true);
    expect(isEditionSlug("page-flip-reader")).toBe(true);
    expect(isEditionSlug("nope")).toBe(false);
  });

  it("resolveMarketingUrl prefers MARKETING_URL, else a dev default", () => {
    process.env.MARKETING_URL = "https://oxagen.sh/";
    expect(resolveMarketingUrl()).toBe("https://oxagen.sh"); // trailing slash trimmed
    delete process.env.MARKETING_URL;
    expect(resolveMarketingUrl()).toBe("http://localhost:8080");
  });

  it("readerUrl builds the single-use reader link", () => {
    process.env.MARKETING_URL = "https://oxagen.sh";
    expect(readerUrl("page-flip-reader", "abc123")).toBe(
      "https://oxagen.sh/read?e=page-flip-reader&c=abc123",
    );
  });
});

describe("captureLeadAndIssueCode", () => {
  it("upserts the lead, mints a code, returns the reader url", async () => {
    process.env.MARKETING_URL = "https://oxagen.sh";
    h.tx = makeFakeTx({
      // lock-lead, then the prior-active-code lookup (none: first code ever)
      selects: [[{ id: "lead_1" }], []],
      inserts: [
        [{ id: "lead_1", email: "ada@example.com" }],
        [{ id: "code_1" }],
      ],
    });
    const out = await captureLeadAndIssueCode(
      { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
      "page-flip-reader",
      "signup",
    );
    expect(out.leadId).toBe("lead_1");
    expect(out.codeId).toBe("code_1");
    expect(out.readUrl).toMatch(
      /^https:\/\/oxagen\.sh\/read\?e=page-flip-reader&c=/,
    );
  });

  it("throws if the upsert returns no row", async () => {
    h.tx = makeFakeTx({ inserts: [[]] });
    await expect(
      captureLeadAndIssueCode(
        { email: "x@y.com", firstName: "X", lastName: "Y" },
        "field-manual",
        "signup",
      ),
    ).rejects.toThrow(/no row/);
  });
});

describe("captureLead — marketing consent on conflict", () => {
  it("writes marketingConsent on conflict when the caller sent an explicit boolean", async () => {
    const onConflictSets: Record<string, unknown>[] = [];
    h.tx = makeFakeTx({
      inserts: [[{ id: "lead_1", email: "ada@example.com" }]],
      onConflictSets,
    });
    await captureLead({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      marketingConsent: false,
    });
    expect(onConflictSets[0]).toMatchObject({ marketingConsent: false });
  });

  it("clears the CRM sync marker on every resubmission", async () => {
    const onConflictSets: Record<string, unknown>[] = [];
    h.tx = makeFakeTx({
      inserts: [[{ id: "lead-1", email: "ada@example.com" }]],
      onConflictSets,
    });
    await captureLead({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    // The record id is kept (the next sync updates the same person); only
    // the "seen" marker is cleared so the backfill finds the new version.
    expect(onConflictSets[0]).toMatchObject({ crmSyncedAt: null });
    expect(onConflictSets[0]).not.toHaveProperty("crmRecordId");
  });

  it("omits marketingConsent from the conflict set when the caller left it unset", async () => {
    const onConflictSets: Record<string, unknown>[] = [];
    h.tx = makeFakeTx({
      inserts: [[{ id: "lead_1", email: "ada@example.com" }]],
      onConflictSets,
    });
    await captureLead({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(onConflictSets[0]).not.toHaveProperty("marketingConsent");
  });
});

describe("findLeadByEmail", () => {
  it("returns the lead when present", async () => {
    h.tx = makeFakeTx({
      selects: [[{ id: "lead_1", email: "ada@example.com" }]],
    });
    expect(await findLeadByEmail("ada@example.com")).toEqual({
      id: "lead_1",
      email: "ada@example.com",
    });
  });
  it("returns null when absent", async () => {
    h.tx = makeFakeTx({ selects: [[]] });
    expect(await findLeadByEmail("ghost@example.com")).toBeNull();
  });
});

describe("issueCodeForLead", () => {
  it("mints a fresh code and returns the reader url", async () => {
    process.env.MARKETING_URL = "https://oxagen.sh";
    h.tx = makeFakeTx({
      // lock-lead, then the prior-active-code lookup
      selects: [[{ id: "lead_1" }], [{ id: "code_old" }]],
      inserts: [[{ id: "code_new" }]],
    });
    const out = await issueCodeForLead("lead_1", "field-manual");
    expect(out.readUrl).toMatch(
      /^https:\/\/oxagen\.sh\/read\?e=field-manual&c=/,
    );
    expect(out.codeId).toBe("code_new");
  });

  it("throws when the lead row is missing", async () => {
    h.tx = makeFakeTx({ selects: [[]] });
    await expect(issueCodeForLead("missing", "field-manual")).rejects.toThrow(
      /lead not found/,
    );
  });
});

describe("redeemAndRotate — single-use enforcement", () => {
  const editionRow = [{ html: "<html>book</html>", title: "Reader" }];

  it("rejects an unknown edition slug up front", async () => {
    expect(await redeemAndRotate("bogus", "code")).toEqual({
      ok: false,
      reason: "unknown_edition",
    });
  });

  it("returns unknown_edition when the edition is not published", async () => {
    h.tx = makeFakeTx({ selects: [[]] });
    expect(await redeemAndRotate("field-manual", "code")).toEqual({
      ok: false,
      reason: "unknown_edition",
    });
  });

  it("returns invalid when the code does not exist, before taking any lock", async () => {
    h.tx = makeFakeTx({ selects: [editionRow, []] });
    expect(await redeemAndRotate("page-flip-reader", "nope")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("returns consumed for an already-used code (the single-use guarantee)", async () => {
    h.tx = makeFakeTx({
      selects: [
        editionRow,
        [{ leadId: "l1" }], // unlocked lookup of the code's lead
        [{ id: "l1" }], // lead lock, taken before the code lock
        [{ id: "c1", leadId: "l1", status: "consumed", expiresAt: null }],
      ],
    });
    expect(await redeemAndRotate("page-flip-reader", "used")).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("returns expired for a past-expiry code", async () => {
    h.tx = makeFakeTx({
      selects: [
        editionRow,
        [{ leadId: "l1" }], // unlocked lookup of the code's lead
        [{ id: "l1" }], // lead lock, taken before the code lock
        [
          {
            id: "c1",
            leadId: "l1",
            status: "active",
            expiresAt: new Date(Date.now() - 1000),
          },
        ],
      ],
    });
    expect(await redeemAndRotate("page-flip-reader", "old")).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("consumes + rotates a valid code and returns the book html + fresh code, without leaking the lead's email", async () => {
    h.tx = makeFakeTx({
      selects: [
        editionRow,
        [{ leadId: "l1" }], // unlocked lookup of the code's lead
        [{ id: "l1" }], // lead lock, taken before the code lock
        [{ id: "c1", leadId: "l1", status: "active", expiresAt: null }],
        [{ id: "l1" }], // mintCodeTx: lock lead
        [], // mintCodeTx: prior-active lookup — none, c1 was just consumed
        [{ slug: "page-flip-reader", title: "Reader", format: "page-flip" }],
      ],
      inserts: [[{ id: "code_new" }]],
    });
    const res = await redeemAndRotate("page-flip-reader", "good");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.html).toContain("book");
      expect(res.newCode).toHaveLength(26);
      expect(res).not.toHaveProperty("leadEmail");
      expect(res.editions).toHaveLength(1);
    }
  });
});

describe("redeemAndRotate — lock order", () => {
  it("locks the lead before the code row, the same order mintCodeTx uses", async () => {
    const { schema } = await import("@oxagen/database");
    const queue: unknown[][] = [
      [{ html: "<html>book</html>", title: "Reader" }],
      [{ leadId: "l1" }],
      [{ id: "l1" }],
      [{ id: "c1", leadId: "l1", status: "active", expiresAt: null }],
      [{ id: "l1" }],
      [],
      [],
    ];
    // Each select records the table it read and whether it took a row lock.
    const locks: unknown[] = [];
    const selectChain = () => {
      let table: unknown;
      const result = queue.shift() ?? [];
      const chain: Record<string, unknown> = {
        from: (t: unknown) => ((table = t), chain),
        where: () => chain,
        limit: () => chain,
        for: () => (locks.push(table), chain),
        then: (resolve: (v: unknown) => unknown) => resolve(result),
      };
      return chain;
    };
    const passthrough = (value: unknown) => {
      const chain: Record<string, unknown> = {
        values: () => chain,
        set: () => chain,
        where: () => chain,
        returning: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve(value),
      };
      return chain;
    };
    h.tx = {
      select: selectChain,
      insert: () => passthrough([{ id: "code_new" }]),
      update: () => passthrough([]),
    };
    const res = await redeemAndRotate("page-flip-reader", "good");
    expect(res.ok).toBe(true);
    expect(locks[0]).toBe(schema.leads);
    expect(locks[1]).toBe(schema.bookAccessCodes);
  });
});

describe("finalizeCodeDelivery", () => {
  /**
   * select() resolves from `selects` in order (the lead lock, then the new
   * code's status); every update's where() argument is recorded.
   */
  function fakeFinalizeTx(selects: unknown[][]) {
    const whereArgs: unknown[] = [];
    const locks: unknown[] = [];
    const tx = {
      select: () => {
        let table: unknown;
        const result = selects.shift() ?? [];
        const chain: Record<string, unknown> = {
          from: (t: unknown) => ((table = t), chain),
          where: () => chain,
          limit: () => chain,
          for: () => (locks.push(table), chain),
          then: (resolve: (v: unknown) => unknown) => resolve(result),
        };
        return chain;
      },
      update: () => ({
        set: () => ({
          where: (arg: unknown) => {
            whereArgs.push(arg);
            return Promise.resolve();
          },
        }),
      }),
    };
    return { tx, whereArgs, locks };
  }

  it("makes a delivered code the lead's one live link, revoking every other active code", async () => {
    const { tx, whereArgs, locks } = fakeFinalizeTx([
      [{ id: "lead_1" }],
      [{ status: "active" }],
    ]);
    h.tx = tx;
    await finalizeCodeDelivery("lead_1", "new_1", true);
    expect(locks).toEqual([leads]);
    expect(whereArgs).toEqual([
      and(
        eq(bookAccessCodes.leadId, "lead_1"),
        eq(bookAccessCodes.status, "active"),
        ne(bookAccessCodes.id, "new_1"),
      ),
    ]);
  });

  it("revokes nothing when a competing finalize already revoked this code", async () => {
    const { tx, whereArgs } = fakeFinalizeTx([
      [{ id: "lead_1" }],
      [{ status: "revoked" }],
    ]);
    h.tx = tx;
    await finalizeCodeDelivery("lead_1", "new_1", true);
    expect(whereArgs).toEqual([]);
  });

  it("revokes only the NEW code on a failed delivery, leaving any earlier link usable", async () => {
    const { tx, whereArgs, locks } = fakeFinalizeTx([[{ id: "lead_1" }]]);
    h.tx = tx;
    await finalizeCodeDelivery("lead_1", "new_1", false);
    expect(locks).toEqual([leads]);
    expect(whereArgs).toEqual([
      and(
        eq(bookAccessCodes.id, "new_1"),
        eq(bookAccessCodes.status, "active"),
      ),
    ]);
  });
});
