import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts = vi.hoisted(
  () => [] as Array<{ table: unknown; values: Record<string, unknown> }>,
);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const roleRows = [{ id: "role-contributor", name: "Agent Contributor" }];

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
          return Promise.resolve(roleRows);
        },
        then(resolve: (rows: typeof roleRows) => unknown) {
          return Promise.resolve(roleRows).then(resolve);
        },
      };
      return builder;
    },
    insert(table: unknown) {
      let insertedValues: Record<string, unknown> = {};
      const builder = {
        values(values: Record<string, unknown>) {
          insertedValues = values;
          inserts.push({ table, values });
          return builder;
        },
        returning() {
          if (insertedValues.kind === "agent")
            return Promise.resolve([{ id: "principal-1" }]);
          if (insertedValues.version === 1)
            return Promise.resolve([{ version: 1 }]);
          return Promise.resolve([
            { id: "agent-1", publicId: "agt_1", slug: "default-role-agent" },
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
import { agentDefinitionCreateHandler } from "./agent.definition.create";
import { TEST_CTX } from "../test-utils/fixtures";

beforeEach(() => inserts.splice(0));

describe("agent default role assignment", () => {
  it("assigns Agent Contributor to the newly provisioned principal", async () => {
    await agentDefinitionCreateHandler(
      {
        slug: "default-role-agent",
        name: "Default Role Agent",
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

    const assignments = inserts.filter(
      ({ table }) => table === schema.principalRoleAssignments,
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.values).toMatchObject({
      principalId: "principal-1",
      roleId: "role-contributor",
      orgId: TEST_CTX.orgId,
      workspaceId: TEST_CTX.workspaceId,
      assignedBy: TEST_CTX.userId,
    });
  });
});
