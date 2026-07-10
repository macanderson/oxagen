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
        avatarUrl: 'avatar:v1:{"emoji":"🤖","bg":"#f59e0b","mode":"full"}',
        summary: "Answers questions from the workspace graph.",
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
        avatarUrl: null,
        summary: null,
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
    // avatar + summary flow through; null when unset.
    expect(out.agents[0]!.avatarUrl).toContain("avatar:v1:");
    expect(out.agents[0]!.summary).toBe(
      "Answers questions from the workspace graph.",
    );
    expect(out.agents[1]!.avatarUrl).toBeNull();
    expect(out.agents[1]!.summary).toBeNull();
    // No selectedConfig on the rows ⇒ toolRefs defaults to an empty array.
    expect(out.agents[0]!.toolRefs).toEqual([]);
    expect(out.agents[1]!.toolRefs).toEqual([]);
  });

  it("extracts refs-only toolRefs from the selected version config", async () => {
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
        latestVersion: 3,
        // Mirrors the jsonb the pg driver returns for agent_versions.config.
        selectedConfig: {
          agentTools: [
            { type: "skill", ref: "web-search", config: { pin: "1.2.0" } },
            { type: "mcp_server", ref: "github", config: { auth: "oauth" } },
            { type: "function", ref: "sum" },
            { type: "agent", ref: "agt_child" },
          ],
        },
      },
    ]);
    const out = await agentDefinitionListHandler({}, CTX);
    // type + ref only — the per-tool `config` payloads are dropped.
    expect(out.agents[0]!.toolRefs).toEqual([
      { type: "skill", ref: "web-search" },
      { type: "mcp_server", ref: "github" },
      { type: "function", ref: "sum" },
      { type: "agent", ref: "agt_child" },
    ]);
  });

  it("is defensive against a malformed / partial config (never throws)", async () => {
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
        selectedConfig: {
          agentTools: [
            { type: "skill", ref: "keep-me" }, // valid → kept
            { type: "not-a-type", ref: "x" }, // unknown type → dropped
            { type: "skill" }, // missing ref → dropped
            { type: "skill", ref: "" }, // empty ref → dropped
            null, // not an object → dropped
            "nope", // not an object → dropped
          ],
        },
      },
      {
        id: "uuid-2",
        publicId: "agt_2",
        slug: "broken",
        name: "Broken",
        description: null,
        agentType: "custom",
        status: "draft",
        deploymentStatus: "inactive",
        latestVersion: null,
        // agentTools absent / config the wrong shape ⇒ [].
        selectedConfig: { notTools: 1 },
      },
    ]);
    const out = await agentDefinitionListHandler({}, CTX);
    expect(out.agents[0]!.toolRefs).toEqual([
      { type: "skill", ref: "keep-me" },
    ]);
    expect(out.agents[1]!.toolRefs).toEqual([]);
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
