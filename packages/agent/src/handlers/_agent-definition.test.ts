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

import { isUuid, resolveAgent, resolveTrigger } from "./_agent-definition";

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
    fake.enqueue([{ id: "018f1a2b-3c4d-7e6f-8a9b-0c1d2e3f4a5b", publicId: "agt_1", slug: "s" }]);
    const row = await resolveAgent(
      "018f1a2b-3c4d-7e6f-8a9b-0c1d2e3f4a5b",
      "ws_1",
    );
    expect(row?.publicId).toBe("agt_1");
  });
});

describe("resolveTrigger (no-tx path)", () => {
  it("resolves by public id", async () => {
    fake.enqueue([{ id: "t-uuid", publicId: "atr_1", agentId: "uuid-1" }]);
    const row = await resolveTrigger("atr_1", "ws_1");
    expect(row?.publicId).toBe("atr_1");
  });

  it("returns null when nothing matches", async () => {
    fake.enqueue([]);
    const row = await resolveTrigger("atr_x", "ws_1");
    expect(row).toBeNull();
  });
});
