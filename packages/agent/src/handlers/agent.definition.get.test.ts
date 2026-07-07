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

import { agentDefinitionGetHandler } from "./agent.definition.get";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const CONFIG = {
  graph: {
    ontologyId: "ont_1",
    mode: "read",
    retrieval: { strategy: "hybrid" },
    budget: { maxHops: 2, maxNodes: 20 },
  },
  agentTools: [{ type: "skill", ref: "coding" }],
  triggers: [],
};

const ACTIVE_AGENT = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "qa-chat",
  name: "QA",
  description: "desc",
  agentType: "interactive_chat",
  status: "active",
  deploymentStatus: "active",
  activeVersionId: "ver-1",
};

beforeEach(() => fake.reset());

describe("agent.definition.get handler", () => {
  it("returns the active version config, parsed", async () => {
    fake.enqueue(
      [ACTIVE_AGENT], // resolveAgent
      [{ version: 1, isPublished: true, config: CONFIG }], // active version
    );
    const out = await agentDefinitionGetHandler({ agentId: "agt_1" }, CTX);
    expect(out.slug).toBe("qa-chat");
    expect(out.version).toBe(1);
    expect(out.isPublished).toBe(true);
    expect(out.config.agentTools).toHaveLength(1);
  });

  it("sets managed=true when agentType is interactive_chat", async () => {
    fake.enqueue(
      [ACTIVE_AGENT], // agentType: "interactive_chat"
      [{ version: 1, isPublished: true, config: CONFIG }],
    );
    const out = await agentDefinitionGetHandler({ agentId: "agt_1" }, CTX);
    expect(out.managed).toBe(true);
  });

  it("sets managed=false for a custom agentType", async () => {
    fake.enqueue(
      [{ ...ACTIVE_AGENT, agentType: "custom" }],
      [{ version: 1, isPublished: true, config: CONFIG }],
    );
    const out = await agentDefinitionGetHandler({ agentId: "agt_1" }, CTX);
    expect(out.managed).toBe(false);
  });

  it("falls back to the latest version when no active version is set", async () => {
    fake.enqueue(
      [{ ...ACTIVE_AGENT, activeVersionId: null, status: "draft" }], // resolveAgent
      [{ version: 2, isPublished: false, config: CONFIG }], // latest version
    );
    const out = await agentDefinitionGetHandler({ agentId: "agt_1" }, CTX);
    expect(out.version).toBe(2);
    expect(out.isPublished).toBe(false);
  });

  it("throws when no version config exists (corrupt row)", async () => {
    fake.enqueue(
      [{ ...ACTIVE_AGENT, activeVersionId: null }],
      [], // no latest version
    );
    await expect(
      agentDefinitionGetHandler({ agentId: "agt_1" }, CTX),
    ).rejects.toThrow(/no version config/);
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentDefinitionGetHandler({ agentId: "missing" }, CTX),
    ).rejects.toThrow(/not found/);
  });

  it("composes agentKey as org_ns.workspace_ns.slug", async () => {
    fake.enqueue(
      [ACTIVE_AGENT], // resolveAgent
      [{ version: 1, isPublished: true, config: CONFIG }], // active version
      [{ orgNamespace: "acme", workspaceNamespace: "core" }], // resolveNamespacePrefix
    );
    const out = await agentDefinitionGetHandler({ agentId: "agt_1" }, CTX);
    expect(out.agentKey).toBe("acme.core.qa-chat");
  });

  it("returns null agentKey when a namespace is missing (pre-backfill safety)", async () => {
    fake.enqueue(
      [ACTIVE_AGENT],
      [{ version: 1, isPublished: true, config: CONFIG }],
      [{ orgNamespace: null, workspaceNamespace: "core" }],
    );
    const out = await agentDefinitionGetHandler({ agentId: "agt_1" }, CTX);
    expect(out.agentKey).toBeNull();
  });
});
