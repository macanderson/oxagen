import { beforeEach, expect, it, vi } from "vitest";

const insertedTables = vi.hoisted(() => [] as unknown[]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const tx = {
    select() {
      const builder = {
        from() {
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve([{ id: "role-contributor" }]);
        },
      };
      return builder;
    },
    insert(table: unknown) {
      let values: Record<string, unknown> = {};
      const builder = {
        values(next: Record<string, unknown>) {
          values = next;
          insertedTables.push(table);
          return builder;
        },
        returning() {
          if (values.kind === "agent")
            return Promise.resolve([{ id: "principal-1" }]);
          if (values.version === 1) return Promise.resolve([{ version: 1 }]);
          return Promise.resolve([
            { id: "agent-1", publicId: "agt_1", slug: "rbac-agent" },
          ]);
        },
      };
      return builder;
    },
  };

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
});

import { schema } from "@oxagen/database";
import { TEST_CTX } from "../test-utils/fixtures";
import { agentDefinitionCreateHandler } from "./agent.definition.create";

beforeEach(() => insertedTables.splice(0));

it("provisions the agent principal without assigning a default role", async () => {
  await agentDefinitionCreateHandler(
    {
      slug: "rbac-agent",
      name: "RBAC Agent",
      agentType: "custom",
      config: {
        graph: {
          ontologyId: "ont_1",
          mode: "read",
          retrieval: { strategy: "hybrid" },
          budget: { maxHops: 2, maxNodes: 20 },
        },
        agentTools: [],
        triggers: [{ type: "manual", enabled: true }],
        instructions: "Act safely",
      },
    },
    TEST_CTX,
  );

  expect(
    insertedTables.filter((table) => table === schema.principals),
  ).toHaveLength(1);
  expect(insertedTables).not.toContain(schema.principalRoleAssignments);
});
