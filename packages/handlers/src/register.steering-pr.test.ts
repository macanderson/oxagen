// Loading the handler registrations installs both halves of the steering PR
// seam: the opener from tools.pr.open.ts (M11) and the server folder writer
// from mcp-studio/migrate.ts (M13). steeringWriter() needs both. Neither half
// loads its module at boot, so boot opens no host client and loads no
// @oxagen/mcp-studio code.
import {
  steeringPrOpener,
  steeringWriter,
  type AddServerRequest,
  type AddToolsRequest,
  type OpenSteeringPrRequest,
} from "@oxagen/agent/runtime/steering-pr";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loaded: { opener: false, writer: false },
  hasSteeringRepo: vi.fn(async () => true),
  open: vi.fn(async () => OPENED),
  readFile: vi.fn(async () => "[server]\n"),
  addServer: vi.fn(async () => OPENED),
  addTools: vi.fn(async () => OPENED),
  withTenantDb: vi.fn(async () => 0),
}));

const OPENED = {
  number: 7,
  url: "https://github.com/acme/steering/pull/7",
  branch: "tools/linear",
};

vi.mock("./tools.pr.open", () => {
  mocks.loaded.opener = true;
  return {
    steeringPrOpener: {
      hasSteeringRepo: mocks.hasSteeringRepo,
      open: mocks.open,
      readFile: mocks.readFile,
    },
  };
});

vi.mock("./mcp-studio/migrate", () => {
  mocks.loaded.writer = true;
  return {
    createServerFolderWriter: () => ({
      addServer: mocks.addServer,
      addTools: mocks.addTools,
    }),
  };
});

// steeringWriter() counts the legacy rows a migration would still move. The
// count reads through withTenantDb, which this double answers with 0. The
// organization seam gets the same double, so a read that moves to withOrgDb
// (ADR-086) meets the double rather than a real seam with no tenant scope.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb, withOrgDb: mocks.withTenantDb };
});

await import("./register");

const scope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

describe("the handler registrations", () => {
  it("register both halves of the steering PR seam and load neither", async () => {
    expect(steeringPrOpener()).not.toBeNull();
    expect(mocks.loaded).toEqual({ opener: false, writer: false });

    // A workspace with a steering repo and no legacy rows left gets the
    // writer. Asking loads the opener's module, not the writer's.
    const writer = await steeringWriter(scope);
    expect(writer).not.toBeNull();
    expect(mocks.hasSteeringRepo).toHaveBeenCalledWith(scope);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(mocks.loaded).toEqual({ opener: true, writer: false });

    // The writer's module loads on its first write.
    const tools: AddToolsRequest = {
      ...scope,
      serverId: "srv_1",
      toolNames: ["create_issue"],
      actorUserId: "user_1",
    };
    await expect(writer!.addTools(tools)).resolves.toEqual(OPENED);
    expect(mocks.addTools).toHaveBeenCalledWith(tools);
    expect(mocks.loaded).toEqual({ opener: true, writer: true });

    const server: AddServerRequest = {
      ...scope,
      serverId: "srv_2",
      actorUserId: "user_1",
    };
    await expect(writer!.addServer(server)).resolves.toEqual(OPENED);
    expect(mocks.addServer).toHaveBeenCalledWith(server);
  });

  it("forward the opener's calls to tools.pr.open", async () => {
    const opener = steeringPrOpener()!;
    const request: OpenSteeringPrRequest = {
      ...scope,
      actorUserId: "user_1",
      branch: "tools/linear",
      title: "Add the linear server",
      body: "",
      files: [{ path: "tools/servers/linear/server.toml", content: "[server]\n" }],
    };
    await expect(opener.open(request)).resolves.toEqual(OPENED);
    expect(mocks.open).toHaveBeenCalledWith(request);
    await expect(
      opener.readFile(scope, "tools/servers/linear/server.toml"),
    ).resolves.toBe("[server]\n");
    expect(mocks.readFile).toHaveBeenCalledWith(
      scope,
      "tools/servers/linear/server.toml",
    );
  });

  it("keep direct row writes when the workspace has no steering repo", async () => {
    mocks.hasSteeringRepo.mockResolvedValueOnce(false);
    await expect(steeringWriter(scope)).resolves.toBeNull();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
