/**
 * connection.delete — the handler-side role guard (oxagen#2819).
 *
 * `mode: "full"` marks the connection deleting and dispatches an Inngest job
 * that destroys its ingested graph data. The contract restricts that to an org
 * Owner/Admin or a workspace Owner, and the kernel's IAM gate is where that was
 * meant to be enforced — but checkIAM returns tier_gate -> allow for every org
 * below the enterprise tier, so no policy was consulted. The org and workspace
 * middleware in front of the route check membership, not role.
 *
 * Every refusal case below asserts both halves: the call throws, and none of
 * the three side effects (status update, deletion_jobs row, Inngest dispatch)
 * happens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  /**
   * Rows the guard's membership reads resolve to, in order: the org_users read
   * first, then the workspace_users read. A case that only supplies one entry
   * is saying the second read never happens.
   */
  membershipReads: [] as Array<Array<{ role: string }>>,
}));

vi.mock("./event-client", () => ({
  eventClient: { send: mocks.send },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  maskEmail: (e: string) => e,
}));

/** The connection row the tenant-scoped lookup finds. */
const connectionRows: Array<Record<string, unknown>> = [];

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => connectionRows }),
          }),
        }),
        update: () => ({
          set: (values: unknown) => ({
            where: async () => {
              mocks.update(values);
            },
          }),
        }),
        insert: () => ({
          values: (values: unknown) => ({
            returning: async () => {
              mocks.insert(values);
              return [{ id: "djob-uuid", publicId: "djob_TEST" }];
            },
          }),
        }),
      }),
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => mocks.membershipReads.shift() ?? [],
            }),
          }),
        }),
      }),
  };
});

import { connectionDeleteHandler } from "./connection.delete";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

const INPUT = { connectionId: "con_ABC", mode: "full" as const };

const DENIAL =
  "Forbidden: delete_connection requires org Owner or Admin, or workspace Owner";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membershipReads.length = 0;
  connectionRows.length = 0;
  connectionRows.push({ id: "conn-uuid", status: "active" });
});

/** No side effect of the handler ran. */
function nothingHappened() {
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.insert).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
}

describe("connection.delete requires a role the contract grants", () => {
  it("refuses an org member who is only a workspace member", async () => {
    mocks.membershipReads.push([{ role: "member" }], [{ role: "member" }]);
    await expect(connectionDeleteHandler(INPUT, CTX)).rejects.toThrow(DENIAL);
    nothingHappened();
  });

  it("refuses a viewer", async () => {
    mocks.membershipReads.push([{ role: "viewer" }], [{ role: "viewer" }]);
    await expect(connectionDeleteHandler(INPUT, CTX)).rejects.toThrow(DENIAL);
    nothingHappened();
  });

  it("refuses a caller with no membership row on either side", async () => {
    mocks.membershipReads.push([], []);
    await expect(connectionDeleteHandler(INPUT, CTX)).rejects.toThrow(DENIAL);
    nothingHappened();
  });

  it("refuses an unauthenticated caller before reading anything", async () => {
    await expect(
      connectionDeleteHandler(INPUT, makeCTX({ userId: null })),
    ).rejects.toThrow("connection.delete requires an authenticated user");
    nothingHappened();
  });

  it("allows an org Admin, and the second membership read never happens", async () => {
    mocks.membershipReads.push([{ role: "admin" }]);
    const out = await connectionDeleteHandler(INPUT, CTX);
    expect(out).toMatchObject({
      deletionJobId: "djob_TEST",
      status: "running",
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.membershipReads).toHaveLength(0);
  });

  it("allows a workspace Owner who is an ordinary org member", async () => {
    mocks.membershipReads.push([{ role: "member" }], [{ role: "owner" }]);
    const out = await connectionDeleteHandler(INPUT, CTX);
    expect(out.status).toBe("running");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("accepts a TitleCase membership role — the column carries both casings", async () => {
    mocks.membershipReads.push([{ role: "Admin" }]);
    const out = await connectionDeleteHandler(INPUT, CTX);
    expect(out.status).toBe("running");
  });
});

describe("connection.delete side effects, once the role check passes", () => {
  beforeEach(() => {
    mocks.membershipReads.push([{ role: "owner" }]);
  });

  it("marks the connection deleting, opens a job row, and dispatches", async () => {
    await connectionDeleteHandler(INPUT, CTX);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleting" }),
    );
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-uuid",
        deleteMode: "full",
        status: "running",
        requestedBy: CTX.userId,
      }),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ingestion/connection.delete",
        data: expect.objectContaining({
          connectionId: "conn-uuid",
          deletionJobId: "djob-uuid",
          mode: "full",
        }),
      }),
    );
  });

  it("404s for a connection outside the caller's org/workspace", async () => {
    connectionRows.length = 0;
    await expect(connectionDeleteHandler(INPUT, CTX)).rejects.toThrow(
      "Connection not found",
    );
    nothingHappened();
  });
});
