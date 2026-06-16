import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { agentDefinitionListHandler } from "./agent.definition.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

beforeEach(() => fake.reset());

describe("agent.definition.list handler", () => {
  it("maps rows to the output shape with publicId as agentId", async () => {
    fake.enqueue([
      {
        id: "uuid-1",
        publicId: "agt_1",
        slug: "qa-chat",
        name: "QA",
        description: null,
        status: "active",
        deploymentStatus: "active",
        latestVersion: 1,
      },
      {
        id: "uuid-2",
        publicId: "agt_2",
        slug: "draft",
        name: "Draft",
        description: "wip",
        status: "draft",
        deploymentStatus: "inactive",
        latestVersion: null,
      },
    ]);
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents).toHaveLength(2);
    expect(out.agents[0]!.agentId).toBe("agt_1");
    expect(out.agents[1]!.latestVersion).toBeNull();
  });

  it("returns an empty list when no agents exist", async () => {
    fake.enqueue([]);
    const out = await agentDefinitionListHandler({ status: "active" }, CTX);
    expect(out.agents).toEqual([]);
  });
});
