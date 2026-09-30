// studio-discovery.handlers.test.ts: the MCP tools for discovery (lane M10,
// #4682): start_studio_discovery, get_studio_discovery, and list_studio_tools,
// and get_studio_server, which reads the folder beside the catalog (#4678).
//
// The kernel `invoke` and the context seam `buildContext` are doubles. Each
// case checks that invoke received the contract name, the args, and
// { surface: "mcp" }, and that the output passed the contract's output schema
// on the way back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import startStudioDiscovery, {
  metadata as startStudioDiscoveryMeta,
  schema as startStudioDiscoverySchema,
} from "./tool.studio.discovery.start";
import getStudioDiscovery, {
  metadata as getStudioDiscoveryMeta,
} from "./tool.studio.discovery.get";
import getStudioServer, {
  metadata as getStudioServerMeta,
} from "./tool.studio.server.get";
import listStudioTools, {
  metadata as listStudioToolsMeta,
} from "./tool.studio.tools.list";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const AT = "2026-09-28T15:00:12.000Z";

/** A queued manual discovery, as get_studio_discovery returns it. */
const QUEUED = {
  id: "0191d0a0-0000-7000-8000-00000000d15c",
  server: "ledger",
  mcpServerId: null,
  status: "queued" as const,
  trigger: "manual" as const,
  requestedAt: AT,
  requestedBy: "user_1",
  startedAt: null,
  finishedAt: null,
  error: null,
  outcome: null,
  toolCount: null,
  machine: null,
  sourceKind: null,
  sourceRepo: null,
  sourcePath: null,
  sourceRef: null,
  schedule: null,
  upstreamDigest: null,
  latestVersion: null,
  pr: null,
  withheld: [],
  stalled: false,
};

/** One imported tool and one available tool. */
const TOOLS = {
  server: "ledger",
  mcpServerId: "mcs_1",
  snapshotId: "snap_2",
  capturedAt: AT,
  exposure: { mode: "direct" as const, budget: 8000 },
  tokens: { definitions: 120, budget: 8000 },
  imported: 1,
  offered: 2,
  searchRecommended: false,
  compileError: null,
  tools: [
    {
      name: "list_entries",
      key: "list_entries",
      state: "imported" as const,
      description: "List ledger entries.",
      importedDescription: null,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      tokens: 120,
      classification: {
        risk: "low" as const,
        sideEffect: "read" as const,
        egress: "third_party" as const,
        impacts: [],
        confirmed: true,
        basis: null,
      },
      snapshotId: "snap_1",
      capturedAt: AT,
      withheld: false,
    },
    {
      name: "post_entry",
      key: null,
      state: "available" as const,
      description: "Post a ledger entry.",
      importedDescription: null,
      inputSchema: { type: "object" },
      annotations: null,
      tokens: 96,
      classification: {
        risk: "high" as const,
        sideEffect: "irreversible" as const,
        egress: "third_party" as const,
        impacts: [],
        confirmed: false,
        basis: "fail_safe" as const,
      },
      snapshotId: "snap_2",
      capturedAt: AT,
      withheld: true,
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("the three discovery tools carry their contract's name and hints", () => {
  it.each([
    [startStudioDiscoveryMeta, "start_studio_discovery", false, false, false],
    [getStudioDiscoveryMeta, "get_studio_discovery", true, false, true],
    [listStudioToolsMeta, "list_studio_tools", true, false, true],
  ])("%s", (meta, name, readOnly, destructive, idempotent) => {
    expect(meta.name).toBe(name);
    expect(meta.annotations?.readOnlyHint).toBe(readOnly);
    expect(meta.annotations?.destructiveHint).toBe(destructive);
    expect(meta.annotations?.idempotentHint).toBe(idempotent);
  });

  it("takes the server folder name alone", () => {
    expect(Object.keys(startStudioDiscoverySchema)).toEqual(["server"]);
  });
});

describe("start_studio_discovery", () => {
  it("invokes with the contract name and forwards the queued discovery", async () => {
    mocks.invoke.mockResolvedValue({ discovery: QUEUED });
    const result = await startStudioDiscovery({ server: "ledger" });
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "start_studio_discovery",
      { server: "ledger" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual({ discovery: QUEUED });
  });

  it("refuses a missing discovery, which start never returns", async () => {
    mocks.invoke.mockResolvedValue({ discovery: null });
    await expect(startStudioDiscovery({ server: "ledger" })).rejects.toThrow();
  });
});

describe("get_studio_discovery", () => {
  it("invokes with the contract name and forwards the discovery", async () => {
    mocks.invoke.mockResolvedValue({ discovery: QUEUED });
    const result = await getStudioDiscovery({ server: "ledger" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_studio_discovery",
      { server: "ledger" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual({ discovery: QUEUED });
  });

  it("passes a server never discovered through as null", async () => {
    mocks.invoke.mockResolvedValue({ discovery: null });
    await expect(getStudioDiscovery({ server: "ledger" })).resolves.toEqual({
      discovery: null,
    });
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ discovery: { ...QUEUED, status: "paused" } });
    await expect(getStudioDiscovery({ server: "ledger" })).rejects.toThrow();
  });
});

describe("list_studio_tools", () => {
  it("invokes with the contract name and forwards both groups of rows", async () => {
    mocks.invoke.mockResolvedValue(TOOLS);
    const result = await listStudioTools({ server: "ledger" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_studio_tools",
      { server: "ledger" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(TOOLS);
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ server: "ledger", tools: [] });
    await expect(listStudioTools({ server: "ledger" })).rejects.toThrow();
  });
});

/** The ledger folder: the catalog, and the rest of the folder beside it. */
const SERVER = {
  ...TOOLS,
  folder: "tools/servers/ledger",
  label: "Ledger",
  description: "Entries in the finance ledger.",
  source: {
    type: "remote" as const,
    url: "https://ledger.example/mcp",
    transport: "http",
    network: null,
  },
  auth: {
    mode: "service" as const,
    scheme: "bearer",
    credential: "oxagen:credential/ledger",
  },
  environments: [
    { name: "default", sandbox: false, url: null, network: null, credential: null },
  ],
  sync: { schedule: "daily" as const, lastAt: AT },
  shaping: [
    { tool: "list_entries", hide: [], fixed: [], select: [], selection: null },
  ],
};

describe("get_studio_server", () => {
  it("carries its contract's name and read-only hints", () => {
    expect(getStudioServerMeta.name).toBe("get_studio_server");
    expect(getStudioServerMeta.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("invokes with the contract name and forwards the folder", async () => {
    mocks.invoke.mockResolvedValue(SERVER);
    const result = await getStudioServer({ server: "ledger" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_studio_server",
      { server: "ledger" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(SERVER);
  });

  it("refuses an output with the catalog alone", async () => {
    mocks.invoke.mockResolvedValue(TOOLS);
    await expect(getStudioServer({ server: "ledger" })).rejects.toThrow();
  });
});
