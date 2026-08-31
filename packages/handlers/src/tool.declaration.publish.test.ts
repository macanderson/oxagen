import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { canonicalJson, sha256Hex } from "./registry-digest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues withTenantDb calls in a fixed order:
//   Fresh publish:
//     1. existing-check  → select(...).where(...).limit(1)                → []
//     2. transaction     → insert tool .returning(); insert version
//                          .returning(); update tools .set().where()
//   Existing tool:
//     1. existing-check  → select(...).where(...).limit(1)                → [toolRow]
//     2. latest-version  → select(...).where(...).limit(1)                → [latest?]
//     3. (changed only) transaction → update version; insert version
//                          .returning(); update tools
// Every select shares one queue; the transaction call gets a builder whose
// inserts/updates resolve via dedicated spies so ordering and shapes can be
// asserted (same seam as skill.workspace.install.test.ts).
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

import { toolDeclarationPublishHandler } from "./tool.declaration.publish";

// ── fixtures ──────────────────────────────────────────────────────────────────
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
  name: "Read_File",
  description: "Read a file from the workspace",
  input_schema: { type: "object" },
  read_only: true,
  risk_grade: "low" as const,
  policy_group: undefined,
  source: "builtin" as const,
  manifest: { name: "read_file" },
};

const EXPECTED_CHECKSUM = sha256Hex(
  canonicalJson({
    description: INPUT.description,
    input_schema: INPUT.input_schema,
    manifest: INPUT.manifest,
    name: "read_file",
    policy_group: null,
    read_only: true,
    risk_grade: "low",
    source: "builtin",
  }),
);

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

describe("tool.declaration.publish handler", () => {
  it("registers a fresh declaration as version 1 with the canonical checksum", async () => {
    queueSelects([]); // no existing tool
    mocks.insertReturning.push(
      () =>
        Promise.resolve([
          { id: "tool-uuid", publicId: "tol_new", slug: "read_file" },
        ]),
      () => Promise.resolve([{ id: "version-uuid" }]),
    );

    const out = await toolDeclarationPublishHandler(INPUT, CTX);

    expect(out).toEqual({
      publicId: "tol_new",
      slug: "read_file",
      version: 1,
      checksum: EXPECTED_CHECKSUM,
      published: true,
    });
    // The name is lowercased into the slug; the version row carries the facts.
    expect(mocks.insertedValues[0]).toMatchObject({ slug: "read_file" });
    expect(mocks.insertedValues[1]).toMatchObject({
      toolId: "tool-uuid",
      versionNumber: 1,
      isLatest: true,
      readOnly: true,
      riskGrade: "low",
      checksum: EXPECTED_CHECKSUM,
    });
    // The identity row is backfilled with the pinned active version.
    expect(mocks.updateSets.at(-1)).toMatchObject({
      activeVersionId: "version-uuid",
    });
  });

  it("is idempotent when the latest version already carries the checksum", async () => {
    queueSelects(
      [{ id: "tool-uuid", publicId: "tol_1", slug: "read_file" }],
      [{ id: "v1-uuid", versionNumber: 3, checksum: EXPECTED_CHECKSUM }],
    );

    const out = await toolDeclarationPublishHandler(INPUT, CTX);

    expect(out).toEqual({
      publicId: "tol_1",
      slug: "read_file",
      version: 3,
      checksum: EXPECTED_CHECKSUM,
      published: false,
    });
    expect(mocks.insertedValues).toHaveLength(0);
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("publishes latest+1 and demotes the previous latest when the checksum changed", async () => {
    queueSelects(
      [{ id: "tool-uuid", publicId: "tol_1", slug: "read_file" }],
      [{ id: "v2-uuid", versionNumber: 2, checksum: "0".repeat(64) }],
    );
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v3-uuid" }]));

    const out = await toolDeclarationPublishHandler(INPUT, CTX);

    expect(out.version).toBe(3);
    expect(out.published).toBe(true);
    // First update demotes the previous latest, then the version insert, then
    // the identity-row repoint.
    expect(mocks.updateSets[0]).toMatchObject({ isLatest: false });
    expect(mocks.insertedValues[0]).toMatchObject({
      versionNumber: 3,
      parentVersionId: "v2-uuid",
      checksum: EXPECTED_CHECKSUM,
    });
    expect(mocks.updateSets[1]).toMatchObject({ activeVersionId: "v3-uuid" });
  });

  it("requires a workspace scope", async () => {
    await expect(
      toolDeclarationPublishHandler(INPUT, {
        ...CTX,
        workspaceId: undefined as unknown as string,
      }),
    ).rejects.toThrow(/workspaceId is required/);
  });
});
