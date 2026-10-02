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

import { tachoMemoryUsesRecord as contract } from "@oxagen/oxagen/contracts/tacho.memories.uses.record";
import {
  createTachoMemoryUsesRecordHandler,
  type TachoMemoryUsesRecordDeps,
} from "./tacho.memories.uses.record";

const HOST = "tch_0123456789abcdefghjkmn";
const ROOT = "/home/dev/.claude/projects/";
const FILE = `${ROOT}-proj/memory/use-pnpm.md`;
const SESSION = "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f";
const LATE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "host-key",
  requestId: "req",
  messageId: null,
  surface: "api",
};
const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

const use = (over: Record<string, unknown> = {}) => ({
  harness: "claude-code",
  path: FILE,
  session_uuid: SESSION,
  count: 1,
  used_at: "2026-10-01T11:00:00.000Z",
  ...over,
});

function handlerWith(over: Partial<TachoMemoryUsesRecordDeps> = {}) {
  const deps = {
    runsOf: vi.fn(async () => new Map([[SESSION, "tse_run1"]])),
    recordUses: vi.fn(async (_scope: unknown, uses: unknown[]) => ({
      recorded: uses.length,
      unknown: 0,
    })),
    retireMissing: vi.fn(async () => 2),
    now: () => NOW,
    ...over,
  };
  return { deps, handler: createTachoMemoryUsesRecordHandler(deps) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.resolve.mockResolvedValue({ id: "host-uuid", agentKey: "agent.laptop" });
  mocks.role.mockResolvedValue("Owner");
});

describe("record_tacho_memory_uses", () => {
  it("stores each read as a use of the file's memory in the run the session names", async () => {
    const { deps, handler } = handlerWith();
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      uses: [use({ count: 2 })],
    });
    await expect(handler(input, ctx)).resolves.toEqual({
      recorded: 1,
      unknown: 0,
      pending: [],
      retired: 0,
    });
    expect(mocks.resolve).toHaveBeenCalledWith(
      "record_tacho_memory_uses",
      ctx,
      {},
      HOST,
    );
    expect(mocks.role).toHaveBeenCalledWith(contract, ctx);
    expect(deps.runsOf).toHaveBeenCalledWith(scope, "host-uuid", [SESSION]);
    expect(deps.recordUses).toHaveBeenCalledWith(scope, [
      {
        capture: "local_gateway",
        source: `claude-code:${FILE}`,
        runPublicId: "tse_run1",
        signal: "read",
        count: 2,
        usedAt: new Date("2026-10-01T11:00:00.000Z"),
      },
    ]);
    expect(deps.retireMissing).not.toHaveBeenCalled();
  });

  it("answers a use whose run Oxagen has not recorded yet as pending, by its index", async () => {
    const { deps, handler } = handlerWith();
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      uses: [use({ session_uuid: LATE }), use(), use({ session_uuid: LATE })],
    });
    const answer = await handler(input, ctx);
    expect(answer.pending).toEqual([0, 2]);
    expect(answer.recorded).toBe(1);
    expect(deps.runsOf).toHaveBeenCalledWith(scope, "host-uuid", [
      LATE,
      SESSION,
    ]);
  });

  it("matches a session uuid sent in upper case", async () => {
    const { deps, handler } = handlerWith();
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      uses: [use({ session_uuid: SESSION.toUpperCase() })],
    });
    await expect(handler(input, ctx)).resolves.toMatchObject({
      recorded: 1,
      pending: [],
    });
    expect(deps.runsOf).toHaveBeenCalledWith(scope, "host-uuid", [SESSION]);
  });

  it("stamps a use from a host clock ahead of Oxagen's at Oxagen's time", async () => {
    const { deps, handler } = handlerWith();
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      uses: [use({ used_at: "2026-10-01T13:00:00.000Z" })],
    });
    await handler(input, ctx);
    const [, stored] = vi.mocked(deps.recordUses).mock.calls[0] as unknown as [
      unknown,
      Array<{ usedAt: Date }>,
    ];
    expect(stored[0]?.usedAt).toEqual(NOW);
  });

  it("passes on the uses the store found no memory for", async () => {
    const { handler } = handlerWith({
      recordUses: vi.fn(async () => ({ recorded: 0, unknown: 1 })),
    });
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      uses: [use()],
    });
    await expect(handler(input, ctx)).resolves.toMatchObject({
      recorded: 0,
      unknown: 1,
    });
  });

  it("retires what a full scan no longer found, for the host's agent and the scan's folder only", async () => {
    const { deps, handler } = handlerWith();
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      scans: [{ harness: "claude-code", root: ROOT, paths: [FILE] }],
    });
    await expect(handler(input, ctx)).resolves.toEqual({
      recorded: 0,
      unknown: 0,
      pending: [],
      retired: 2,
    });
    expect(deps.runsOf).not.toHaveBeenCalled();
    expect(deps.recordUses).not.toHaveBeenCalled();
    expect(deps.retireMissing).toHaveBeenCalledWith(
      scope,
      {
        capture: "local_gateway",
        prefix: `claude-code:${ROOT}`,
        seen: [`claude-code:${FILE}`],
        agentLineage: "agent.laptop",
      },
      NOW,
    );
  });

  it("stores nothing for a key that does not name this host", async () => {
    mocks.resolve.mockRejectedValue(
      new CapabilityError(
        "record_tacho_memory_uses",
        "authz_denied",
        "Forbidden: host enrollment mismatch",
      ),
    );
    const { deps, handler } = handlerWith();
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      uses: [use()],
      scans: [{ harness: "claude-code", root: ROOT, paths: [] }],
    });
    await expect(handler(input, ctx)).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(mocks.role).not.toHaveBeenCalled();
    expect(deps.recordUses).not.toHaveBeenCalled();
    expect(deps.retireMissing).not.toHaveBeenCalled();
  });

  it("stores nothing when the key's creator lost the role", async () => {
    mocks.role.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { code: "forbidden" }),
    );
    const { deps, handler } = handlerWith();
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      uses: [use()],
    });
    await expect(handler(input, ctx)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(deps.recordUses).not.toHaveBeenCalled();
  });
});
