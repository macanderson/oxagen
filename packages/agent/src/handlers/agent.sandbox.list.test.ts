import { describe, expect, it, beforeEach, vi } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const fake = createFakeTx();
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { agentSandboxListHandler } from "./agent.sandbox.list";

const ROW = {
  publicId: "sbx_1",
  sessionKey: "conv_42",
  image: "agent",
  status: "running",
  driver: "modal",
  lastUsedAt: new Date("2026-07-08T10:00:00.000Z"),
  expiresAt: new Date("2026-07-09T10:00:00.000Z"),
  createdAt: new Date("2026-07-08T09:00:00.000Z"),
};

beforeEach(() => {
  fake.reset();
});

describe("agent.sandbox.list handler", () => {
  it("maps registry rows to the output shape with ISO timestamps", async () => {
    fake.enqueue([{ ...ROW }]);

    const out = await agentSandboxListHandler({ limit: 50 }, CTX);

    expect(out.sandboxes).toEqual([
      {
        sessionId: "sbx_1",
        sessionKey: "conv_42",
        image: "agent",
        status: "running",
        driver: "modal",
        lastUsedAt: "2026-07-08T10:00:00.000Z",
        expiresAt: "2026-07-09T10:00:00.000Z",
        createdAt: "2026-07-08T09:00:00.000Z",
      },
    ]);
  });

  it("serializes null lastUsedAt / expiresAt / sessionKey as null", async () => {
    fake.enqueue([
      {
        ...ROW,
        sessionKey: null,
        lastUsedAt: null,
        expiresAt: null,
      },
    ]);

    const out = await agentSandboxListHandler({ limit: 50 }, CTX);

    expect(out.sandboxes[0]).toMatchObject({
      sessionKey: null,
      lastUsedAt: null,
      expiresAt: null,
      createdAt: "2026-07-08T09:00:00.000Z",
    });
  });

  it("returns an empty array when the workspace has no sessions", async () => {
    fake.enqueue([]);

    const out = await agentSandboxListHandler({ limit: 50 }, CTX);

    expect(out.sandboxes).toEqual([]);
  });

  it("passes an optional status filter through without error", async () => {
    fake.enqueue([{ ...ROW, status: "idle" }]);

    const out = await agentSandboxListHandler({ status: "idle", limit: 10 }, CTX);

    expect(out.sandboxes).toHaveLength(1);
    expect(out.sandboxes[0]!.status).toBe("idle");
  });
});
