import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues two withTenantDb calls in a fixed order: the count
// (select…where, no pagination) and the page (select…leftJoin…where…orderBy
// …limit…offset). One queue serves both; each builder is awaitable at the
// chain tail it actually reaches.
const mocks = vi.hoisted(() => ({
  results: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const pop = () => {
    const next = mocks.results.shift();
    return next ? next() : Promise.resolve([]);
  };
  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: () => {
          const page = {
            orderBy: () => ({
              limit: () => ({ offset: () => pop() }),
            }),
            then: (
              resolve: (v: unknown) => unknown,
              reject: (e: unknown) => unknown,
            ) => pop().then(resolve, reject),
          };
          return page;
        },
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({ offset: () => pop() }),
            }),
          }),
        }),
      }),
    }),
  });

  return {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

import { toolDeclarationListHandler } from "./tool.declaration.list";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const ROW = {
  publicId: "tol_1",
  slug: "read_file",
  name: "read_file",
  description: "Read a file",
  source: "builtin",
  enabled: true,
  updatedAt: new Date(0),
  readOnly: true,
  riskGrade: "low",
  policyGroup: null,
  versionNumber: 2,
  checksum: "a".repeat(64),
};

beforeEach(() => {
  mocks.results.length = 0;
});

describe("tool.declaration.list handler", () => {
  it("returns declarations with their active-version facts", async () => {
    mocks.results.push(
      () => Promise.resolve([{ total: 1 }]),
      () => Promise.resolve([ROW]),
    );

    const out = await toolDeclarationListHandler({ limit: 50, offset: 0 }, CTX);

    expect(out.total).toBe(1);
    expect(out.tools).toEqual([
      {
        id: "tol_1",
        slug: "read_file",
        name: "read_file",
        description: "Read a file",
        source: "builtin",
        enabled: true,
        readOnly: true,
        riskGrade: "low",
        policyGroup: null,
        version: 2,
        checksum: "a".repeat(64),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
  });

  it("nulls the version facts when no active version is pinned", async () => {
    mocks.results.push(
      () => Promise.resolve([{ total: 1 }]),
      () =>
        Promise.resolve([
          {
            ...ROW,
            readOnly: null,
            riskGrade: null,
            policyGroup: null,
            versionNumber: null,
            checksum: null,
          },
        ]),
    );

    const out = await toolDeclarationListHandler({ limit: 50, offset: 0 }, CTX);

    expect(out.tools[0]).toMatchObject({
      readOnly: null,
      riskGrade: null,
      version: null,
      checksum: null,
    });
  });

  it("returns an empty page when the workspace has no declarations", async () => {
    mocks.results.push(
      () => Promise.resolve([{ total: 0 }]),
      () => Promise.resolve([]),
    );

    const out = await toolDeclarationListHandler({ limit: 50, offset: 0 }, CTX);

    expect(out).toEqual({ tools: [], total: 0 });
  });
});
