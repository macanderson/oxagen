import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { sha256Hex } from "./registry-digest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// Same seam as tool.declaration.publish.test.ts: one queue for every
// select(...).where(...).limit(1), dedicated spies for the transaction's
// inserts and updates.
const mocks = vi.hoisted(() => ({
  selectResults: [] as Array<() => Promise<unknown>>,
  insertReturning: [] as Array<() => Promise<unknown>>,
  insertedValues: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const next = mocks.selectResults.shift();
            return next ? next() : Promise.resolve([]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (vals: unknown) => {
        mocks.insertedValues.push(vals as Record<string, unknown>);
        const next = mocks.insertReturning.shift();
        return {
          returning: () =>
            next ? next() : Promise.resolve([{ id: "uuid-generated" }]),
        };
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

import { contextRecordPublishHandler } from "./context.record.publish";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const INPUT = {
  record_id: "No-Bare-Unwrap",
  title: "No bare unwrap on runtime data",
  body: 'id = "no-bare-unwrap"\n',
  provenance: [{ type: "file", uri: ".stella/rules/no-bare-unwrap.toml" }],
};

const BODY_CHECKSUM = sha256Hex(INPUT.body);

function queueSelects(...results: unknown[]): void {
  for (const r of results) {
    mocks.selectResults.push(() => Promise.resolve(r));
  }
}

beforeEach(() => {
  mocks.selectResults.length = 0;
  mocks.insertReturning.length = 0;
  mocks.insertedValues.length = 0;
  mocks.updateSets.length = 0;
});

describe("context.record.publish handler", () => {
  it("registers a fresh record as version 1 with the body checksum", async () => {
    queueSelects([]); // no existing record
    mocks.insertReturning.push(
      () =>
        Promise.resolve([
          { id: "record-uuid", publicId: "ctr_new", slug: "no-bare-unwrap" },
        ]),
      () => Promise.resolve([{ id: "version-uuid" }]),
    );

    const out = await contextRecordPublishHandler(INPUT, CTX);

    expect(out).toEqual({
      publicId: "ctr_new",
      recordId: "no-bare-unwrap",
      version: 1,
      checksum: BODY_CHECKSUM,
      published: true,
    });
    // The record id is lowercased into the slug; provenance rides the version.
    expect(mocks.insertedValues[0]).toMatchObject({
      slug: "no-bare-unwrap",
      status: "active",
    });
    expect(mocks.insertedValues[1]).toMatchObject({
      recordId: "record-uuid",
      versionNumber: 1,
      isLatest: true,
      checksum: BODY_CHECKSUM,
      provenance: INPUT.provenance,
    });
    expect(mocks.updateSets.at(-1)).toMatchObject({
      activeVersionId: "version-uuid",
    });
  });

  it("is idempotent when the latest version already carries the checksum", async () => {
    queueSelects(
      [{ id: "record-uuid", publicId: "ctr_1", slug: "no-bare-unwrap" }],
      [{ id: "v1-uuid", versionNumber: 2, checksum: BODY_CHECKSUM }],
    );

    const out = await contextRecordPublishHandler(INPUT, CTX);

    expect(out).toEqual({
      publicId: "ctr_1",
      recordId: "no-bare-unwrap",
      version: 2,
      checksum: BODY_CHECKSUM,
      published: false,
    });
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it("publishes latest+1 when the body changed", async () => {
    queueSelects(
      [{ id: "record-uuid", publicId: "ctr_1", slug: "no-bare-unwrap" }],
      [{ id: "v1-uuid", versionNumber: 1, checksum: "0".repeat(64) }],
    );
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v2-uuid" }]));

    const out = await contextRecordPublishHandler(INPUT, CTX);

    expect(out.version).toBe(2);
    expect(out.published).toBe(true);
    expect(mocks.updateSets[0]).toMatchObject({ isLatest: false });
    expect(mocks.insertedValues[0]).toMatchObject({
      versionNumber: 2,
      parentVersionId: "v1-uuid",
      checksum: BODY_CHECKSUM,
    });
  });

  it("requires a workspace scope", async () => {
    await expect(
      contextRecordPublishHandler(INPUT, {
        ...CTX,
        workspaceId: undefined as unknown as string,
      }),
    ).rejects.toThrow(/workspaceId is required/);
  });
});
