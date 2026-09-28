import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  resolve: vi.fn(),
  role: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.db,
}));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolve }));
vi.mock("./lib/capability-role-guard", () => ({
  assertContractRole: mocks.role,
}));

import { tachoMemoriesIngest as contract } from "@oxagen/oxagen/contracts/tacho.memories.ingest";
import { memoryIntakeSchema } from "./memory/runner";
import { createTachoMemoriesIngestHandler } from "./tacho.memories.ingest";

const HOST = "tch_0123456789abcdefghjkmn";
const input = contract.input.parse({
  host_enrollment_id: HOST,
  harness: "stella",
  path: "/home/dev/.stella/memories/ledger.md",
  statement: "Keep the ledger append-only.",
});
const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "host-key",
  requestId: "req",
  messageId: null,
  surface: "api",
};
const denied = () =>
  new CapabilityError(
    "ingest_tacho_memories",
    "authz_denied",
    "Forbidden: host enrollment mismatch",
  );

function handlerWith(result = { written: 1, refused: 0 }) {
  const ingest = vi.fn(async () => result);
  return { ingest, handler: createTachoMemoriesIngestHandler({ ingest }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.resolve.mockResolvedValue({ agentKey: "agent.laptop" });
  mocks.role.mockResolvedValue("Owner");
});

describe("ingest_tacho_memories", () => {
  it("stores the memory as the host's agent, with no run", async () => {
    const { ingest, handler } = handlerWith();
    await expect(handler(input, ctx)).resolves.toEqual({ stored: true });
    expect(mocks.resolve).toHaveBeenCalledWith(
      "ingest_tacho_memories",
      ctx,
      {},
      HOST,
    );
    expect(mocks.role).toHaveBeenCalledWith(contract, ctx);
    expect(ingest).toHaveBeenCalledWith(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      [
        {
          capture: "local_gateway",
          source: "stella:/home/dev/.stella/memories/ledger.md",
          statement: "Keep the ledger append-only.",
          agentLineage: "agent.laptop",
          runPublicId: null,
        },
      ],
    );
  });

  it("sends the memory runner a memory its intake schema accepts", async () => {
    const { ingest, handler } = handlerWith();
    await handler(input, ctx);
    const [, inputs] = ingest.mock.calls[0] as unknown as [unknown, unknown[]];
    expect(memoryIntakeSchema.safeParse(inputs[0]).success).toBe(true);
  });

  it("answers stored false when the workspace already holds the memory", async () => {
    const { handler } = handlerWith({ written: 0, refused: 0 });
    await expect(handler(input, ctx)).resolves.toEqual({ stored: false });
  });

  it("stores nothing for a key that does not name this host", async () => {
    mocks.resolve.mockRejectedValue(denied());
    const { ingest, handler } = handlerWith();
    await expect(handler(input, ctx)).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(mocks.role).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("stores nothing when the key's creator lost the role", async () => {
    mocks.role.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { code: "forbidden" }),
    );
    const { ingest, handler } = handlerWith();
    await expect(handler(input, ctx)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("answers invalid input when the runner refuses the memory", async () => {
    const { handler } = handlerWith({ written: 0, refused: 1 });
    const error = await handler(input, ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({ code: "invalid_input" });
  });
});
