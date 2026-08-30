import { describe, expect, it, beforeEach, vi } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { a2aCardGetHandler } from "./a2a.card.get";
import { a2aAgentCard } from "@oxagen/oxagen/contracts/a2a.card.get";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

beforeEach(() => fake.reset());

describe("a2a.card.get handler", () => {
  it("builds a spec-valid Agent Card with the baseline chat skill", async () => {
    fake.enqueue([]);
    const card = await a2aCardGetHandler(
      { baseUrl: "https://api.example.test" },
      CTX,
    );
    // The output must satisfy the contract's AgentCard schema exactly.
    expect(() => a2aAgentCard.parse(card)).not.toThrow();
    expect(card.protocolVersion).toBe("1.0");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.url).toBe("https://api.example.test/a2a");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    // Baseline conversational skill is always present.
    expect(card.skills[0]!.id).toBe("chat");
    // HTTP Bearer security scheme is advertised.
    expect(card.securitySchemes.apiKey!.scheme).toBe("bearer");
    expect(card.security).toEqual([{ apiKey: [] }]);
  });

  it("maps each active agent definition to an A2A skill after the baseline", async () => {
    fake.enqueue([
      {
        publicId: "agt_1",
        slug: "researcher",
        name: "Researcher",
        description: "Digs",
      },
      { publicId: "agt_2", slug: "writer", name: "Writer", description: null },
    ]);
    const card = await a2aCardGetHandler({ baseUrl: "https://x.test" }, CTX);
    expect(card.skills.map((s) => s.id)).toEqual([
      "chat",
      "researcher",
      "writer",
    ]);
    // A null description falls back to a generated one, never null.
    const writer = card.skills.find((s) => s.id === "writer")!;
    expect(typeof writer.description).toBe("string");
    expect(writer.description.length).toBeGreaterThan(0);
  });

  it("strips a trailing slash from the base URL", async () => {
    fake.enqueue([]);
    const card = await a2aCardGetHandler({ baseUrl: "https://x.test/" }, CTX);
    expect(card.url).toBe("https://x.test/a2a");
  });
});
