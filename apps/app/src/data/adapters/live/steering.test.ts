import { beforeEach, describe, expect, it, vi } from "vitest";

// The fake transaction answers the two query shapes the adapter builds: the
// promotions subquery (`…groupBy().as()`) and the record read (`…orderBy()`).
const { calls, rows, runInTenantScopeMock, withTenantDbMock } = vi.hoisted(
  () => {
    const calls = {
      scopes: [] as unknown[],
      from: [] as unknown[],
      selected: [] as string[][],
      joins: [] as string[],
    };
    const rows: { value: unknown[] } = { value: [] };
    const tx = {
      select: vi.fn((fields: Record<string, unknown>) => {
        calls.selected.push(Object.keys(fields));
        const chain = {
          from: vi.fn((table: unknown) => {
            calls.from.push(table);
            return chain;
          }),
          innerJoin: vi.fn(() => {
            calls.joins.push("inner");
            return chain;
          }),
          leftJoin: vi.fn(() => {
            calls.joins.push("left");
            return chain;
          }),
          where: vi.fn(() => chain),
          groupBy: vi.fn(() => chain),
          // The subquery stands in for its own columns in the outer query.
          as: vi.fn(() => fields),
          orderBy: vi.fn(() => Promise.resolve(rows.value)),
        };
        return chain;
      }),
    };
    const withTenantDbMock = vi.fn((fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    const runInTenantScopeMock = vi.fn(
      (scope: unknown, fn: () => Promise<unknown>) => {
        calls.scopes.push(scope);
        return fn();
      },
    );
    return { calls, rows, runInTenantScopeMock, withTenantDbMock };
  },
);

vi.mock("@oxagen/database", async () => ({
  schema: await vi.importActual("@oxagen/database/schema"),
  withTenantDb: withTenantDbMock,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: runInTenantScopeMock }));

import * as schema from "@oxagen/database/schema";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { WORKSPACE_SCOPE_REQUIRED, liveSteering } from "./steering";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0de1",
};

const LINEAGE = "ctx.acme.platform.release-order";
const BODY = `schema = "context-record/v0.1"
[[record]]
lineage_id = "${LINEAGE}"
kind = "procedure"
statement = "Freeze main, dry-run the migrations, tag, then publish the notes."
sharing_scope = "workspace"
[record.steering]
force = "should"
`;

const dbRow = {
  publicId: "ctr_01K5RU4A8XQ2P0M7N3JH5B",
  slug: LINEAGE,
  status: "active",
  body: BODY,
  provenance: [{ type: "commit", digest: "d17e40b" }],
  versionPublishedAt: new Date("2026-08-21T09:00:00Z"),
  promotedAt: null,
};

beforeEach(() => {
  rows.value = [];
  calls.scopes.length = 0;
  calls.from.length = 0;
  calls.selected.length = 0;
  calls.joins.length = 0;
});

describe("liveSteering.records", () => {
  it("reads the workspace's records inside its tenant scope and maps them", async () => {
    rows.value = [dbRow];
    await expect(liveSteering.records(SCOPE)).resolves.toEqual({
      ok: true,
      value: [
        {
          lineage: LINEAGE,
          kind: "procedure",
          force: "should",
          enforcement: null,
          scope: "workspace",
          status: "published",
          statement:
            "Freeze main, dry-run the migrations, tag, then publish the notes.",
          effect: null,
          commitSha: "d17e40b",
          publishedOn: "2026-08-21",
        },
      ],
    });
    expect(calls.scopes).toEqual([SCOPE]);
    expect(withTenantDbMock).toHaveBeenCalledTimes(1);
  });

  it("selects exactly the columns the mapper reads, from the three steering tables", async () => {
    await liveSteering.records(SCOPE);
    expect(calls.from).toEqual([
      schema.contextPromotions,
      schema.contextRecords,
    ]);
    expect(calls.joins).toEqual(["inner", "left"]);
    expect(calls.selected).toEqual([
      ["recordId", "versionId", "promotedAt"],
      [
        "publicId",
        "slug",
        "status",
        "body",
        "provenance",
        "versionPublishedAt",
        "promotedAt",
      ],
    ]);
  });

  it("returns an empty workspace as an empty list", async () => {
    await expect(liveSteering.records(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses the organization-only scope before reaching the store", async () => {
    await expect(
      liveSteering.records({ ...SCOPE, workspaceId: ORG_ONLY_WORKSPACE_ID }),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: WORKSPACE_SCOPE_REQUIRED,
      status: 400,
    });
    expect(runInTenantScopeMock).not.toHaveBeenCalled();
    expect(withTenantDbMock).not.toHaveBeenCalled();
  });

  it("is not backed when a record carries no publication commit", async () => {
    rows.value = [{ ...dbRow, provenance: [] }];
    await expect(liveSteering.records(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M3",
      gap: "G0",
    });
  });

  it("lets a store failure propagate to the page's error boundary", async () => {
    withTenantDbMock.mockRejectedValueOnce(new Error("connection refused"));
    await expect(liveSteering.records(SCOPE)).rejects.toThrow(
      "connection refused",
    );
  });
});

describe("liveSteering methods with no store", () => {
  it.each(["proposals", "effect", "retirementCandidates"] as const)(
    "%s is not backed until M3 and never touches the store",
    async (method) => {
      await expect(liveSteering[method](SCOPE)).resolves.toEqual({
        ok: false,
        reason: "not_backed",
        milestone: "M3",
        gap: "G0",
      });
      expect(withTenantDbMock).not.toHaveBeenCalled();
    },
  );
});
