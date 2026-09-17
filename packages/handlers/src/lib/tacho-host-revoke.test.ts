/**
 * The revocation writes, and specifically the credential sweep.
 *
 * This file exists because of where the sweep ended up. It was written on
 * `revoke_tacho_enrollment`'s handler, and the WL-52 merge brought a refactor
 * that moved the three revocation writes into `revokeHostEnrollment` and gave
 * them a SECOND caller: `retire_agent`, which runs them for every live host
 * under an agent's key.
 *
 * Merging the fix into the helper is the right placement — `retire_agent` had
 * the same defect and nothing on the original branch would have reached it —
 * but it moved the fix onto a path with no test of its own. `agent.retire.ts`
 * has no test file either, so without this the second caller's behaviour rests
 * on reading the diff.
 *
 * The predicates are compiled through `PgDialect` rather than asserted by
 * intent, for the same reason as `tacho.enrollment.revoke.test.ts`: the defect
 * was a `WHERE` clause that named one key instead of two, and only the
 * statement shows which.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  retireEnrollmentKeys,
  revokeHostEnrollment,
} from "./tacho-host-revoke";

const ORG = "00000000-0000-0000-0000-000000000001";
const WORKSPACE = "00000000-0000-0000-0000-000000000002";
const USER = "00000000-0000-0000-0000-0000000000aa";
const HOST_KEY_ID = "00000000-0000-0000-0000-0000000000b1";
const ENROLLMENT = "tch_0123456789abcdefghjkmn";

const dialect = new PgDialect();

interface Statement {
  table: string;
  sql: string;
  params: readonly unknown[];
}

let updates: Statement[] = [];
let inserts: string[] = [];
/** Rows the scope sweep answers with. */
let sweptRows: Array<{ id: string }> = [];
/** Rows the by-id fallback answers with. */
let byIdRows: Array<{ id: string }> = [];

function tableNameOf(table: unknown): string {
  for (const s of Object.getOwnPropertySymbols(table as object)) {
    const v = (table as Record<symbol, unknown>)[s];
    if (typeof v === "string" && v !== "") return v;
  }
  return "unknown";
}

function fakeTx() {
  return {
    update: (table: unknown) => ({
      set: () => ({
        where: (pred: SQL) => {
          const q = dialect.sqlToQuery(pred);
          updates.push({
            table: tableNameOf(table),
            sql: q.sql,
            params: q.params,
          });
          const rows = q.sql.includes("host_enrollment_id")
            ? sweptRows
            : byIdRows;
          const result = Promise.resolve(rows) as Promise<
            Array<{ id: string }>
          > & { returning: () => Promise<Array<{ id: string }>> };
          result.returning = async () => rows;
          return result;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async () => {
        inserts.push(tableNameOf(table));
      },
    }),
  };
}

const host = () => ({
  id: "host-row-id",
  publicId: ENROLLMENT,
  apiKeyId: HOST_KEY_ID,
});

const args = {
  orgId: ORG,
  userId: USER,
  now: new Date("2026-09-17T09:00:00Z"),
};

beforeEach(() => {
  updates = [];
  inserts = [];
  sweptRows = [{ id: HOST_KEY_ID }, { id: "gateway-key" }];
  byIdRows = [{ id: HOST_KEY_ID }];
  vi.clearAllMocks();
});

const keyUpdates = () => updates.filter((u) => u.table === "api_keys");

describe("retireEnrollmentKeys", () => {
  it("selects by the enrollment marker both credentials carry", async () => {
    const n = await retireEnrollmentKeys(fakeTx() as never, host(), args);
    const sweep = keyUpdates().find((u) =>
      u.sql.includes("host_enrollment_id"),
    );
    expect(sweep).toBeDefined();
    // The enrollment id, not the single api_key_id, is what selects the rows.
    expect(sweep?.params).toContain(ENROLLMENT);
    expect(sweep?.params).toContain(ORG);
    // A key already retired is left alone rather than re-stamped.
    expect(sweep?.sql).toContain("deleted_at");
    expect(n).toBe(2);
  });

  it("issues no second statement when the sweep reached the host key", async () => {
    await retireEnrollmentKeys(fakeTx() as never, host(), args);
    expect(
      keyUpdates().filter((u) => u.params.includes(HOST_KEY_ID)),
    ).toHaveLength(0);
  });

  it("still retires the control-plane key of a host enrolled before the marker", async () => {
    // Such a row carries no `scope.host_enrollment_id`, so the sweep returns
    // nothing and the fallback is the only thing that takes its key away.
    sweptRows = [];
    const n = await retireEnrollmentKeys(fakeTx() as never, host(), args);
    expect(
      keyUpdates().filter((u) => u.params.includes(HOST_KEY_ID)),
    ).toHaveLength(1);
    expect(n).toBe(1);
  });

  // ── The sweep must not reach credentials the enrollment did not mint ──────
  //
  // `create_api_key` takes `scope` as `z.record(z.unknown())`, and a host's
  // enrollment id is PUBLIC. So an Owner or Admin can put `host_enrollment_id`
  // on an ordinary key — deliberately, or by coincidence in their own metadata
  // — and on that marker alone revoking the host soft-deleted their key too
  // (discussion_r4036214055). A destructive statement whose targets come from
  // caller-supplied data has a blast radius the server does not control.
  //
  // WHAT THESE TWO CASES PROVE, AND WHAT THEY DO NOT. The fixture compiles the
  // predicate and records it; no database evaluates it. So they prove the
  // `purpose` constraint is in the WHERE, with both server-owned constants as
  // parameters, alongside the enrollment id. They do NOT prove Postgres
  // excludes the unrelated row — `IN` plus `=` is not subtle, but only a run
  // against a real table with all three rows in it would show the exclusion.
  // That is the same residue as the rest of this file and it is worth naming:
  // an assertion on a clause is not an observation of a row.
  it("selects on the server-owned purpose, not the public enrollment id alone", async () => {
    await retireEnrollmentKeys(fakeTx() as never, host(), args);
    const sweep = keyUpdates().find((u) =>
      u.sql.includes("host_enrollment_id"),
    );
    // The half the server owns: api.key.create refuses a caller-supplied
    // reserved Tacho purpose, so only enrollment can have written one.
    expect(sweep?.sql).toContain("'purpose'");
    expect(sweep?.params).toContain("tacho_host_v1");
    expect(sweep?.params).toContain("tacho_gateway_v1");
    // Still ANDed with the enrollment id, so the sweep stays scoped to THIS
    // host rather than retiring every Tacho key in the organisation.
    expect(sweep?.params).toContain(ENROLLMENT);
  });

  it("leaves a legacy host key reachable through the id fallback", async () => {
    // The population this sweep exists for. A host enrolled before the marker
    // carries NEITHER purpose nor enrollment id, so narrowing the predicate
    // would strand it — except that `tacho_hosts.api_key_id` is written at
    // enrollment and is server-owned in the strongest sense. The fallback
    // selects on that id and nothing else, so it carries no purpose clause.
    sweptRows = [];
    const n = await retireEnrollmentKeys(fakeTx() as never, host(), args);
    const fallback = keyUpdates().find((u) => u.params.includes(HOST_KEY_ID));
    expect(fallback).toBeDefined();
    expect(fallback?.sql).not.toContain("'purpose'");
    expect(fallback?.params).not.toContain(ENROLLMENT);
    expect(n).toBe(1);
  });

  it("counts nothing when both statements match no live row", async () => {
    // The idempotent case: a second call over a fully-swept host.
    sweptRows = [];
    byIdRows = [];
    expect(await retireEnrollmentKeys(fakeTx() as never, host(), args)).toBe(0);
  });
});

describe("revokeHostEnrollment", () => {
  // retire_agent runs this for every live host under an agent's key. Without
  // the sweep inside it, retiring an agent left one live gateway key per host.
  it("sweeps every enrollment credential, not just the one with a column", async () => {
    await revokeHostEnrollment(fakeTx() as never, host(), {
      orgId: ORG,
      workspaceId: WORKSPACE,
      userId: USER,
      reason: "lost",
      now: args.now,
    });
    expect(keyUpdates().some((u) => u.sql.includes("host_enrollment_id"))).toBe(
      true,
    );
  });

  it("still marks the host revoked and queues the command", async () => {
    await revokeHostEnrollment(fakeTx() as never, host(), {
      orgId: ORG,
      workspaceId: WORKSPACE,
      userId: USER,
      reason: "lost",
      now: args.now,
    });
    expect(updates.some((u) => u.table === "hosts")).toBe(true);
    expect(inserts).toContain("control_commands");
  });
});
