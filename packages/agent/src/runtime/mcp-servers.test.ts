/**
 * selectMaterializableMcpServers leaves out a server a steering version
 * published. The query runs against a recording transaction, and its WHERE
 * clause is rendered with Postgres's dialect so the test reads the SQL a real
 * database would get.
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Tx } from "@oxagen/database";
import { selectMaterializableMcpServers } from "./mcp-servers";

function renderWhere(filter: {
  serverAllowlist?: ReadonlySet<string>;
}): { sql: string; params: unknown[] } {
  let where: SQL | undefined;
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: (condition: SQL) => {
      where = condition;
      return chain;
    },
  };
  const tx = { select: () => chain } as unknown as Tx;
  selectMaterializableMcpServers(tx, {
    orgId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    ...filter,
  });
  if (!where) throw new Error("the selector set no WHERE clause");
  return new PgDialect().sqlToQuery(where);
}

describe("selectMaterializableMcpServers", () => {
  it("leaves out a server whose origin is steering", () => {
    const query = renderWhere({});
    expect(query.sql).toContain('"mcp_servers"."origin" <> $');
    const index = query.sql.indexOf('"mcp_servers"."origin" <> $');
    const param = Number(
      query.sql.slice(index).match(/<> \$(\d+)/)?.[1] ?? Number.NaN,
    );
    expect(query.params[param - 1]).toBe("steering");
  });

  it("keeps the origin filter when the composer names servers", () => {
    const query = renderWhere({ serverAllowlist: new Set(["mcs_a", "mcs_b"]) });
    expect(query.sql).toContain('"mcp_servers"."origin" <> $');
    expect(query.sql).toContain('"mcp_servers"."public_id" in (');
    expect(query.params).toEqual(
      expect.arrayContaining(["steering", "mcs_a", "mcs_b"]),
    );
  });
});
