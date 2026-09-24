// The GitLab webhook's real dependencies (#3762), against a recording
// transaction. The predicates matter more than the rows: the proposal lookup
// must name the GitLab host, or a merge request closed on GitLab as !7 would
// reject an open proposal whose GitHub pull request is #7.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  wheres: [] as unknown[],
  rows: [] as unknown[],
  updateProposal: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: (w: unknown) => {
          mocks.wheres.push(w);
          return chain;
        },
        limit: async () => mocks.rows,
      };
      return chain;
    },
  };
  const run = async (fn: (t: unknown) => unknown) => fn(tx);
  return { ...real, withTenantDb: run, withSystemDb: run, withOrgDb: run };
});
vi.mock("./context.steering.store", () => ({
  postgresSteeringStore: { updateProposal: mocks.updateProposal },
}));

import { HandlerError } from "@oxagen/oxagen";
import { gitlabWebhookDeps } from "./gitlab.webhook";

const dialect = new PgDialect();
const sqlOf = (w: unknown) => dialect.sqlToQuery(w as SQL);
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

beforeEach(() => {
  mocks.wheres.length = 0;
  mocks.rows = [];
  mocks.updateProposal.mockReset();
});

describe("gitlabWebhookDeps", () => {
  it("finds an open proposal only on the GitLab host, in this workspace, by IID", async () => {
    mocks.rows = [{ id: "p-7", publicId: "prp_7" }];
    await expect(
      gitlabWebhookDeps().findOpenProposal(SCOPE, 7),
    ).resolves.toEqual({ id: "p-7", publicId: "prp_7" });
    const { sql, params } = sqlOf(mocks.wheres[0]);
    expect(sql).toContain('"provider" = $');
    expect(sql).toContain('"pr_number" = $');
    expect(sql).toContain('"org_id" = $');
    expect(sql).toContain('"workspace_id" = $');
    expect(sql).toContain('"status" in (');
    expect(params).toEqual(
      expect.arrayContaining([
        "gitlab",
        7,
        SCOPE.orgId,
        SCOPE.workspaceId,
        "pr_open",
        "checks_passed",
      ]),
    );
  });

  it("looks a connection up only among live GitLab connections", async () => {
    await expect(
      gitlabWebhookDeps().findConnection("con_gl1"),
    ).resolves.toBeNull();
    const { sql, params } = sqlOf(mocks.wheres[0]);
    expect(sql).toContain('"connector_id" = $');
    expect(sql).toContain('"deleted_at" is null');
    expect(sql).toContain('"status" not in (');
    expect(params).toEqual(
      expect.arrayContaining(["con_gl1", "gitlab", "deleting", "deleted"]),
    );
  });

  it("answers no connection for a row whose delivery config is not a GitLab one", async () => {
    mocks.rows = [
      {
        id: "c",
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        deliveryConfig: { installationId: "555" },
        encryptedPayload: { keyId: "k", ciphertext: "x" },
      },
    ];
    await expect(
      gitlabWebhookDeps().findConnection("con_gl1"),
    ).resolves.toBeNull();
  });

  it("rejects an open proposal, and reports one that already moved as false", async () => {
    const deps = gitlabWebhookDeps();
    mocks.updateProposal.mockResolvedValueOnce({});
    await expect(
      deps.rejectProposal("p-7", "closed", new Date(0)),
    ).resolves.toBe(true);
    expect(mocks.updateProposal).toHaveBeenCalledWith(
      "p-7",
      {
        status: "rejected",
        dismissedAt: new Date(0),
        dismissedReason: "closed",
      },
      ["pr_open", "checks_running", "checks_passed", "checks_failed"],
    );
    mocks.updateProposal.mockRejectedValueOnce(
      new HandlerError({ code: "conflict", reason: "proposal_merged" }),
    );
    await expect(
      deps.rejectProposal("p-7", "closed", new Date(0)),
    ).resolves.toBe(false);
    mocks.updateProposal.mockRejectedValueOnce(new Error("db down"));
    await expect(
      deps.rejectProposal("p-7", "closed", new Date(0)),
    ).rejects.toThrow("db down");
  });
});
