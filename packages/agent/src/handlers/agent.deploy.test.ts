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

import {
  agentDeployHandler,
  AgentDeployRequiresPublishedVersionError,
} from "./agent.deploy";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const baseAgent = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "my-agent",
  name: "My Agent",
  description: null,
  agentType: "custom",
  status: "active",
  deploymentStatus: "inactive",
  activeVersionId: "ver-1",
};

const managedAgent = {
  ...baseAgent,
  publicId: "agt_builtin",
  slug: "qa-chat",
  agentType: "interactive_chat",
};

beforeEach(() => fake.reset());

describe("agent.deploy handler", () => {
  it("activates an agent with a published active version", async () => {
    fake.enqueue(
      [baseAgent], // resolveAgent
      [{ isPublished: true }], // active version check
      [], // update
    );
    const out = await agentDeployHandler(
      { agentId: "agt_1", deploymentStatus: "active" },
      CTX,
    );
    expect(out.deploymentStatus).toBe("active");
  });

  it("rejects activation when there is no active version", async () => {
    fake.enqueue([{ ...baseAgent, activeVersionId: null }]);
    await expect(
      agentDeployHandler({ agentId: "agt_1", deploymentStatus: "active" }, CTX),
    ).rejects.toBeInstanceOf(AgentDeployRequiresPublishedVersionError);
  });

  it("rejects activation when the active version is not published", async () => {
    fake.enqueue([baseAgent], [{ isPublished: false }]);
    await expect(
      agentDeployHandler({ agentId: "agt_1", deploymentStatus: "active" }, CTX),
    ).rejects.toBeInstanceOf(AgentDeployRequiresPublishedVersionError);
  });

  it("always allows deactivation (no published-version check)", async () => {
    fake.enqueue(
      [{ ...baseAgent, activeVersionId: null }], // resolveAgent
      [], // update
    );
    const out = await agentDeployHandler(
      { agentId: "agt_1", deploymentStatus: "inactive" },
      CTX,
    );
    expect(out.deploymentStatus).toBe("inactive");
  });

  it("throws AgentManagedReadOnlyError for a managed agent and performs no mutation", async () => {
    fake.enqueue([managedAgent]); // resolveAgent → managed
    const err = await agentDeployHandler(
      { agentId: "agt_builtin", deploymentStatus: "inactive" },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe(
      "agent_managed_read_only",
    );
    // The guard fires before any write — no insert/update/delete was issued.
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentDeployHandler(
        { agentId: "missing", deploymentStatus: "inactive" },
        CTX,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("throws without an authenticated user", async () => {
    await expect(
      agentDeployHandler(
        { agentId: "agt_1", deploymentStatus: "inactive" },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });
});
