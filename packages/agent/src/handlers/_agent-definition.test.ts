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
  isUuid,
  resolveAgent,
  resolveAgentForA2A,
  AgentManagedReadOnlyError,
  assertAgentMutable,
} from "./_agent-definition";

beforeEach(() => fake.reset());

describe("isUuid", () => {
  it("accepts a canonical UUID", () => {
    expect(isUuid("018f1a2b-3c4d-7e6f-8a9b-0c1d2e3f4a5b")).toBe(true);
  });
  it("rejects a public id", () => {
    expect(isUuid("agt_abc")).toBe(false);
  });
  it("rejects a slug", () => {
    expect(isUuid("qa-chat")).toBe(false);
  });
});

describe("resolveAgent (no-tx path)", () => {
  it("resolves via withTenantDb when no tx is passed", async () => {
    fake.enqueue([{ id: "uuid-1", publicId: "agt_1", slug: "qa-chat" }]);
    const row = await resolveAgent("qa-chat", "ws_1");
    expect(row?.publicId).toBe("agt_1");
  });

  it("returns null when nothing matches", async () => {
    fake.enqueue([]);
    const row = await resolveAgent("agt_x", "ws_1");
    expect(row).toBeNull();
  });

  it("resolves by UUID identifier", async () => {
    fake.enqueue([
      {
        id: "018f1a2b-3c4d-7e6f-8a9b-0c1d2e3f4a5b",
        publicId: "agt_1",
        slug: "s",
      },
    ]);
    const row = await resolveAgent(
      "018f1a2b-3c4d-7e6f-8a9b-0c1d2e3f4a5b",
      "ws_1",
    );
    expect(row?.publicId).toBe("agt_1");
  });
});

describe("resolveAgentForA2A (no-tx path)", () => {
  it("resolves an active/deployed agent with its active version's instructions", async () => {
    fake.enqueue([
      {
        id: "uuid-1",
        publicId: "agt_1",
        slug: "qa-chat",
        name: "QA Chat",
        description: null,
        agentType: "custom",
        status: "active",
        deploymentStatus: "active",
        activeVersionId: "ver-1",
        activeVersionId2: "ver-1",
        activeVersionConfig: { instructions: "Be terse." },
      },
    ]);
    const agent = await resolveAgentForA2A("ws_1", "qa-chat");
    expect(agent?.publicId).toBe("agt_1");
    expect(agent?.activeVersion).toEqual({
      id: "ver-1",
      instructions: "Be terse.",
    });
  });

  it("returns null for an unknown slug (no throw)", async () => {
    fake.enqueue([]);
    const agent = await resolveAgentForA2A("ws_1", "does-not-exist");
    expect(agent).toBeNull();
  });

  it("returns an agent with a null activeVersion when it has no published version", async () => {
    fake.enqueue([
      {
        id: "uuid-2",
        publicId: "agt_2",
        slug: "draftless",
        name: "Draftless",
        description: null,
        agentType: "custom",
        status: "active",
        deploymentStatus: "active",
        activeVersionId: null,
        activeVersionId2: null,
        activeVersionConfig: null,
      },
    ]);
    const agent = await resolveAgentForA2A("ws_1", "draftless");
    expect(agent?.activeVersion).toBeNull();
  });
});

describe("AgentManagedReadOnlyError", () => {
  it("carries the stable error code", () => {
    const err = new AgentManagedReadOnlyError("agt_1");
    expect(err.code).toBe("agent_managed_read_only");
    expect(err.name).toBe("AgentManagedReadOnlyError");
    expect(err.message).toMatch(/agt_1/);
  });
});

describe("assertAgentMutable", () => {
  it("does not throw for a custom agent", () => {
    expect(() =>
      assertAgentMutable({
        agentType: "custom",
        publicId: "agt_1",
        slug: "my-agent",
      }),
    ).not.toThrow();
  });

  it("throws AgentManagedReadOnlyError for a managed agent", () => {
    expect(() =>
      assertAgentMutable({
        agentType: "interactive_chat",
        publicId: "agt_builtin",
        slug: "qa-chat",
      }),
    ).toThrow(AgentManagedReadOnlyError);
  });

  it("thrown error has the correct code and message", () => {
    let caught: unknown;
    try {
      assertAgentMutable({
        agentType: "interactive_chat",
        publicId: "agt_builtin",
        slug: "qa-chat",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentManagedReadOnlyError);
    const err = caught as AgentManagedReadOnlyError;
    expect(err.code).toBe("agent_managed_read_only");
    expect(err.message).toContain("agt_builtin");
  });
});
