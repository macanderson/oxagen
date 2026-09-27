// The GitLab steering reader's head roles. A workspace S1 provisioned carries a
// `steering` head and one bound through `bind_main_repository` carries `main`.
// The reader must find both, or steering on GitLab stops for the first kind.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Every predicate the reader passes to `where`, and the rows the chain answers.
const db = vi.hoisted(() => ({
  whereCalls: [] as unknown[],
  rows: [] as unknown[],
}));
vi.mock("@oxagen/database", async (original) => {
  const real = await original<typeof import("@oxagen/database")>();
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "then"
            ? (resolve: (rows: unknown[]) => void) => resolve(db.rows)
            : (...args: unknown[]) => {
                if (key === "where") db.whereCalls.push(args[0]);
                return chain();
              },
      },
    );
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(chain()),
  };
});

import { readGitLabConnection } from "./context.steering.gitlab";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

describe("readGitLabConnection head roles", () => {
  beforeEach(() => {
    db.whereCalls.length = 0;
    db.rows = [];
  });

  it("asks for a head with either steering role, in one read", async () => {
    await readGitLabConnection(SCOPE);
    expect(db.whereCalls).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(db.whereCalls[0] as SQL);
    expect(query.sql).toMatch(/"role" in \(\$\d+, \$\d+\)/);
    expect(query.params).toEqual(expect.arrayContaining(["main", "steering"]));
    expect(query.params).not.toContain("linked");
  });

  it("answers the bound project the read returns, and null when there is none", async () => {
    const bound = {
      connectionId: "0192d4a8-7c1e-7a00-8000-00000000c011",
      projectId: "4242",
      owner: "acme/platform",
      repo: "rules",
      approvedFullName: "acme/platform/rules",
      approvedDefaultRef: "main",
    };
    db.rows = [bound];
    await expect(readGitLabConnection(SCOPE)).resolves.toEqual(bound);
    db.rows = [];
    await expect(readGitLabConnection(SCOPE)).resolves.toBeNull();
  });
});

describe("readGitLabConnection connection kinds", () => {
  const BOUND = {
    connectionId: "0192d4a8-7c1e-7a00-8000-00000000c011",
    projectId: "4242",
    owner: "acme/platform",
    repo: "rules",
    approvedFullName: "acme/platform/rules",
    approvedDefaultRef: "main",
  };

  beforeEach(() => {
    db.whereCalls.length = 0;
    db.rows = [];
  });

  it("asks for a head on a project connection or a steering connection", async () => {
    await readGitLabConnection(SCOPE);
    const query = new PgDialect().sqlToQuery(db.whereCalls[0] as SQL);
    expect(query.params).toEqual(
      expect.arrayContaining(["gitlab", "gitlab_steering"]),
    );
  });

  it("answers a project connection's head with no group id", async () => {
    db.rows = [{ ...BOUND, connectorId: "gitlab", deliveryConfig: {} }];
    await expect(readGitLabConnection(SCOPE)).resolves.toEqual(BOUND);
  });

  it("carries the group id of a steering project the provisioner bound", async () => {
    db.rows = [
      {
        ...BOUND,
        connectorId: "gitlab_steering",
        deliveryConfig: { groupId: 77, groupPath: "acme" },
      },
    ];
    await expect(readGitLabConnection(SCOPE)).resolves.toEqual({
      ...BOUND,
      steeringGroupId: 77,
    });
  });

  it("reads a group id stored as a string of digits", async () => {
    db.rows = [
      {
        ...BOUND,
        connectorId: "gitlab_steering",
        deliveryConfig: { groupId: "77" },
      },
    ];
    await expect(readGitLabConnection(SCOPE)).resolves.toMatchObject({
      steeringGroupId: 77,
    });
  });

  it.each([
    ["no delivery config", null],
    ["no group id", { groupPath: "acme" }],
    ["a zero group id", { groupId: 0 }],
    ["a group id that is not a number", { groupId: "acme" }],
  ])("refuses a steering connection with %s", async (_label, config) => {
    db.rows = [
      { ...BOUND, connectorId: "gitlab_steering", deliveryConfig: config },
    ];
    await expect(readGitLabConnection(SCOPE)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_group_missing",
    });
  });
});
