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
        agentType: "interactive_chat",
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
        agentType: "custom",
        status: "draft",
        deploymentStatus: "inactive",
        latestVersion: null,
      },
    ]);
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents).toHaveLength(2);
    expect(out.agents[0]!.agentId).toBe("agt_1");
    expect(out.agents[1]!.latestVersion).toBeNull();
    // agentType is surfaced so the selector can classify code vs chat agents.
    expect(out.agents[0]!.agentType).toBe("interactive_chat");
    expect(out.agents[1]!.agentType).toBe("custom");
  });

  it("surfaces agentType 'code' so callers can flag a code agent", async () => {
    fake.enqueue([
      {
        id: "uuid-3",
        publicId: "agt_3",
        slug: "repo-fixer",
        name: "Repo Fixer",
        description: null,
        agentType: "code",
        status: "active",
        deploymentStatus: "active",
        latestVersion: 1,
      },
    ]);
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents[0]!.agentType).toBe("code");
  });

  it("sets managed=true for an interactive_chat agent", async () => {
    fake.enqueue([
      {
        id: "uuid-1",
        publicId: "agt_1",
        slug: "qa-chat",
        name: "QA",
        description: null,
        agentType: "interactive_chat",
        status: "active",
        deploymentStatus: "active",
        latestVersion: 2,
      },
    ]);
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents[0]!.managed).toBe(true);
  });

  it("sets managed=false for a custom agent", async () => {
    fake.enqueue([
      {
        id: "uuid-2",
        publicId: "agt_2",
        slug: "my-agent",
        name: "Mine",
        description: null,
        agentType: "custom",
        status: "draft",
        deploymentStatus: "inactive",
        latestVersion: null,
      },
    ]);
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents[0]!.managed).toBe(false);
  });

  it("returns an empty list when no agents exist", async () => {
    fake.enqueue([]);
    const out = await agentDefinitionListHandler({ status: "active" }, CTX);
    expect(out.agents).toEqual([]);
  });

  it("composes agentKey per row from the one shared namespace lookup", async () => {
    fake.enqueue(
      [
        {
          id: "uuid-1",
          publicId: "agt_1",
          slug: "qa-chat",
          name: "QA",
          description: null,
          agentType: "interactive_chat",
          status: "active",
          deploymentStatus: "active",
          latestVersion: 1,
        },
        {
          id: "uuid-2",
          publicId: "agt_2",
          slug: "repo-fixer",
          name: "Repo Fixer",
          description: null,
          agentType: "code",
          status: "active",
          deploymentStatus: "active",
          latestVersion: 2,
        },
      ],
      [{ orgNamespace: "acme", workspaceNamespace: "core" }], // resolveNamespacePrefix
    );
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents[0]!.agentKey).toBe("acme.core.qa-chat");
    expect(out.agents[1]!.agentKey).toBe("acme.core.repo-fixer");
  });

  it("returns null agentKey for every row when a namespace is missing", async () => {
    fake.enqueue(
      [
        {
          id: "uuid-1",
          publicId: "agt_1",
          slug: "qa-chat",
          name: "QA",
          description: null,
          agentType: "interactive_chat",
          status: "active",
          deploymentStatus: "active",
          latestVersion: 1,
        },
      ],
      [{ orgNamespace: null, workspaceNamespace: null }],
    );
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents[0]!.agentKey).toBeNull();
  });
});
