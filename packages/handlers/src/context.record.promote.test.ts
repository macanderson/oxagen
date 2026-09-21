import { describe, expect, it, vi, beforeEach } from "vitest";

// Authorization behavior is exercised with real guards in role-enforcement.regression.test.ts.
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(
    async (ctx: { userId: string | null }) => ctx.userId,
  ),
}));
import type { CapabilityContext } from "@oxagen/oxagen";
import { canonicalJson, sha256Hex } from "./registry-digest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues withTenantDb calls in a fixed order:
//   1. record lookup    → select(...).where(...).limit(1)
//   2. (version_id set) version lookup → select(...).where(...).limit(1)
//   3. chain head       → select(...).where(...).orderBy(...).limit(1)
//   4. transaction      → insert promotion .values(); update record .set()
//
// A version lookup is preceded by the deploy-before-migrate probe, which runs
// `execute` rather than `select` and so consumes none of the queued results.
const mocks = vi.hoisted(() => ({
  selectResults: [] as Array<() => Promise<unknown>>,
  insertedValues: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  /** Whether migration `20260918160000` has run on this database. */
  classificationColumns: true,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const pop = () => {
    const next = mocks.selectResults.shift();
    return next ? next() : Promise.resolve([]);
  };
  const makeTx = () => ({
    // The column probe. `hasColumn` reads presence from the row count, so an
    // empty array is "the migration has not run".
    execute: () =>
      Promise.resolve(mocks.classificationColumns ? [{ "?column?": 1 }] : []),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => pop(),
          for: () => ({ limit: () => pop() }),
          orderBy: () => ({ limit: () => pop() }),
        }),
      }),
    }),
    insert: () => ({
      values: (vals: unknown) => {
        mocks.insertedValues.push(vals as Record<string, unknown>);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (vals: unknown) => {
        mocks.updateSets.push(vals as Record<string, unknown>);
        return { where: () => Promise.resolve() };
      },
    }),
  });

  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { resetColumnProbesForTests } from "@oxagen/database";
import { contextRecordPromoteHandler } from "./context.record.promote";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const RECORD = {
  id: "record-uuid",
  publicId: "ctr_1",
  status: "active",
  validUntil: null,
};

function queueSelects(...results: unknown[]): void {
  for (const r of results) {
    mocks.selectResults.push(() => Promise.resolve(r));
  }
}

function expectedDigest(
  prev: string | null,
  row: {
    action: string;
    seq: number;
    version_id: string | null;
    policy_version: string;
  },
): string {
  return sha256Hex(
    (prev ?? "") +
      canonicalJson({
        action: row.action,
        approver_user_id: "u_1",
        policy_version: row.policy_version,
        record_id: RECORD.id,
        seq: row.seq,
        version_id: row.version_id,
      }),
  );
}

beforeEach(() => {
  mocks.selectResults.length = 0;
  mocks.insertedValues.length = 0;
  mocks.updateSets.length = 0;
  mocks.classificationColumns = true;
  // The probe answers once per process per plane, so a test that runs without
  // the columns would otherwise decide it for every test after it.
  resetColumnProbesForTests();
});

describe("context.record.promote handler", () => {
  it("starts the chain at seq 1 with a null prev digest", async () => {
    queueSelects(
      [
        {
          ...RECORD,
          status: "retired",
          validUntil: new Date("2026-09-20T00:00:00Z"),
        },
      ],
      [{ id: "version-uuid" }],
      [],
    ); // No chain head in this legacy fixture.

    const out = await contextRecordPromoteHandler(
      {
        record_id: "no-bare-unwrap",
        action: "promote",
        version_id: "crv_1",
        policy_version: "regulated-1",
      },
      CTX,
    );

    const digest = expectedDigest(null, {
      action: "promote",
      seq: 1,
      version_id: "version-uuid",
      policy_version: "regulated-1",
    });
    expect(out).toEqual({
      recordId: "ctr_1",
      action: "promote",
      seq: 1,
      chainDigest: digest,
      status: "active",
      validUntil: null,
    });
    expect(mocks.insertedValues[0]).toMatchObject({
      recordId: RECORD.id,
      versionId: "version-uuid",
      seq: 1,
      prevChainDigest: null,
      chainDigest: digest,
    });
    // A promote pins the version onto the record row.
    expect(mocks.updateSets[0]).toMatchObject({
      status: "active",
      activeVersionId: "version-uuid",
      validUntil: null,
    });
    // A legacy version carries no classification, so the row keeps its own.
    expect(mocks.updateSets[0]).not.toHaveProperty("kind");
    expect(mocks.updateSets[0]).not.toHaveProperty("force");
    expect(mocks.updateSets[0]).not.toHaveProperty("statement");
  });

  // The witness for #3312: with v2 in service, promoting v1 must leave the
  // row saying what v1 says, in the same update that moves the pin.
  it("copies the pinned version's classification onto the record row, clearing a constraint effect the row no longer earns", async () => {
    const v1 = {
      kind: "rule",
      force: "should",
      constraintEffect: null,
      statement: "Prefer the narrowest test that proves the change.",
    };
    // The chain head is v2's promote: the row currently carries v2's
    // classification (a must constraint), which is what the bug left behind.
    //
    // Four reads now, in this order: the record, the version lookup (id and
    // ownership only), the chain head, and -- inside the writing transaction --
    // the pinned version's classification.
    queueSelects(
      [RECORD],
      [{ id: "version-1" }],
      [{ seq: 2, chainDigest: "d".repeat(64) }],
      [v1],
    );

    const out = await contextRecordPromoteHandler(
      {
        record_id: "ctr_1",
        action: "promote",
        version_id: "crv_1",
        policy_version: "regulated-1",
      },
      CTX,
    );

    expect(out).toMatchObject({ action: "promote", seq: 3, status: "active" });
    expect(mocks.updateSets).toHaveLength(1);
    expect(mocks.updateSets[0]).toMatchObject({
      status: "active",
      activeVersionId: "version-1",
      kind: "rule",
      force: "should",
      constraintEffect: null,
      statement: "Prefer the narrowest test that proves the change.",
    });
    // A promote is one more ledger row, which is what moves the steering
    // version the bundle cache is keyed on.
    expect(mocks.insertedValues[0]).toMatchObject({
      action: "promote",
      versionId: "version-1",
      seq: 3,
    });
  });

  // Production applies migrations by hand while `deploy-node` ships on merge,
  // so the handler is live on a database without the four columns for as long
  // as that window lasts. Naming one then raises 42703 and the promote fails
  // outright -- the operator cannot move the pin at all.
  it("still moves the pin while migration 20260918160000 is pending, leaving the row's classification alone", async () => {
    mocks.classificationColumns = false;
    // Only three reads: with the columns missing the classification select is
    // never issued, so nothing names them and none can raise 42703.
    queueSelects(
      [RECORD],
      [{ id: "version-1" }],
      [{ seq: 2, chainDigest: "d".repeat(64) }],
    );

    const out = await contextRecordPromoteHandler(
      {
        record_id: "ctr_1",
        action: "promote",
        version_id: "crv_1",
        policy_version: "regulated-1",
      },
      CTX,
    );

    expect(out).toMatchObject({ action: "promote", seq: 3, status: "active" });
    expect(mocks.updateSets[0]).toMatchObject({
      status: "active",
      activeVersionId: "version-1",
    });
    // The row keeps what it has: on a database whose versions cannot carry a
    // classification, the row's copy is the only one there is.
    expect(mocks.updateSets[0]).not.toHaveProperty("kind");
    expect(mocks.updateSets[0]).not.toHaveProperty("statement");
  });

  // The classification is read in the transaction that writes it, not in the
  // version lookup, because that lookup commits first. A migration landing in
  // between used to leave the pin moved and the classification uncopied, so
  // the row described the PREVIOUSLY active version -- and nothing guarantees
  // anyone ever promotes again to correct it (discussion_r4050583312).
  it("reads the classification after the lookup, so a migration landing in between is still seen", async () => {
    mocks.classificationColumns = false;
    mocks.selectResults.push(
      () => Promise.resolve([RECORD]),
      // The version lookup. The migration lands as it returns: on the old
      // code the probe had already run by now and the answer was no.
      () => {
        mocks.classificationColumns = true;
        return Promise.resolve([{ id: "version-1" }]);
      },
      () => Promise.resolve([{ seq: 2, chainDigest: "d".repeat(64) }]),
      () =>
        Promise.resolve([
          {
            kind: "rule",
            force: "should",
            constraintEffect: null,
            statement: "What the pinned version says.",
          },
        ]),
    );

    await contextRecordPromoteHandler(
      {
        record_id: "ctr_1",
        action: "promote",
        version_id: "crv_1",
        policy_version: "regulated-1",
      },
      CTX,
    );

    expect(mocks.updateSets[0]).toMatchObject({
      activeVersionId: "version-1",
      kind: "rule",
      force: "should",
      statement: "What the pinned version says.",
    });
  });

  it("leaves the row's classification alone when a supersede names a classified version", async () => {
    // A supersede reads no classification: only a promote copies one, so the
    // version lookup is the id-and-ownership read and nothing follows it.
    queueSelects(
      [RECORD],
      [{ id: "version-2" }],
      [{ seq: 1, chainDigest: "e".repeat(64) }],
    );

    await contextRecordPromoteHandler(
      {
        record_id: "ctr_1",
        action: "supersede",
        version_id: "crv_2",
        policy_version: "regulated-1",
      },
      CTX,
    );

    expect(mocks.updateSets[0]).toMatchObject({ status: "superseded" });
    expect(mocks.updateSets[0]).not.toHaveProperty("activeVersionId");
    expect(mocks.updateSets[0]).not.toHaveProperty("kind");
  });

  it("chains a later entry off the head's digest", async () => {
    const prev = "c".repeat(64);
    queueSelects([RECORD], [{ seq: 4, chainDigest: prev }]); // no version lookup (retire)

    const out = await contextRecordPromoteHandler(
      {
        record_id: "ctr_1",
        action: "retire",
        policy_version: "regulated-1",
      },
      CTX,
    );

    const digest = expectedDigest(prev, {
      action: "retire",
      seq: 5,
      version_id: null,
      policy_version: "regulated-1",
    });
    expect(out).toEqual({
      recordId: "ctr_1",
      action: "retire",
      seq: 5,
      chainDigest: digest,
      status: "retired",
      validUntil: expect.any(String),
    });
    expect(mocks.insertedValues[0]).toMatchObject({
      seq: 5,
      prevChainDigest: prev,
    });
    // A retire never touches the pinned version.
    expect(mocks.updateSets[0]).not.toHaveProperty("activeVersionId");
    expect(mocks.updateSets[0]).toMatchObject({ status: "retired" });
  });

  it("rejects a promote without a version_id", async () => {
    queueSelects([RECORD]);

    await expect(
      contextRecordPromoteHandler(
        {
          record_id: "ctr_1",
          action: "promote",
          policy_version: "regulated-1",
        },
        CTX,
      ),
    ).rejects.toThrow(/version_id.*required/);
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it("rejects a version that does not belong to the record", async () => {
    queueSelects([RECORD], []); // version lookup misses

    await expect(
      contextRecordPromoteHandler(
        {
          record_id: "ctr_1",
          action: "promote",
          version_id: "crv_other",
          policy_version: "regulated-1",
        },
        CTX,
      ),
    ).rejects.toThrow(/does not belong/);
  });

  it("rejects an unknown record", async () => {
    queueSelects([]);

    await expect(
      contextRecordPromoteHandler(
        {
          record_id: "missing",
          action: "retire",
          policy_version: "regulated-1",
        },
        CTX,
      ),
    ).rejects.toThrow(/not found/);
  });
});

it("keeps the first retirement date and chain head on repeat", async () => {
  const validUntil = new Date("2026-09-20T12:00:00.000Z");
  queueSelects(
    [{ ...RECORD, status: "retired", validUntil }],
    [{ seq: 3, chainDigest: "last", action: "retire" }],
  );
  const out = await contextRecordPromoteHandler(
    { record_id: "ctr_1", action: "retire", policy_version: "v1" },
    CTX,
  );
  expect(out).toEqual({
    recordId: "ctr_1",
    action: "retire",
    seq: 3,
    chainDigest: "last",
    status: "retired",
    validUntil: validUntil.toISOString(),
  });
  expect(mocks.insertedValues).toEqual([]);
  expect(mocks.updateSets).toEqual([]);
});

it("closes validity without changing the historical version or identity", async () => {
  queueSelects([RECORD], []);
  const out = await contextRecordPromoteHandler(
    { record_id: "ctr_1", action: "retire", policy_version: "v1" },
    CTX,
  );
  expect(mocks.updateSets[0]).toMatchObject({
    status: "retired",
    validUntil: new Date(out.validUntil ?? ""),
  });
  expect(mocks.updateSets[0]).not.toHaveProperty("activeVersionId");
  expect(mocks.updateSets[0]).not.toHaveProperty("slug");
  expect(mocks.updateSets[0]).not.toHaveProperty("deletedAt");
});
