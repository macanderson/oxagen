import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const tx = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          state.inserts.push({ table, values });
          return {
            returning: async () => {
              if (table === real.schema.agents) {
                return [
                  { id: "agent-uuid", publicId: "agt_1", slug: "my-agent" },
                ];
              }
              if (table === real.schema.principals) {
                return [{ id: "principal-uuid", publicId: "prn_1" }];
              }
              if (table === real.schema.agentVersions) return [{ version: 1 }];
              return [];
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          state.updates.push({ table, values });
          return { where: async () => [] };
        },
      };
    },
    // The default "Agent Contributor" role lookup (Agent RBAC §3.2) — this
    // witness pins principal provisioning, so the role row is absent here and
    // the handler skips the auto-assignment.
    select() {
      return {
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      };
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

beforeEach(() => {
  state.inserts.length = 0;
  state.updates.length = 0;
});

it("provisions one delegated agent principal and links it to the agent identity", async () => {
  await agentDefinitionCreateHandler(
    {
      slug: "my-agent",
      name: "My Agent",
      agentType: "custom",
      config: {
        graph: {
          ontologyId: "ont_1",
          mode: "read",
          retrieval: { strategy: "hybrid" },
          budget: { maxHops: 2, maxNodes: 20 },
        },
        agentTools: [{ type: "skill", ref: "coding" }],
        instructions: "hi",
      },
    },
    TEST_CTX,
  );

  const principalInserts = state.inserts.filter(
    ({ table }) => table === schema.principals,
  );
  expect(principalInserts).toHaveLength(1);
  expect(principalInserts[0]?.values).toMatchObject({
    kind: "agent",
    parentUserId: TEST_CTX.userId,
    orgId: TEST_CTX.orgId,
    workspaceId: TEST_CTX.workspaceId,
  });

  const agentInsert = state.inserts.find(
    ({ table }) => table === schema.agents,
  );
  const agentUpdates = state.updates.filter(
    ({ table }) => table === schema.agents,
  );
  expect(
    agentInsert?.values.principalId === "principal-uuid" ||
      agentUpdates.some(
        ({ values }) => values.principalId === "principal-uuid",
      ),
  ).toBe(true);
});
