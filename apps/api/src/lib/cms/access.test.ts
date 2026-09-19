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

import {
  generateAccessCode,
  isEditionSlug,
  resolveMarketingUrl,
  readerUrl,
  captureLeadAndIssueCode,
  findLeadByEmail,
  issueCodeForLead,
  redeemAndRotate,
} from "./access";

/**
 * A fake drizzle tx: every builder method (`from`, `where`, `limit`, `for`,
 * `values`, `set`, `onConflictDoUpdate`, `returning`, …) returns the same
 * awaitable chain, which resolves to the next queued result for that verb.
 */
function makeFakeTx(opts: { selects?: unknown[][]; inserts?: unknown[][] }) {
  let si = 0;
  let ii = 0;
  const chain = (resolveVal: () => unknown) => {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(resolveVal());
        }
        return () => proxy;
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
      inserts: [[{ id: "lead_1", email: "ada@example.com" }], []],
    });
    const out = await captureLeadAndIssueCode(
      { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
      "page-flip-reader",
      "signup",
    );
    expect(out.leadId).toBe("lead_1");
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
    h.tx = makeFakeTx({ inserts: [[]] });
    const url = await issueCodeForLead("lead_1", "field-manual");
    expect(url).toMatch(/^https:\/\/oxagen\.sh\/read\?e=field-manual&c=/);
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

  it("returns invalid when the code does not exist", async () => {
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

  it("consumes + rotates a valid code and returns the book html + fresh code", async () => {
    h.tx = makeFakeTx({
      selects: [
        editionRow,
        [{ id: "c1", leadId: "l1", status: "active", expiresAt: null }],
        [{ email: "ada@example.com" }],
        [{ slug: "page-flip-reader", title: "Reader", format: "page-flip" }],
      ],
      inserts: [[]],
    });
    const res = await redeemAndRotate("page-flip-reader", "good");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.html).toContain("book");
      expect(res.newCode).toHaveLength(26);
      expect(res.leadEmail).toBe("ada@example.com");
      expect(res.editions).toHaveLength(1);
    }
  });
});
