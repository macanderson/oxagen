/**
 * The in-app approval predicate, asserted on the SQL a select and a
 * relational read actually issue.
 *
 * A relational read (`findMany`, `findFirst`) aliases its root table and
 * rewrites every column in its `where` to that alias. A predicate that named
 * `agent_runs.public_id` as a Drizzle column would come out as the approval
 * row's own `public_id`, and the subquery would match nothing, or the wrong
 * thing. The database test beside this one (`approval-in-app.pg.test.ts`)
 * proves the rows, and needs DATABASE_URL. This one proves the statement
 * shape on every run.
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import { and, eq } from "drizzle-orm";
import { schema } from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.shared";
import {
  approvalAskedBy,
  inAppApproval,
  inAppOnlyForAsker,
  notInAppApproval,
} from "./approval-in-app";

const ar = schema.approvalRequests;
const ORG = "0192d4a8-7c1e-7a00-8000-0000000000f1";
const USER = "0192d4a8-7c1e-7a00-8000-0000000000f3";

const db = drizzle(async () => ({ rows: [] }), { schema });

/** The statement a plain select issues with `where` as its only filter. */
const selected = (where: ReturnType<typeof inAppApproval>) =>
  db.select({ id: ar.id }).from(ar).where(where).toSQL();

/** The statement a relational read issues, with the root table aliased. */
const related = (where: ReturnType<typeof inAppApproval>) =>
  db.query.approvalRequests
    .findMany({ where: and(eq(ar.orgId, ORG), where), columns: { id: true } })
    .toSQL();

describe("inAppApproval", () => {
  it("reads the run named on the row, in the row's workspace, on an in-app surface", () => {
    const { sql, params } = selected(inAppApproval());
    expect(sql).toContain(
      'exists (select 1 from "agent"."agent_runs" as "in_app_run" where "in_app_run"."public_id" = "agent"."approval_requests"."run_public_id"::citext',
    );
    expect(sql).toContain(
      '"in_app_run"."org_id" = "agent"."approval_requests"."org_id"',
    );
    expect(sql).toContain(
      '"in_app_run"."workspace_id" = "agent"."approval_requests"."workspace_id"',
    );
    expect(sql).toMatch(/"in_app_run"\."surface" in \(\$\d+, \$\d+\)/);
    // The surfaces come from the one constant the run lists also read.
    expect(params).toEqual([...IN_APP_AGENT_SURFACES]);
  });

  it("follows the relational read's alias for the row and keeps the run's columns its own", () => {
    const { sql } = related(inAppApproval());
    expect(sql).toMatch(/from "agent"\."approval_requests" "approvalRequests"/);
    expect(sql).toContain(
      '"in_app_run"."public_id" = "approvalRequests"."run_public_id"::citext',
    );
    expect(sql).toContain(
      '"in_app_run"."workspace_id" = "approvalRequests"."workspace_id"',
    );
    // The defect this shape avoids: an inner column rewritten to the root
    // alias would read the approval row's own columns.
    expect(sql).not.toMatch(/"approvalRequests"\."surface"/);
    expect(sql).not.toMatch(/"approvalRequests"\."public_id" = /);
  });

  it("negates to the workspace's own queue", () => {
    const { sql } = selected(notInAppApproval());
    expect(sql).toMatch(/where not exists \(select 1 from "agent"\."agent_runs"/);
  });
});

describe("approvalAskedBy", () => {
  it("reads the requester through the row's message and its conversation", () => {
    const { sql, params } = related(approvalAskedBy(USER));
    expect(sql).toContain(
      'exists (select 1 from "chat"."messages" as "asker_message" join "chat"."conversations" as "asker_conversation" on "asker_conversation"."id" = "asker_message"."conversation_id"',
    );
    expect(sql).toContain(
      '"asker_message"."id" = "approvalRequests"."message_id"',
    );
    expect(sql).toContain(
      '"asker_conversation"."workspace_id" = "approvalRequests"."workspace_id"',
    );
    expect(sql).toMatch(/"asker_conversation"\."user_id" = \$\d+/);
    expect(params).toContain(USER);
  });
});

describe("inAppOnlyForAsker", () => {
  it("keeps every other row, and an in-app row only for the person who asked", () => {
    const { sql, params } = related(inAppOnlyForAsker(USER));
    expect(sql).toMatch(
      /\(not exists \(select 1 from "agent"\."agent_runs".* or exists \(select 1 from "chat"\."messages"/,
    );
    expect(params).toContain(USER);
  });

  it("shows no in-app row to a caller with no acting user (negative)", () => {
    const { sql, params } = selected(inAppOnlyForAsker(null));
    expect(sql).toMatch(/where not exists \(select 1 from "agent"\."agent_runs"/);
    expect(sql).not.toContain('"chat"."messages"');
    expect(params).toEqual([...IN_APP_AGENT_SURFACES]);
  });
});
