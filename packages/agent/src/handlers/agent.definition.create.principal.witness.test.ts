// Witness test (Agent RBAC Phase 1, task: agent principals & identity plumbing):
// on agent creation the handler MUST provision exactly ONE iam.principals row
// with kind='agent' and parentUserId = the creating user, and link it onto the
// agent identity row (agents.principalId). One principal per agent IDENTITY —
// not per version, not per run.
//
// This is a table-and-values-capturing double (the shared fake-tx cannot tell
// which table a query targets). It fails on current code because the create
// handler issues no principals insert at all.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
                return [{ id: "agent-uuid", publicId: "agt_1", slug: "my-agent" }];
              }
              if (table === real.schema.principals) {
                return [{ id: "prn-uuid", publicId: "prn_1" }];
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
  };

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
});

import { schema } from "@oxagen/database";
import { agentDefinitionCreateHandler } from "./agent.definition.create";
import { TEST_CTX } from "../test-utils/fixtures";

const CONFIG = {
  graph: {
    ontologyId: "ont_1",
    mode: "read" as const,
    retrieval: { strategy: "hybrid" as const },
    budget: { maxHops: 2, maxNodes: 20 },
  },
  agentTools: [{ type: "skill" as const, ref: "coding" }],
  triggers: [{ type: "manual" as const, enabled: true }],
  instructions: "hi",
};

const INPUT = {
  slug: "my-agent",
  name: "My Agent",
  agentType: "custom",
  config: CONFIG,
};

beforeEach(() => {
  state.inserts.length = 0;
  state.updates.length = 0;
});

describe("agent.definition.create — agent principal provisioning", () => {
  it("provisions exactly one kind='agent' principal parented to the creating user", async () => {
    await agentDefinitionCreateHandler(INPUT, TEST_CTX);

    const principalInserts = state.inserts.filter(
      ({ table }) => table === schema.principals,
    );

    // Exactly ONE principal per agent identity.
    expect(principalInserts).toHaveLength(1);
    expect(principalInserts[0]?.values).toMatchObject({
      kind: "agent",
      parentUserId: TEST_CTX.userId,
      orgId: TEST_CTX.orgId,
    });
  });

  it("persists the provisioned principal id onto the agent identity row", async () => {
    await agentDefinitionCreateHandler(INPUT, TEST_CTX);

    const agentInsert = state.inserts.find(
      ({ table }) => table === schema.agents,
    );
    const agentUpdates = state.updates.filter(
      ({ table }) => table === schema.agents,
    );

    const linkedOnInsert = agentInsert?.values.principalId === "prn-uuid";
    const linkedOnUpdate = agentUpdates.some(
      ({ values }) => values.principalId === "prn-uuid",
    );
    expect(linkedOnInsert || linkedOnUpdate).toBe(true);
  });
});
