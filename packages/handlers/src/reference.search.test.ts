import { describe, it, expect, vi, afterEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Hoisted mock state ─────────────────────────────────────────────────────────
// vi.hoisted so the schema objects and mock fns exist when the vi.mock factories
// run. Postgres rows are keyed by table marker (`__table`) so a single
// withTenantDb mock can serve every arm (repositories, agents, skills, mcp
// servers, external tools) from one lookup table set per test.
const H = vi.hoisted(() => {
  const table = (name: string, cols: Record<string, string>) => ({
    __table: name,
    ...cols,
  });
  const schema = {
    sourceConnections: table("sourceConnections", {
      publicId: "publicId",
      status: "status",
      deliveryConfig: "deliveryConfig",
      orgId: "orgId",
      workspaceId: "workspaceId",
      connectorId: "connectorId",
      deletedAt: "deletedAt",
    }),
    agents: table("agents", {
      publicId: "publicId",
      slug: "slug",
      name: "name",
      description: "description",
      status: "status",
      orgId: "orgId",
      workspaceId: "workspaceId",
      deletedAt: "deletedAt",
    }),
    skills: table("skills", {
      publicId: "publicId",
      slug: "slug",
      name: "name",
      description: "description",
      source: "source",
      enabled: "enabled",
      usageCount: "usageCount",
      orgId: "orgId",
      workspaceId: "workspaceId",
      deletedAt: "deletedAt",
    }),
    mcpServers: table("mcpServers", {
      publicId: "publicId",
      name: "name",
      transportType: "transportType",
      endpointUrl: "endpointUrl",
      healthStatus: "healthStatus",
      enabled: "enabled",
      discoveredTools: "discoveredTools",
      orgId: "orgId",
      workspaceId: "workspaceId",
      deletedAt: "deletedAt",
    }),
  };
  return {
    schema,
    rowsByTable: new Map<string, unknown[]>(),
    mockInvoke: vi.fn(),
    mockCapabilitiesForSurface: vi.fn(),
    mockListCapabilities: vi.fn(),
    mockRun: vi.fn(),
    sessionClose: vi.fn(),
  };
});

function setRows(table: keyof typeof H.schema, rows: unknown[]) {
  H.rowsByTable.set(H.schema[table].__table, rows);
}

// withTenantDb — runs the handler's tx builder against a chainable stub whose
// terminal .limit() resolves the rows registered for the captured table.
const mockWithTenantDb = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  let captured: string | undefined;
  const tx = {
    select: () => tx,
    from: (t: { __table: string }) => {
      captured = t.__table;
      return tx;
    },
    where: () => tx,
    orderBy: () => tx,
    limit: () => Promise.resolve(captured ? (H.rowsByTable.get(captured) ?? []) : []),
  };
  return fn(tx);
});

// invoke + capabilitiesForSurface come from the kernel; the handler only needs
// those two, so a full replacement is safe (nothing else from the kernel is
// referenced during module load).
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: (...args: unknown[]) => H.mockInvoke(...args),
  capabilitiesForSurface: (...args: unknown[]) => H.mockCapabilitiesForSurface(...args),
}));

// Spread the real registry so the contract's registerCapability(...) still
// works when reference.search's contract is imported transitively; override only
// listCapabilities. (Full-replacement would drop registerCapability and crash
// the contract import — see project memory on vi.mock spread.)
vi.mock("@oxagen/oxagen/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/oxagen/registry")>();
  return { ...actual, listCapabilities: (...args: unknown[]) => H.mockListCapabilities(...args) };
});

vi.mock("@oxagen/database", () => ({
  schema: H.schema,
  withTenantDb: (fn: (tx: unknown) => Promise<unknown>) => mockWithTenantDb(fn),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  ilike: (a: unknown, b: unknown) => ({ ilike: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  or: (...args: unknown[]) => ({ or: args }),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: (...a: unknown[]) => H.mockRun(...a), close: H.sessionClose }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { referenceSearchHandler } from "./reference.search";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "app",
  messageId: null,
};

function resetDefaults() {
  H.rowsByTable.clear();
  H.mockInvoke.mockReset();
  H.mockInvoke.mockImplementation(async (name: string) => {
    if (name === "search_nodes") return { nodes: [] };
    if (name === "get_node") return { node: null };
    return {};
  });
  H.mockCapabilitiesForSurface.mockReset();
  H.mockCapabilitiesForSurface.mockReturnValue([]);
  H.mockListCapabilities.mockReset();
  H.mockListCapabilities.mockReturnValue([]);
  H.mockRun.mockReset();
  H.mockRun.mockResolvedValue({ records: [] });
}
resetDefaults();

afterEach(() => {
  vi.clearAllMocks();
  resetDefaults();
});

describe("referenceSearchHandler", () => {
  it("parses repository rows from both deliveryConfig shapes", async () => {
    setRows("sourceConnections", [
      {
        publicId: "con_a",
        status: "active",
        deliveryConfig: { owner: "acme", repo: "web", defaultBranch: "main" },
      },
      {
        publicId: "con_b",
        status: "active",
        deliveryConfig: { selectedRepos: ["acme/api", "acme/cli"], defaultBranch: "dev" },
      },
    ]);

    const { results } = await referenceSearchHandler(
      { query: "", types: ["repository"], limit: 10 },
      ctx,
    );

    const labels = results.map((r) => r.label).sort();
    expect(results).toHaveLength(3);
    expect(labels).toEqual(["acme/api", "acme/cli", "acme/web"]);
    // The single-repo shape resolves its slug to the connection publicId.
    const web = results.find((r) => r.label === "acme/web");
    expect(web?.type).toBe("repository");
    expect(web?.slug).toBe("con_a");
    expect(web?.properties.defaultBranch).toBe("main");
  });

  it("loads repositories and branches from a single sourceConnections query", async () => {
    setRows("sourceConnections", [
      {
        publicId: "con_a",
        status: "active",
        deliveryConfig: { owner: "acme", repo: "web", defaultBranch: "main" },
      },
    ]);

    const { results } = await referenceSearchHandler(
      { query: "", types: ["repository", "branch"], limit: 10 },
      ctx,
    );

    // The repository and branch arms share one memoized SELECT — the identical
    // sourceConnections query runs once, not once per type.
    expect(mockWithTenantDb).toHaveBeenCalledTimes(1);
    expect(results.some((r) => r.type === "repository")).toBe(true);
    expect(results.some((r) => r.type === "branch")).toBe(true);
  });

  it("restricts sources to the requested types", async () => {
    setRows("sourceConnections", [
      { publicId: "con_a", status: "active", deliveryConfig: { owner: "acme", repo: "web" } },
    ]);
    setRows("agents", [
      { publicId: "agt_1", slug: "cleanup", name: "Cleanup Agent", description: null, status: "active" },
    ]);

    const { results } = await referenceSearchHandler(
      { query: "a", types: ["agent"], limit: 10 },
      ctx,
    );

    expect(results.every((r) => r.type === "agent")).toBe(true);
    expect(results).toHaveLength(1);
    // Graph arms (file/directory/node) are gated off, so invoke is never called.
    expect(H.mockInvoke).not.toHaveBeenCalled();
  });

  it("resolves an exact match by slug (agent by publicId)", async () => {
    setRows("agents", [
      { publicId: "agt_x", slug: "billing", name: "Billing Agent", description: "Handles invoices", status: "active" },
    ]);

    const { results } = await referenceSearchHandler(
      { query: "", slug: "agt_x", types: ["agent"], limit: 10 },
      ctx,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.slug).toBe("agt_x");
    expect(results[0]?.label).toBe("Billing Agent");
    expect(results[0]?.type).toBe("agent");
  });

  it("degrades a failing graph source to empty while Postgres types still return", async () => {
    H.mockInvoke.mockImplementation(async (name: string) => {
      if (name === "search_nodes") throw new Error("Neo4j unavailable");
      return { node: null };
    });
    setRows("agents", [
      { publicId: "agt_1", slug: "cleanup", name: "Cleanup Agent", description: null, status: "active" },
    ]);

    const { results } = await referenceSearchHandler({ query: "cleanup", limit: 25 }, ctx);

    // Postgres agent row survives the graph failure.
    expect(results.some((r) => r.type === "agent" && r.slug === "agt_1")).toBe(true);
    // File / directory / node arms degraded to empty.
    expect(results.some((r) => r.type === "file" || r.type === "directory" || r.type === "node")).toBe(
      false,
    );
  });

  it("dedupes merged rows and slices to the limit", async () => {
    setRows("agents", [
      { publicId: "agt_1", slug: "a", name: "Agent One", description: null, status: "active" },
      // Exact duplicate — same type+slug+location collapses to one.
      { publicId: "agt_1", slug: "a", name: "Agent One", description: null, status: "active" },
      { publicId: "agt_2", slug: "b", name: "Agent Two", description: null, status: "active" },
    ]);
    setRows("skills", [
      { publicId: "skl_1", slug: "s1", name: "Skill One", description: null, source: "builtin", enabled: true, usageCount: 0 },
      { publicId: "skl_2", slug: "s2", name: "Skill Two", description: null, source: "builtin", enabled: true, usageCount: 0 },
    ]);

    const { results } = await referenceSearchHandler(
      { query: "", types: ["agent", "skill"], limit: 3 },
      ctx,
    );

    // 4 distinct rows after dedup (agt_1, agt_2, skl_1, skl_2), sliced to 3.
    expect(results).toHaveLength(3);
    const keys = results.map((r) => `${r.type} ${r.slug} ${r.location}`);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates survived
  });

  it("returns builtin capabilities and external MCP server tools for tool search", async () => {
    H.mockCapabilitiesForSurface.mockReturnValue([
      {
        name: "read_file",
        domain: "fs",
        description: "Read a file from the sandbox",
        agent: { category: "read", riskLevel: "low", requiresApproval: false },
      },
    ]);
    setRows("mcpServers", [
      { name: "github", publicId: "mcp_1", discoveredTools: ["create_issue"] },
    ]);

    const { results } = await referenceSearchHandler({ query: "", types: ["tool"], limit: 25 }, ctx);

    expect(H.mockCapabilitiesForSurface).toHaveBeenCalledWith("agent");
    const builtin = results.find((r) => r.slug === "read_file");
    expect(builtin?.type).toBe("tool");
    expect(builtin?.properties.external).toBe(false);

    const external = results.find((r) => r.slug === "github.create_issue");
    expect(external?.type).toBe("tool");
    expect(external?.properties.external).toBe(true);
    expect(external?.properties.server).toBe("github");
  });

  it("returns registry capabilities for capability search", async () => {
    H.mockListCapabilities.mockReturnValue([
      {
        name: "search_references",
        domain: "reference",
        description: "Tenant-scoped autocomplete search across referenceable objects",
        mode: "sync",
        agent: { riskLevel: "low", category: "read" },
      },
    ]);

    const { results } = await referenceSearchHandler(
      { query: "reference", types: ["capability"], limit: 25 },
      ctx,
    );

    expect(H.mockListCapabilities).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("capability");
    expect(results[0]?.slug).toBe("search_references");
    expect(results[0]?.label).toBe("search references");
  });
});
