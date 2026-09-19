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

const provisional = vi.hoisted(() => ({
  assertWorkspaceNotProvisional: vi.fn(),
}));
vi.mock("./lib/onboarding", () => ({
  assertWorkspaceNotProvisional: provisional.assertWorkspaceNotProvisional,
}));

import { HandlerError, isHandlerError } from "@oxagen/oxagen";
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
  kind: "rule" as const,
  force: "must" as const,
  statement:
    "Never unwrap a Result on runtime data without handling the error.",
  provenance: [{ type: "file", uri: ".stella/rules/no-bare-unwrap.toml" }],
};

const BODY_CHECKSUM = sha256Hex(INPUT.body);

// What the latest version row looks like once this handler has written it:
// the body checksum plus the classification the caller supplied.
const LATEST_MATCHING = {
  id: "v1-uuid",
  versionNumber: 2,
  checksum: BODY_CHECKSUM,
  kind: "rule",
  force: "must",
  constraintEffect: null,
  statement: INPUT.statement,
};

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
  provisional.assertWorkspaceNotProvisional.mockReset();
  provisional.assertWorkspaceNotProvisional.mockResolvedValue(undefined);
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
    // Both rows carry the caller's classification (#3302) — a record this
    // handler writes can never have a NULL kind or force.
    expect(mocks.insertedValues[0]).toMatchObject({
      slug: "no-bare-unwrap",
      status: "active",
      kind: "rule",
      force: "must",
      constraintEffect: null,
      statement: INPUT.statement,
    });
    expect(mocks.insertedValues[1]).toMatchObject({
      recordId: "record-uuid",
      versionNumber: 1,
      isLatest: true,
      checksum: BODY_CHECKSUM,
      provenance: INPUT.provenance,
      kind: "rule",
      force: "must",
      constraintEffect: null,
      statement: INPUT.statement,
    });
    expect(mocks.updateSets.at(-1)).toMatchObject({
      activeVersionId: "version-uuid",
    });
  });

  it("is idempotent when the latest version already carries the checksum and classification", async () => {
    queueSelects(
      [{ id: "record-uuid", publicId: "ctr_1", slug: "no-bare-unwrap" }],
      [LATEST_MATCHING],
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
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("publishes latest+1 when only the classification changed on an unchanged body", async () => {
    // A record backfilled to memory/info, or one published with the wrong
    // force: the checksum matches, so before this check the correction was
    // reported as `published: false` and the record stayed invisible to
    // `readWorkspaceSteering`.
    queueSelects(
      [{ id: "record-uuid", publicId: "ctr_1", slug: "no-bare-unwrap" }],
      [{ ...LATEST_MATCHING, kind: "memory", force: "should" }],
    );
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v3-uuid" }]));

    const out = await contextRecordPublishHandler(INPUT, CTX);

    expect(out).toMatchObject({ version: 3, published: true });
    expect(mocks.updateSets[0]).toMatchObject({ isLatest: false });
    expect(mocks.insertedValues[0]).toMatchObject({
      versionNumber: 3,
      parentVersionId: "v1-uuid",
      checksum: BODY_CHECKSUM,
      kind: "rule",
      force: "must",
      statement: INPUT.statement,
    });
    expect(mocks.updateSets.at(-1)).toMatchObject({
      activeVersionId: "v3-uuid",
      kind: "rule",
      force: "must",
    });
  });

  it("publishes latest+1 onto a legacy version whose classification is NULL", async () => {
    // Versions written before #3302 carry no classification at all.
    queueSelects(
      [{ id: "record-uuid", publicId: "ctr_1", slug: "no-bare-unwrap" }],
      [
        {
          id: "v1-uuid",
          versionNumber: 1,
          checksum: BODY_CHECKSUM,
          kind: null,
          force: null,
          constraintEffect: null,
          statement: null,
        },
      ],
    );
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v2-uuid" }]));

    const out = await contextRecordPublishHandler(INPUT, CTX);

    expect(out).toMatchObject({ version: 2, published: true });
    expect(mocks.insertedValues[0]).toMatchObject({
      versionNumber: 2,
      kind: "rule",
      force: "must",
      statement: INPUT.statement,
    });
  });

  it("publishes latest+1 when the body changed", async () => {
    queueSelects(
      [{ id: "record-uuid", publicId: "ctr_1", slug: "no-bare-unwrap" }],
      [{ ...LATEST_MATCHING, versionNumber: 1, checksum: "0".repeat(64) }],
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
      kind: "rule",
      force: "must",
      statement: INPUT.statement,
    });
    // The record row's classification moves with the new version, the same
    // way `promote_context_record` and `merge_context_pr` keep the pin's
    // classification in sync (#3312).
    expect(mocks.updateSets.at(-1)).toMatchObject({
      activeVersionId: "v2-uuid",
      kind: "rule",
      force: "must",
      statement: INPUT.statement,
    });
  });

  it("requires a constraint effect on a constraint kind and rejects one on any other kind", async () => {
    const { contextRecordPublish } = await import(
      "@oxagen/oxagen/contracts/context.record.publish"
    );
    expect(() =>
      contextRecordPublish.input.parse({ ...INPUT, kind: "constraint" }),
    ).toThrow();
    expect(() =>
      contextRecordPublish.input.parse({
        ...INPUT,
        constraintEffect: "forbid",
      }),
    ).toThrow();
  });

  it("refuses a provisional workspace before touching the registry (#2967)", async () => {
    provisional.assertWorkspaceNotProvisional.mockRejectedValueOnce(
      new HandlerError({ code: "conflict", reason: "provisional" }),
    );
    await expect(contextRecordPublishHandler(INPUT, CTX)).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "conflict" &&
        e.reason === "provisional",
    );
    expect(provisional.assertWorkspaceNotProvisional).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
    expect(mocks.insertedValues).toEqual([]);
    expect(mocks.updateSets).toEqual([]);
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
