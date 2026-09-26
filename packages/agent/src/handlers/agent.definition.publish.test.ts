import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { agentDefinitionPublishHandler } from "./agent.definition.publish";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "my-agent",
  name: "My Agent",
  description: null,
  agentType: "custom",
  status: "draft",
  deploymentStatus: "inactive",
  activeVersionId: null,
};

const MANAGED_AGENT_ROW = {
  ...AGENT_ROW,
  publicId: "agt_builtin",
  slug: "qa-chat",
  agentType: "interactive_chat",
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
      [{ id: "uuid-1" }], // update agent returning
    );
    const out = await agentDefinitionPublishHandler(
      { agentId: "agt_1", version: 1 },
      CTX,
    );
    expect(out.version).toBe(1);
    expect(out.activeVersionId).toBe("ver-uuid");
    expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    'schema = "agent-definition/v0.1"\nslug = "my-agent"\n[budget]\nper_run_micros = 900000000',
    'schema = "agent-definition/v0.1"\nslug = "my-agent"',
    "[budget",
    "",
  ])(
    "refuses Git-backed source before activation: %s",
    async (definitionSource) => {
      fake.enqueue(
        [AGENT_ROW],
        [
          {
            id: "ver-uuid",
            isPublished: false,
            config: CONFIG,
            definitionSource,
          },
        ],
      );
      await expect(
        agentDefinitionPublishHandler({ agentId: "agt_1", version: 1 }, CTX),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "git_definition_requires_merge",
      });
      expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
    },
  );

  it.each([NaN, Infinity, -1, 0, 1.5])(
    "refuses invalid legacy budget before activation: %s",
    async (perRunMicros) => {
      fake.enqueue(
        [AGENT_ROW],
        [
          {
            id: "ver-uuid",
            isPublished: false,
            definitionSource: null,
            config: { ...CONFIG, budget: { per_run_micros: perRunMicros } },
          },
        ],
      );
      await expect(
        agentDefinitionPublishHandler({ agentId: "agt_1", version: 1 }, CTX),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "invalid_definition_budget",
      });
      expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
    },
  );

  it("publishes the latest version when none specified", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [{ version: 4 }], // latest version
      [{ id: "ver-4", isPublished: false, config: CONFIG }], // version lookup
      [],
      [{ id: "uuid-1" }], // update agent returning
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

  it("throws AgentManagedReadOnlyError for a managed agent and performs no mutation", async () => {
    fake.enqueue([MANAGED_AGENT_ROW]); // resolveAgent → managed
    const err = await agentDefinitionPublishHandler(
      { agentId: "agt_builtin", version: 1 },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe(
      "agent_managed_read_only",
    );
    // The guard fires before any write — no insert/update/delete was issued.
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("refuses a retired (archived) agent before any write, so publish cannot un-retire it", async () => {
    fake.enqueue([{ ...AGENT_ROW, status: "archived" }]); // resolveAgent
    await expect(
      agentDefinitionPublishHandler({ agentId: "agt_1", version: 1 }, CTX),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_retired",
      message: 'Agent "my-agent" is retired',
    });
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("refuses when retire_agent archives the row between the guard and the agent write", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent reads the row before the retirement commits
      [{ id: "ver-uuid", isPublished: false, config: CONFIG }], // version lookup
      [], // update version
      [], // update agent: the `status <> 'archived'` predicate matches nothing
    );
    await expect(
      agentDefinitionPublishHandler({ agentId: "agt_1", version: 1 }, CTX),
    ).rejects.toMatchObject({ code: "conflict", reason: "agent_retired" });
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
