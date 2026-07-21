import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts = vi.hoisted(
  () => [] as Array<{ table: unknown; values: Record<string, unknown> }>,
);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const tx = {
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
import { agentDefinitionCreateHandler } from "./agent.definition.create";
import { TEST_CTX } from "../test-utils/fixtures";

beforeEach(() => inserts.splice(0));

describe("agent principal provisioning", () => {
  it("creates exactly one agent principal delegated by the creating user", async () => {
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

    const principalInserts = inserts.filter(
      ({ table }) => table === schema.principals,
    );
    expect(principalInserts).toHaveLength(1);
    expect(principalInserts[0]?.values).toMatchObject({
      kind: "agent",
      parentUserId: TEST_CTX.userId,
      orgId: TEST_CTX.orgId,
      workspaceId: TEST_CTX.workspaceId,
    });
  });
});
