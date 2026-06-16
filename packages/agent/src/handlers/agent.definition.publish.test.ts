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

import { agentDefinitionPublishHandler } from "./agent.definition.publish";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "qa-chat",
  name: "QA",
  description: null,
  agentType: "interactive_chat",
  status: "draft",
  deploymentStatus: "inactive",
  activeVersionId: null,
};

const CONFIG = {
  graph: {
    ontologyId: "ont_1",
    mode: "read",
    retrieval: { strategy: "hybrid" },
    budget: { maxHops: 2, maxNodes: 20 },
  },
  agentTools: [],
  triggers: [],
};

beforeEach(() => fake.reset());

describe("agent.definition.publish handler", () => {
  it("publishes an explicit version, computes a checksum, wires active version", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [{ id: "ver-uuid", isPublished: false, config: CONFIG }], // version lookup
      [], // update version
      [], // update agent
    );
    const out = await agentDefinitionPublishHandler(
      { agentId: "agt_1", version: 1 },
      CTX,
    );
    expect(out.version).toBe(1);
    expect(out.activeVersionId).toBe("ver-uuid");
    expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publishes the latest version when none specified", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [{ version: 4 }], // latest version
      [{ id: "ver-4", isPublished: false, config: CONFIG }], // version lookup
      [],
      [],
    );
    const out = await agentDefinitionPublishHandler({ agentId: "agt_1" }, CTX);
    expect(out.version).toBe(4);
  });

  it("rejects publishing an already-published (immutable) version", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ id: "ver-1", isPublished: true, config: CONFIG }],
    );
    await expect(
      agentDefinitionPublishHandler({ agentId: "agt_1", version: 1 }, CTX),
    ).rejects.toThrow(/already published/);
  });

  it("throws when the target version is not found", async () => {
    fake.enqueue([AGENT_ROW], []); // version lookup empty
    await expect(
      agentDefinitionPublishHandler({ agentId: "agt_1", version: 9 }, CTX),
    ).rejects.toThrow(/not found/);
  });

  it("throws when the agent has no versions to publish", async () => {
    fake.enqueue([AGENT_ROW], []); // latest version query empty
    await expect(
      agentDefinitionPublishHandler({ agentId: "agt_1" }, CTX),
    ).rejects.toThrow(/no versions/);
  });

  it("throws without an authenticated user", async () => {
    await expect(
      agentDefinitionPublishHandler(
        { agentId: "agt_1" },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });
});
