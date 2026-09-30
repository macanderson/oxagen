// server.get.test.ts: get_studio_server (#4678, part 3). The role gate, the
// tenant scope, the steering checkout, and both stores are doubles. The
// folder's files go through the real readServerFiles and toolCatalog, so each
// case checks what the page reads beside the catalog: the source, auth,
// environments, sync, and each key's shaping. tools.list.test.ts covers the
// catalog's refusals, which this capability shares.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compile,
  formatJson,
  lock,
  mcpToolSchema,
  parseServerToml,
  parseToolsToml,
  upstreamFromMcpTool,
  type McpLockSource,
  type McpServer,
  type ReadResult,
} from "@oxagen/mcp-studio";
import { toolStudioServerGet } from "@oxagen/oxagen/contracts/tool.studio.server.get";
import {
  serverTomlPath,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo";
import { makeCTX } from "../../test-utils/fixtures";
import type { SteeringCheckout, SteeringFiles } from "./seams";
import type { DiscoveryRow, DiscoveryToolsStore, StoredTool } from "./store";

const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: not a workspace member"), {
        code: "forbidden",
      });
    }
    return "Viewer";
  }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../../event-client", () => ({ eventClient: { send: vi.fn() } }));

import { createGetStudioServerHandler, shapingOf, sourceOf } from "./server.get";

const ORG = "0191d0a0-0000-7000-8000-000000000001";
const WS = "0191d0a0-0000-7000-8000-000000000002";
const SCOPE = { orgId: ORG, workspaceId: WS };
const CTX = makeCTX({ orgId: ORG, workspaceId: WS, userId: "user_1" });
const AT = new Date("2026-09-28T15:00:12Z");
const FINISHED = new Date("2026-09-29T08:30:00Z");

/** A tool as an MCP server lists it in tools/list. */
interface RawTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const LIST_CHARGES: RawTool = {
  name: "list_charges",
  description: "List charges, newest first.",
  inputSchema: {
    type: "object",
    properties: { customer: { type: "string" }, limit: { type: "integer" } },
  },
  annotations: { readOnlyHint: true },
};

const CREATE_CUSTOMER: RawTool = {
  name: "create_customer",
  description: "Create a customer.",
  inputSchema: { type: "object", properties: { email: { type: "string" } } },
};

const STRIPE_SERVER = [
  "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
  'schema = "mcp-server/v1"',
  'name = "stripe"',
  'label = "Stripe"',
  'description = "Payments and refunds in the a-intel Stripe account."',
  "",
  "[source]",
  'type = "remote"',
  'url = "https://mcp.stripe.com"',
  'transport = "http"',
  "",
  "[auth]",
  'mode = "service"',
  'scheme = "oauth"',
  "",
  "[environments.test]",
  "sandbox = true",
  'credential = "oxagen:credential/stripe-test"',
  "",
  "[environments.live]",
  'credential = "oxagen:credential/stripe-live"',
  "",
  "[exposure]",
  'mode = "direct"',
  "definition_budget = 8000",
  "",
  "[sync]",
  'schedule = "daily"',
  "",
].join("\n");

const STRIPE_TOOLS = [
  "#:schema https://oxagen.sh/schemas/mcp-tools/v1.json",
  'schema = "mcp-tools/v1"',
  "",
  "[tools.list_charges]",
  'risk = "low"',
  'side_effect = "read"',
  'egress = "third_party"',
  "",
].join("\n");

/** list_charges with one hidden input and one fixed input. */
const SHAPED_TOOLS = [
  "#:schema https://oxagen.sh/schemas/mcp-tools/v1.json",
  'schema = "mcp-tools/v1"',
  "",
  "[tools.list_charges]",
  'risk = "low"',
  'side_effect = "read"',
  'egress = "third_party"',
  'hide = ["customer"]',
  "fixed = { limit = 10 }",
  "",
].join("\n");

const STRIPE_SOURCE: McpLockSource = {
  type: "remote",
  url: "https://mcp.stripe.com",
  server_version: "2026.09.1",
};

function must<T>(result: ReadResult<T>): T {
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.value;
}

/** The lock compile() and lock() write for a tools.toml over list_charges. */
function stripeLock(toolsText: string): string {
  const compiled = compile({
    server: must(parseServerToml(STRIPE_SERVER)),
    tools: must(parseToolsToml(toolsText)),
    upstream: [upstreamFromMcpTool(mcpToolSchema.parse(LIST_CHARGES))],
    security_schemes: {},
    descriptor_set: undefined,
  });
  return formatJson(lock({ compiled, source: STRIPE_SOURCE, previous: undefined }));
}

/** The stripe folder on the production branch. */
function stripeTree(toolsText: string = STRIPE_TOOLS): Record<string, string> {
  return {
    [serverTomlPath("stripe")]: STRIPE_SERVER,
    [toolsTomlPath("stripe")]: toolsText,
    [toolsLockPath("stripe")]: stripeLock(toolsText),
  };
}

/** The production branch as a map of paths. */
function fakeSteering(files: Record<string, string>) {
  const checkout: SteeringCheckout = {
    commit: "9f1c2e4b7a0d3f6e8c5b2a1d4e7f0c3b6a9d2e5f",
    read: (path) => Promise.resolve(files[path] ?? null),
    list: (dir) =>
      Promise.resolve(Object.keys(files).filter((path) => path.startsWith(`${dir}/`))),
    pullRequest: () =>
      Promise.resolve({ open: false, merged: false, headSha: null }),
  };
  const open = vi.fn<SteeringFiles["open"]>(() => Promise.resolve(checkout));
  return { open };
}

function stored(tool: RawTool, snapshotId: string): StoredTool {
  return {
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: { ...tool.inputSchema },
    annotations: tool.annotations === undefined ? null : { ...tool.annotations },
    snapshotId,
    capturedAt: AT,
  };
}

function toolsDouble(tools: StoredTool[]) {
  return {
    read: vi.fn(async () => ({ tools, withheldUpstream: [] })),
  } satisfies DiscoveryToolsStore;
}

/** The last discovery of the server, finished as `status`. */
function discoveryRow(status: DiscoveryRow["status"]): DiscoveryRow {
  return {
    id: "3f1c2b9a-0d4e-4c8b-9a7f-1e2d3c4b5a69",
    server: "stripe",
    mcpServerId: "mcs_1",
    status,
    trigger: "schedule",
    requestedAt: FINISHED,
    requestedBy: null,
    startedAt: FINISHED,
    finishedAt: FINISHED,
    error: status === "failed" ? "The server answered 502." : null,
    outcome: status === "failed" ? null : "unchanged",
    toolCount: 2,
    machine: null,
    upstreamDigest: null,
    latestVersion: null,
    pr: null,
    withheld: [],
  } as DiscoveryRow;
}

function storeDouble(row: DiscoveryRow | null = discoveryRow("succeeded")) {
  return {
    steeringServerId: vi.fn(async () => "mcs_1"),
    read: vi.fn(async () => row),
  };
}

beforeEach(() => {
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
});

describe("get_studio_server", () => {
  it("reads the folder beside the catalog, from one checkout, for a Viewer", async () => {
    const steering = fakeSteering(stripeTree());
    const tools = toolsDouble([
      stored(LIST_CHARGES, "snap_1"),
      stored(CREATE_CUSTOMER, "snap_2"),
    ]);
    const store = storeDouble();
    const handler = createGetStudioServerHandler({ steering, tools, store });

    const out = await handler({ server: "stripe" }, CTX);

    expect(steering.open).toHaveBeenCalledTimes(1);
    expect(steering.open).toHaveBeenCalledWith(SCOPE);
    expect(store.read).toHaveBeenCalledWith(SCOPE, "stripe");
    expect(out).toMatchObject({
      server: "stripe",
      mcpServerId: "mcs_1",
      folder: "tools/servers/stripe",
      label: "Stripe",
      description: "Payments and refunds in the a-intel Stripe account.",
      imported: 1,
      offered: 2,
      compileError: null,
      source: {
        type: "remote",
        url: "https://mcp.stripe.com",
        transport: "http",
        network: null,
      },
      auth: { mode: "service", scheme: "oauth", credential: null },
      sync: { schedule: "daily", lastAt: FINISHED.toISOString() },
    });
    expect(out.environments).toEqual([
      {
        name: "test",
        sandbox: true,
        url: null,
        network: null,
        credential: "oxagen:credential/stripe-test",
      },
      {
        name: "live",
        sandbox: false,
        url: null,
        network: null,
        credential: "oxagen:credential/stripe-live",
      },
    ]);
    expect(out.shaping).toEqual([
      { tool: "list_charges", hide: [], fixed: [], select: [], selection: null },
    ]);
    expect(out.tools.map((tool) => [tool.name, tool.state])).toEqual([
      ["list_charges", "imported"],
      ["create_customer", "available"],
    ]);
    expect(() => toolStudioServerGet.output.parse(out)).not.toThrow();
  });

  it("reads each key's hidden and fixed inputs, with each fixed value as JSON", async () => {
    const handler = createGetStudioServerHandler({
      steering: fakeSteering(stripeTree(SHAPED_TOOLS)),
      tools: toolsDouble([stored(LIST_CHARGES, "snap_1")]),
      store: storeDouble(),
    });

    const out = await handler({ server: "stripe" }, CTX);

    expect(out.shaping).toEqual([
      {
        tool: "list_charges",
        hide: ["customer"],
        fixed: [{ name: "limit", value: "10" }],
        select: [],
        selection: null,
      },
    ]);
  });

  it.each([
    { what: "the last discovery failed", row: discoveryRow("failed") },
    { what: "no discovery ran", row: null },
  ])("reads no last sync when $what", async ({ row }) => {
    const handler = createGetStudioServerHandler({
      steering: fakeSteering(stripeTree()),
      tools: toolsDouble([]),
      store: storeDouble(row),
    });

    const out = await handler({ server: "stripe" }, CTX);

    expect(out.sync).toEqual({ schedule: "daily", lastAt: null });
  });

  it("answers not found when the folder has no server.toml", async () => {
    const tree = stripeTree();
    delete tree[serverTomlPath("stripe")];
    const handler = createGetStudioServerHandler({
      steering: fakeSteering(tree),
      tools: toolsDouble([]),
      store: storeDouble(null),
    });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "mcp_server_not_found",
    });
  });

  it("refuses a caller outside the workspace before it reads the folder", async () => {
    roleGate.refuse = true;
    const steering = fakeSteering(stripeTree());
    const handler = createGetStudioServerHandler({
      steering,
      tools: toolsDouble([]),
      store: storeDouble(),
    });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(steering.open).not.toHaveBeenCalled();
  });
});

describe("sourceOf", () => {
  it("names a registry source's package and leaves its arguments out", () => {
    const source: McpServer["source"] = {
      type: "registry",
      registry: "https://registry.modelcontextprotocol.io",
      server: "io.github.acme/files",
      version: "1.2.0",
      machines: ["dev-laptops"],
      registry_type: "npm",
      env: ["ACME_TOKEN"],
      arguments: { "--port": "8080" },
    };
    const out = sourceOf(source);
    expect(out).toEqual({
      type: "registry",
      registry: "https://registry.modelcontextprotocol.io",
      server: "io.github.acme/files",
      version: "1.2.0",
      network: null,
      machines: ["dev-laptops"],
      registryType: "npm",
      env: ["ACME_TOKEN"],
    });
    expect(JSON.stringify(out)).not.toContain("8080");
  });

  it("names a local command, its arguments and the variables it passes", () => {
    expect(
      sourceOf({
        type: "local",
        command: "npx",
        args: ["-y", "@acme/files"],
        env: ["ACME_TOKEN"],
        machines: ["dev-laptops"],
      }),
    ).toEqual({
      type: "local",
      command: "npx",
      args: ["-y", "@acme/files"],
      env: ["ACME_TOKEN"],
      machines: ["dev-laptops"],
    });
  });

  it("names a definition's repository", () => {
    expect(
      sourceOf({
        type: "openapi",
        from: "repository",
        repo: "github.com/acme/pets-api",
        path: "spec/openapi.json",
        ref: "main",
      }),
    ).toEqual({
      type: "openapi",
      from: "repository",
      repo: "github.com/acme/pets-api",
      path: "spec/openapi.json",
      ref: "main",
      url: null,
      network: null,
    });
  });
});

describe("shapingOf", () => {
  it("lists no shaping for a tools.toml with no keys", () => {
    expect(shapingOf(must(parseToolsToml('schema = "mcp-tools/v1"\n')))).toEqual(
      [],
    );
  });
});
