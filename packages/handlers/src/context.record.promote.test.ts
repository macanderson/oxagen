import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { canonicalJson, sha256Hex } from "./registry-digest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues withTenantDb calls in a fixed order:
//   1. record lookup    → select(...).where(...).limit(1)
//   2. (version_id set) version lookup → select(...).where(...).limit(1)
//   3. chain head       → select(...).where(...).orderBy(...).limit(1)
//   4. transaction      → insert promotion .values(); update record .set()
const mocks = vi.hoisted(() => ({
  selectResults: [] as Array<() => Promise<unknown>>,
  insertedValues: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const pop = () => {
    const next = mocks.selectResults.shift();
    return next ? next() : Promise.resolve([]);
  };
  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => pop(),
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

  return {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

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

const RECORD = { id: "record-uuid", publicId: "ctr_1" };

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
});

describe("context.record.promote handler", () => {
  it("starts the chain at seq 1 with a null prev digest", async () => {
    queueSelects([RECORD], [{ id: "version-uuid" }], []); // no chain head yet

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
    });
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
