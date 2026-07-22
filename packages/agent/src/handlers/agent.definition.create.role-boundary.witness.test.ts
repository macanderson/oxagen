import { beforeEach, describe, expect, it, vi } from "vitest";

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
      insertedTables.push(table);
      let values: Record<string, unknown> = {};
      const builder = {
        values(nextValues: Record<string, unknown>) {
          values = nextValues;
          return builder;
        },
        returning() {
          if (values.kind === "agent") {
            return Promise.resolve([{ id: "principal-1" }]);
          }
          if (values.version === 1) {
            return Promise.resolve([{ version: 1 }]);
          }
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

describe("agent principal provisioning boundary", () => {
  it("does not assign a default role while creating the agent principal", async () => {
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

    expect(insertedTables).not.toContain(schema.principalRoleAssignments);
  });
});
