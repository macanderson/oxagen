import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { approvalIdCondition } from "./approval-id";

const dialect = new PgDialect();

function render(approvalId: string) {
  return dialect.sqlToQuery(approvalIdCondition(approvalId));
}

describe("approvalIdCondition (#2906)", () => {
  it("matches public_id for an apr_ public id", () => {
    const q = render("apr_01k5rt9x");
    expect(q.sql).toMatch(/"public_id" = \$1/);
    expect(q.sql).not.toMatch(/"id" = \$1/);
    expect(q.params).toEqual(["apr_01k5rt9x"]);
  });

  it("matches public_id for an upper-cased public id (public_id is citext)", () => {
    expect(render("APR_01K5RT9X").sql).toMatch(/"public_id" = \$1/);
  });

  it("matches the uuid primary key for a uuid", () => {
    const id = "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c";
    const q = render(id);
    expect(q.sql).toMatch(/"approval_requests"\."id" = \$1/);
    expect(q.sql).not.toMatch(/public_id/);
    expect(q.params).toEqual([id]);
  });

  it("does not treat a look-alike prefix as a public id", () => {
    expect(render("appr_1").sql).not.toMatch(/public_id/);
  });
});
