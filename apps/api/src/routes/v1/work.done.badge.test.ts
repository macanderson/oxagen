// GET /v1/work/done/badge/<token>.svg: the token is the boundary, the verdict
// is read inside the token's tenant scope, and every refusal is one 404.
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doneAttestationKeyFromPem,
  mintDoneBadgeToken,
  renderDoneBadge,
  type DoneAttestationKey,
  type DoneBadgeClaims,
  type DoneBadgeState,
  type DoneVerdict,
} from "@oxagen/done-record/attestation";
import { ATTESTER_KEY_ENV } from "@oxagen/run-ledger/attester-key";

const mocks = vi.hoisted(() => ({
  runInTenantScope: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("../../middleware/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mocks.runInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.withTenantDb,
  // check:db-mock-seams: a mock that replaces the tenant seam replaces the
  // organization seam with the same function.
  withOrgDb: mocks.withTenantDb,
}));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
}));

import { schema } from "@oxagen/database";
import { createWorkDoneBadgeRoute, workDoneBadgeRoute } from "./work.done.badge";

const CLAIMS: DoneBadgeClaims = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  item: "wi_0123456789ABCDEFGHJKMN",
};
const RECORD = `sha256:${"e".repeat(64)}`;

interface Query {
  fields?: unknown;
  table?: unknown;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
}

interface Chain {
  from(table: unknown): Chain;
  where(where: unknown): Chain;
  orderBy(...order: unknown[]): Chain;
  limit(n: number): Promise<unknown[]>;
}

/** A transaction whose selects answer `rows` in order and record each query. */
function fakeTx(rows: unknown[][]) {
  const queries: Query[] = [];
  const tx = {
    select(fields: unknown): Chain {
      const query: Query = { fields };
      queries.push(query);
      const chain: Chain = {
        from(table) {
          query.table = table;
          return chain;
        },
        where(where) {
          query.where = where;
          return chain;
        },
        orderBy(...order) {
          query.orderBy = order;
          return chain;
        },
        limit(n) {
          query.limit = n;
          return Promise.resolve(rows.shift() ?? []);
        },
      };
      return chain;
    },
  };
  return { tx, queries };
}

let key: DoneAttestationKey;
let queries: Query[];

function answer(rows: unknown[][]): void {
  const fake = fakeTx(rows);
  queries = fake.queries;
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => fn(fake.tx));
}

async function get(file: string, route = workDoneBadgeRoute): Promise<Response> {
  return await route.fetch(new Request(`http://localhost/${file}`, { method: "GET" }));
}

beforeAll(() => {
  const pem = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env[ATTESTER_KEY_ENV] = pem;
  key = doneAttestationKeyFromPem(pem);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
  answer([]);
});

async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: "not_found" });
}

describe("GET /v1/work/done/badge/<token>.svg", () => {
  it("draws the latest verdict on the work item's done record", async () => {
    answer([[{ recordDigest: RECORD }], [{ verdict: "held" }]]);
    const res = await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe(renderDoneBadge("held"));

    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: CLAIMS.orgId, workspaceId: CLAIMS.workspaceId },
      expect.any(Function),
    );
    const items = schema.workItems;
    const verdicts = schema.workDoneVerdicts;
    expect(queries).toEqual([
      {
        fields: { recordDigest: items.doneRecordDigest },
        table: items,
        where: {
          and: [
            { eq: [items.orgId, CLAIMS.orgId] },
            { eq: [items.workspaceId, CLAIMS.workspaceId] },
            { eq: [items.publicId, CLAIMS.item] },
            { isNull: items.deletedAt },
          ],
        },
        limit: 1,
      },
      {
        fields: { verdict: verdicts.verdict },
        table: verdicts,
        where: {
          and: [
            { eq: [verdicts.orgId, CLAIMS.orgId] },
            { eq: [verdicts.workspaceId, CLAIMS.workspaceId] },
            { eq: [verdicts.recordDigest, RECORD] },
          ],
        },
        orderBy: [{ desc: verdicts.createdAt }, { desc: verdicts.id }],
        limit: 1,
      },
    ]);
  });

  it.each<DoneVerdict>(["pending", "proven", "broken"])("draws a %s record", async (verdict) => {
    answer([[{ recordDigest: RECORD }], [{ verdict }]]);
    const res = await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(renderDoneBadge(verdict));
  });

  it("draws no record for a work item without a done record, and reads no verdict", async () => {
    answer([[{ recordDigest: null }]]);
    const res = await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(renderDoneBadge("none"));
    expect(queries).toHaveLength(1);
  });

  it("draws no record when the current done record has no verdict yet", async () => {
    answer([[{ recordDigest: RECORD }], []]);
    const res = await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`);
    expect(await res.text()).toBe(renderDoneBadge("none"));
    expect(queries).toHaveLength(2);
  });

  it("refuses a work item the workspace does not hold", async () => {
    answer([[]]);
    await expectNotFound(await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`));
  });

  it("fails loudly on a verdict the table should never hold", async () => {
    answer([[{ recordDigest: RECORD }], [{ verdict: "done" }]]);
    const res = await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`);
    expect(res.status).toBe(500);
  });

  it("refuses a token another key signed, before reading anything", async () => {
    const other = doneAttestationKeyFromPem(
      generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    await expectNotFound(await get(`${mintDoneBadgeToken(CLAIMS, other)}.svg`));
    expect(mocks.runInTenantScope).not.toHaveBeenCalled();
  });

  it.each([
    ["a token without the .svg suffix", () => mintDoneBadgeToken(CLAIMS, key)],
    ["a token with another suffix", () => `${mintDoneBadgeToken(CLAIMS, key)}.png`],
    ["a malformed token", () => "abc.svg"],
  ])("refuses %s", async (_name, file) => {
    await expectNotFound(await get(file()));
    expect(mocks.runInTenantScope).not.toHaveBeenCalled();
  });
});

describe("createWorkDoneBadgeRoute", () => {
  it("refuses every token when no key is set", async () => {
    const readState = vi.fn<(claims: DoneBadgeClaims) => Promise<DoneBadgeState | null>>();
    const route = createWorkDoneBadgeRoute({ signingKey: () => null, readState });
    await expectNotFound(await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`, route));
    expect(readState).not.toHaveBeenCalled();
  });

  it("passes the token's claims to the state reader", async () => {
    const readState = vi
      .fn<(claims: DoneBadgeClaims) => Promise<DoneBadgeState | null>>()
      .mockResolvedValue("proven");
    const route = createWorkDoneBadgeRoute({ signingKey: () => key, readState });
    const res = await get(`${mintDoneBadgeToken(CLAIMS, key)}.svg`, route);
    expect(await res.text()).toBe(renderDoneBadge("proven"));
    expect(readState).toHaveBeenCalledWith(CLAIMS);
  });
});
