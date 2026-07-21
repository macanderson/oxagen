import { beforeEach, describe, expect, it, vi } from "vitest";

const updates = vi.hoisted(
  () => [] as Array<{ table: unknown; set: Record<string, unknown> }>,
);

const AGENT_ROW = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "rbac-agent",
  name: "RBAC Agent",
  description: null,
  agentType: "custom",
  status: "active",
  deploymentStatus: "active",
  activeVersionId: "ver-1",
  avatarUrl: null,
  summary: null,
  summaryChecksum: null,
  principalId: "prn-1",
};

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
          return Promise.resolve([AGENT_ROW]);
        },
      };
      return builder;
    },
    update(table: unknown) {
      let setValues: Record<string, unknown> = {};
      const builder = {
        set(values: Record<string, unknown>) {
          setValues = values;
          updates.push({ table, set: values });
          return builder;
        },
        where() {
          return Promise.resolve([]);
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
import { agentDefinitionArchiveHandler } from "./agent.definition.archive";
import { TEST_CTX } from "../test-utils/fixtures";

beforeEach(() => updates.splice(0));

describe("agent principal soft-delete on archive", () => {
  it("soft-deletes the agent's principal (status='deleted') in the same transaction as the agent archive", async () => {
    await agentDefinitionArchiveHandler({ agentId: "agt_1" }, TEST_CTX);

    const principalUpdates = updates.filter(
      ({ table }) => table === schema.principals,
    );
    expect(principalUpdates).toHaveLength(1);
    expect(principalUpdates[0]?.set).toMatchObject({
      status: "deleted",
    });

    const agentUpdates = updates.filter(({ table }) => table === schema.agents);
    expect(agentUpdates).toHaveLength(1);
    expect(agentUpdates[0]?.set).toMatchObject({
      status: "archived",
    });
  });
});
