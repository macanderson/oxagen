// The runner `@oxagen/handlers/register` installs for the witness's queue
// (ADR-294): each step runs in the event's tenant scope, the queue step reads
// and writes through `withTenantDb`, and the certify step is the witness's
// seam, which leaves every row pending until the witness exists. The queue's
// writes are tested against Postgres in certification.pg.test.ts.
import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  scopes: [] as unknown[],
  inserts: 0,
}));
vi.mock("@oxagen/database", async (original) => {
  const { getScope } = await import("@oxagen/tenancy");
  // A transaction whose revision lookup finds nothing.
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([]),
  };
  const tx = {
    select: () => chain,
    insert: () => {
      db.inserts += 1;
      return chain;
    },
  };
  return {
    ...(await original<typeof import("@oxagen/database")>()),
    withTenantDb: (fn: (t: typeof tx) => unknown) => {
      db.scopes.push(getScope());
      return fn(tx);
    },
  };
});

import { getScope } from "@oxagen/tenancy";
import { certifyRevision, forgeCertificationRunner } from "./certification";

const REQUEST = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  pullRequestId: "0192d4a8-7c1e-7a00-8000-0000000c0f01",
  revisionId: "0192d4a8-7c1e-7a00-8000-0000000c0f02",
  provider: "github" as const,
  repository: "acme/api",
  number: 42,
  headSha: "a".repeat(40),
  diffKey: "pr-diffs/o/w/github/991/42/aaaa.diff",
  diffSha256: "c".repeat(64),
};

describe("the certification runner", () => {
  it("queues in the event's tenant scope, and writes nothing for a revision the scope lacks", async () => {
    await expect(forgeCertificationRunner().queue(REQUEST)).resolves.toEqual({
      outcome: "gone",
      certificationId: null,
      state: null,
    });
    expect(db.scopes).toEqual([
      expect.objectContaining({
        orgId: REQUEST.orgId,
        workspaceId: REQUEST.workspaceId,
      }),
    ]);
    expect(db.inserts).toBe(0);
  });

  it("leaves the row pending until the witness exists, and says why", async () => {
    await expect(
      forgeCertificationRunner().certify(REQUEST, "rcf_1"),
    ).resolves.toEqual({ state: "pending", reason: "witness_not_built" });
    await expect(certifyRevision(REQUEST, "rcf_1")).resolves.toEqual({
      state: "pending",
      reason: "witness_not_built",
    });
    // The runner left no scope behind it.
    expect(getScope()).toBeNull();
  });
});
