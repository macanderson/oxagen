/**
 * Which user an agent identity reports as its operator, asserted on the SQL the
 * read actually issues.
 *
 * `agents.principal_id` names the agent's OWN delegated principal, which
 * `register_agent` writes with `kind = 'agent'` and `parent_user_id` =
 * the registering user. Two seams in `relations.ts` join `auth.users` on that
 * column and they are not interchangeable: `operatorUserJoin` also requires
 * `kind = 'human'`, which an agent principal never is, so pointing this read at
 * it left `operatorId` null for every agent in the workspace
 * (discussion_r4051925928).
 *
 * The end-to-end assertion lives in `agent.list.test.ts`, which needs a real
 * Postgres and is skipped without `DATABASE_URL` — which is how this shipped.
 * This file proves the same property off the rendered statement, so it holds on
 * every run: the join condition is the whole defect, and it is visible in the
 * SQL.
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  agentCreatorUserJoin,
  operatorUserJoin,
  schema,
  type Tx,
} from "@oxagen/database";
import { resolveAgentIdentity } from "./_agent-identity";

const ORG = "0192d4a8-7c1e-7a00-8000-0000000000f1";
const WORKSPACE = "0192d4a8-7c1e-7a00-8000-0000000000f2";

/**
 * A `Tx` that renders every statement and answers no rows.
 *
 * The proxy driver is drizzle's own, so what is captured is the statement the
 * handler would send rather than a reconstruction of it.
 */
function renderingTx(): {
  tx: Tx;
  statements: Array<{ sql: string; params: unknown[] }>;
} {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(
    async (sql, params) => {
      statements.push({ sql, params });
      return { rows: [] };
    },
    { schema },
  );
  return { tx: db as unknown as Tx, statements };
}

describe("an agent identity's operator", () => {
  it("is joined without a human-kind filter, which its own principal never satisfies", async () => {
    const { tx, statements } = renderingTx();
    await resolveAgentIdentity(tx, "release-bot", {
      orgId: ORG,
      workspaceId: WORKSPACE,
    });
    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0]!;
    // The join reaches the agent's own principal, and then the user through it.
    expect(sql).toMatch(/join .*"iam"\."principals"/i);
    expect(sql).toMatch(/join .*"auth"\."users"/i);
    // The join predicate names the column and nothing else.
    expect(sql).toMatch(
      /"auth"\."users"\."id" = "iam"\."principals"\."parent_user_id"/,
    );
    // The defect, stated as the assertion. `kind` is bound as a parameter
    // rather than inlined, so the SQL text alone cannot see it — the value has
    // to be read off the params. An agent's own principal is `kind = 'agent'`,
    // so a `'human'` bound anywhere in this statement makes the user join match
    // nothing and every agent report no operator.
    expect(params).not.toContain("human");
    // And the creator seam's own filter IS bound, which is the positive half:
    // the join is the one that matches an agent principal, not merely one
    // without the wrong filter.
    expect(params).toContain("agent");
  });

  it("has two seams over one column, told apart by the kind filter", () => {
    // The contrast the call site has to get right. Asserted on the seams
    // themselves so a future edit that collapses them into one — or adds the
    // filter back to the creator join — fails here rather than silently
    // blanking a field.
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(operatorUserJoin!).params).toEqual(["human"]);
    const creator = dialect.sqlToQuery(agentCreatorUserJoin!);
    expect(creator.params).toEqual(["agent"]);
    expect(creator.sql).toContain("parent_user_id");
  });
});
