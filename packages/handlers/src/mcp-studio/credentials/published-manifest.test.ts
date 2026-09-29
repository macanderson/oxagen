/**
 * publishedServers reads the tool manifest of each steering version a
 * workspace has published. The tenant seam is faked, so these tests hand it
 * bundle rows and check which servers come back.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toolManifestSchema, type ManifestServer, type ToolManifest } from "@oxagen/mcp-studio";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ bundle: unknown }>,
  inScope: false,
  scopedReads: [] as boolean[],
  select: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return { ...real, runInTenantScope: mocks.runInTenantScope };
});

import { schema } from "@oxagen/database";
import { publishedServers } from "./published-manifest";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SCOPE = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

/** MCP Studio's compiled fixture manifest: the billing and stripe servers. */
const MANIFEST: ToolManifest = toolManifestSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../../mcp-studio/fixtures/expected/tool-manifest.json", import.meta.url)),
      "utf8",
    ),
  ),
);

function server(name: string): ManifestServer {
  const found = MANIFEST.servers.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture manifest has no server ${name}`);
  return found;
}

/** A published bundle whose tools hold the given servers. */
function bundle(...servers: ManifestServer[]): { bundle: unknown } {
  return { bundle: { records: [], tools: { schema: "tool-manifest/v1", servers } } };
}

/** The drizzle chain publishedServers builds, ending in the chosen rows. */
const tx = {
  select: (columns: unknown) => {
    mocks.select(columns);
    return {
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(mocks.rows),
        }),
      }),
    };
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.inScope = false;
  mocks.scopedReads = [];
  mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => {
    mocks.inScope = true;
    try {
      return fn();
    } finally {
      mocks.inScope = false;
    }
  });
  mocks.withTenantDb.mockImplementation((fn: (t: typeof tx) => unknown) => {
    mocks.scopedReads.push(mocks.inScope);
    return fn(tx);
  });
});

// ── publishedServers ─────────────────────────────────────────────────────────

describe("publishedServers", () => {
  it("answers every server of a published version, keyed by name", async () => {
    mocks.rows = [{ bundle: { records: [], tools: MANIFEST } }];

    const servers = await publishedServers(SCOPE);

    expect([...servers.keys()]).toEqual(["billing", "stripe"]);
    expect(servers.get("billing")).toEqual(server("billing"));
    expect(servers.get("stripe")).toEqual(server("stripe"));
  });

  it("reads the version bundles inside the workspace's tenant scope", async () => {
    await publishedServers(SCOPE);

    expect(mocks.runInTenantScope).toHaveBeenCalledWith(SCOPE, expect.any(Function));
    expect(mocks.scopedReads).toEqual([true]);
    expect(mocks.select).toHaveBeenCalledWith({ bundle: schema.steeringVersions.bundle });
  });

  it("answers an empty map when the workspace has published nothing", async () => {
    const servers = await publishedServers(SCOPE);

    expect(servers.size).toBe(0);
  });

  it("skips a version whose tools did not compile", async () => {
    mocks.rows = [{ bundle: { records: [], tools: null } }];

    const servers = await publishedServers(SCOPE);

    expect(servers.size).toBe(0);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "tool-manifest/v1"],
    ["a number", 42],
    ["an array", [MANIFEST]],
  ])("skips a bundle that is %s", async (_label, value) => {
    mocks.rows = [{ bundle: value }];

    const servers = await publishedServers(SCOPE);

    expect(servers.size).toBe(0);
  });

  it.each<[string, unknown]>([
    ["no tools key", { records: [] }],
    ["another manifest schema", { tools: { schema: "tool-manifest/v2", servers: [] } }],
    ["a server that fails the schema", { tools: { schema: "tool-manifest/v1", servers: [{ name: "billing" }] } }],
    ["tools that are not an object", { tools: "billing" }],
  ])("skips a bundle with %s", async (_label, value) => {
    mocks.rows = [{ bundle: value }];

    const servers = await publishedServers(SCOPE);

    expect(servers.size).toBe(0);
  });

  it("merges the servers of two repositories into one map", async () => {
    mocks.rows = [bundle(server("billing")), bundle(server("stripe"))];

    const servers = await publishedServers(SCOPE);

    expect([...servers.keys()].sort()).toEqual(["billing", "stripe"]);
    expect(servers.get("billing")).toEqual(server("billing"));
    expect(servers.get("stripe")).toEqual(server("stripe"));
  });

  it("keeps the good versions when another version's tools are bad", async () => {
    mocks.rows = [
      { bundle: { records: [], tools: null } },
      bundle(server("stripe")),
      { bundle: "not a bundle" },
      { bundle: { tools: { schema: "tool-manifest/v1", servers: [{ name: "billing" }] } } },
    ];

    const servers = await publishedServers(SCOPE);

    expect([...servers.keys()]).toEqual(["stripe"]);
  });
});
