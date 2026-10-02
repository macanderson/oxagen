/**
 * readLatestRetentionPolicy reads the workspace's own policy and never the
 * in-app assistant's (ADR-235). The tx double renders the WHERE the read
 * sends, asserts the subject it pins, and answers from fixture rows filtered
 * by that subject, so a read that forgot the subject would see the
 * assistant's row.
 */
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { readLatestRetentionPolicy, type RetentionPolicyTx } from "./retention";
import { retentionPolicyVersions } from "./schema/run-evidence-foundation";

const dialect = new PgDialect();

const ORG = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000b1";

interface Row {
  subject: "workspace" | "oxagen_assistant";
  version: number;
  mode: string;
  retainedContentClasses: string[];
}

const ASSISTANT_ROW: Row = {
  subject: "oxagen_assistant",
  version: 1,
  mode: "digest_only",
  retainedContentClasses: [],
};

function fakeTx(rows: Row[]) {
  const calls: Array<{
    sql: string;
    params: unknown[];
    args: Record<string, unknown>;
  }> = [];
  const tx: RetentionPolicyTx = {
    query: {
      retentionPolicyVersions: {
        findFirst: async (input: unknown) => {
          const args = input as Record<string, unknown>;
          const { sql, params } = dialect.sqlToQuery(args.where as SQL);
          calls.push({ sql, params, args });
          // A read that pins no subject sees every row, as it did before the
          // subject column existed.
          const pinned = /"subject" = \$/.test(sql);
          const newest = rows
            .filter((row) => !pinned || params.includes(row.subject))
            .sort((a, b) => b.version - a.version)[0];
          return newest
            ? {
                mode: newest.mode,
                retainedContentClasses: newest.retainedContentClasses,
              }
            : undefined;
        },
      },
    },
  };
  return { tx, calls };
}

describe("readLatestRetentionPolicy", () => {
  it("pins the organization, the workspace, and the workspace subject", async () => {
    const { tx, calls } = fakeTx([]);
    await readLatestRetentionPolicy(tx, ORG, WORKSPACE);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.sql).toMatch(/"org_id" = \$/);
    expect(call!.sql).toMatch(/"workspace_id" = \$/);
    expect(call!.sql).toMatch(/"subject" = \$/);
    expect(call!.params).toEqual(
      expect.arrayContaining([ORG, WORKSPACE, "workspace"]),
    );
    expect(call!.params).not.toContain("oxagen_assistant");
    expect(call!.args.columns).toEqual({
      mode: true,
      retainedContentClasses: true,
    });
  });

  it("reads no policy when the workspace holds only the assistant's row", async () => {
    // The case the subject column exists for. The assistant's first turn
    // wrote version 1, and an early build wrote it `digest_only`. Read as the
    // workspace's latest, that row opted every later Tacho run in the
    // workspace down to `inspect`. Undefined means the retain-all default.
    const { tx } = fakeTx([ASSISTANT_ROW]);
    await expect(
      readLatestRetentionPolicy(tx, ORG, WORKSPACE),
    ).resolves.toBeUndefined();
  });

  it("reads the workspace's own row when the assistant's row sits beside it", async () => {
    const { tx } = fakeTx([
      {
        subject: "workspace",
        version: 1,
        mode: "content_exact",
        retainedContentClasses: ["model_call"],
      },
      { ...ASSISTANT_ROW, version: 3 },
    ]);
    await expect(
      readLatestRetentionPolicy(tx, ORG, WORKSPACE),
    ).resolves.toEqual({
      mode: "content_exact",
      retainedContentClasses: ["model_call"],
    });
  });
});

describe("evidence.retention_policy_versions subject", () => {
  const config = getTableConfig(retentionPolicyVersions);
  const indexColumns = (name: string) => {
    const found = config.indexes.find((index) => index.config.name === name);
    if (!found) throw new Error(`${name} is not declared`);
    return {
      unique: found.config.unique,
      columns: found.config.columns.map((column) =>
        "name" in column ? column.name : null,
      ),
    };
  };

  it("defaults a row to the workspace subject", () => {
    expect(retentionPolicyVersions.subject.notNull).toBe(true);
    expect(retentionPolicyVersions.subject.default).toBe("workspace");
  });

  it("admits only the two subjects", () => {
    const check = config.checks.find(
      (c) => c.name === "retention_policy_versions_subject_check",
    );
    expect(check).toBeDefined();
    const { sql } = dialect.sqlToQuery(check!.value);
    expect(sql).toContain("'workspace'");
    expect(sql).toContain("'oxagen_assistant'");
  });

  it("keys both unique indexes on the subject, so each subject has its own version 1", () => {
    expect(indexColumns("retention_policy_versions_version_uniq")).toEqual({
      unique: true,
      columns: ["org_id", "workspace_id", "subject", "version"],
    });
    expect(indexColumns("retention_policy_versions_digest_uniq")).toEqual({
      unique: true,
      columns: ["org_id", "workspace_id", "subject", "policy_digest"],
    });
  });
});
