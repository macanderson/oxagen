import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// Same two-call seam as tool.declaration.list.test.ts: count, then page.
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
        where: () => ({
          orderBy: () => ({
            limit: () => ({ offset: () => pop() }),
          }),
          then: (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) => pop().then(resolve, reject),
        }),
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

import { contextRecordListHandler } from "./context.record.list";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

beforeEach(() => {
  mocks.results.length = 0;
});

describe("context.record.list handler", () => {
  it("returns records with status and active-version facts", async () => {
    mocks.results.push(
      () => Promise.resolve([{ total: 1 }]),
      () =>
        Promise.resolve([
          {
            publicId: "ctr_1",
            slug: "no-bare-unwrap",
            title: "No bare unwrap on runtime data",
            status: "active",
            updatedAt: new Date(0),
            versionNumber: 4,
            checksum: "b".repeat(64),
          },
        ]),
    );

    const out = await contextRecordListHandler({ limit: 50, offset: 0 }, CTX);

    expect(out.total).toBe(1);
    expect(out.records).toEqual([
      {
        id: "ctr_1",
        recordId: "no-bare-unwrap",
        title: "No bare unwrap on runtime data",
        status: "active",
        version: 4,
        checksum: "b".repeat(64),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
  });

  it("returns an empty page when the workspace has no records", async () => {
    mocks.results.push(
      () => Promise.resolve([{ total: 0 }]),
      () => Promise.resolve([]),
    );

    const out = await contextRecordListHandler({ limit: 50, offset: 0 }, CTX);

    expect(out).toEqual({ records: [], total: 0 });
  });
});
