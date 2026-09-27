// The GitLab steering reader's head role. Every head that steers carries role
// `steering`, and a linked head never steers.
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

  it("asks for a head with the steering role, in one read", async () => {
    await readGitLabConnection(SCOPE);
    expect(db.whereCalls).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(db.whereCalls[0] as SQL);
    expect(query.sql).toMatch(/"role" in \(\$\d+\)/);
    expect(query.params).toContain("steering");
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
