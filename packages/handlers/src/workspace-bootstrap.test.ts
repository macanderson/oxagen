import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Tx } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  bootstrapWorkspaceAgents: vi.fn(async () => undefined),
  seedWorkspaceDefaultRegistry: vi.fn(async () => "mreg_1"),
  seedWorkspaceDefaultEnvironment: vi.fn(async () => "env_1"),
}));

vi.mock("./workspace-agents", () => ({
  bootstrapWorkspaceAgents: mocks.bootstrapWorkspaceAgents,
}));
vi.mock("./workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistry: mocks.seedWorkspaceDefaultRegistry,
}));
vi.mock("./workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironment: mocks.seedWorkspaceDefaultEnvironment,
}));

import { bootstrapWorkspace } from "./workspace-bootstrap";

const WS_ROW = {
  id: "ws_internal",
  publicId: "ws_pub",
  name: "Core",
  slug: "core",
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

/** A fake transaction recording the values each insert receives. */
function makeTx(opts: {
  takenNamespaces?: string[];
  returning?: Array<typeof WS_ROW>;
  insertError?: Error;
}) {
  const inserts: Array<Record<string, unknown>> = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: async () =>
          (opts.takenNamespaces ?? []).map((namespace) => ({ namespace })),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        if (opts.insertError) throw opts.insertError;
        inserts.push(v);
        return {
          returning: async () => opts.returning ?? [WS_ROW],
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(res),
        };
      },
    }),
  };
  return { tx: tx as unknown as Tx, inserts };
}

const ARGS = { orgId: "org_1", userId: "u_1", name: "Core", slug: "core" };

describe("bootstrapWorkspace", () => {
  beforeEach(() => {
    mocks.bootstrapWorkspaceAgents.mockClear();
    mocks.seedWorkspaceDefaultRegistry.mockClear();
    mocks.seedWorkspaceDefaultEnvironment.mockClear();
  });

  it("inserts the workspace with a namespace derived from the slug and the owner membership", async () => {
    const { tx, inserts } = makeTx({});
    const ws = await bootstrapWorkspace({ tx, ...ARGS });

    expect(ws).toEqual(WS_ROW);
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        orgId: "org_1",
        name: "Core",
        slug: "core",
        namespace: "core",
        createdByUserId: "u_1",
      }),
    );
    expect(inserts[1]).toEqual(
      expect.objectContaining({
        workspaceId: "ws_internal",
        userId: "u_1",
        role: "owner",
      }),
    );
  });

  it("avoids a namespace another workspace in the org already holds", async () => {
    const { tx, inserts } = makeTx({ takenNamespaces: ["core"] });
    await bootstrapWorkspace({ tx, ...ARGS });
    expect(inserts[0]?.namespace).not.toBe("core");
    expect(String(inserts[0]?.namespace)).toMatch(/^[a-z0-9]{2,6}$/);
  });

  it("seeds the agent, the registry and the environment on the same transaction", async () => {
    const { tx } = makeTx({});
    await bootstrapWorkspace({ tx, ...ARGS });

    const seeded = { orgId: "org_1", workspaceId: "ws_internal", tx };
    expect(mocks.bootstrapWorkspaceAgents).toHaveBeenCalledWith({
      ...seeded,
      userId: "u_1",
    });
    expect(mocks.seedWorkspaceDefaultRegistry).toHaveBeenCalledWith(seeded);
    expect(mocks.seedWorkspaceDefaultEnvironment).toHaveBeenCalledWith(seeded);
  });

  it("throws when the insert returns no row and seeds nothing", async () => {
    const { tx } = makeTx({ returning: [] });
    await expect(bootstrapWorkspace({ tx, ...ARGS })).rejects.toThrow(
      "workspace insert returned no row",
    );
    expect(mocks.bootstrapWorkspaceAgents).not.toHaveBeenCalled();
    expect(mocks.seedWorkspaceDefaultRegistry).not.toHaveBeenCalled();
    expect(mocks.seedWorkspaceDefaultEnvironment).not.toHaveBeenCalled();
  });

  it("lets a unique violation reach the caller unchanged", async () => {
    const dup = Object.assign(new Error("dup"), { code: "23505" });
    const { tx } = makeTx({ insertError: dup });
    await expect(bootstrapWorkspace({ tx, ...ARGS })).rejects.toBe(dup);
  });
});
