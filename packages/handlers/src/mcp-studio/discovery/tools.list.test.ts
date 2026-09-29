// tools.list.test.ts: list_studio_tools (lane M10, #4682). The role gate, the
// tenant scope, the steering checkout, and both stores are doubles. The
// folder's files go through the real readServerFiles and toolCatalog, so each
// case checks what the handler reads and how it answers a missing or broken
// folder. catalog.test.ts covers the rows themselves.
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
  type ReadResult,
} from "@oxagen/mcp-studio";
import {
  serverTomlPath,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo";
import { makeCTX } from "../../test-utils/fixtures";
import type { SteeringCheckout, SteeringFiles } from "./seams";
import type { DiscoveryToolsStore, StoredTool } from "./store";
import { DiscoveryRefused } from "./types";

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

import { createListStudioToolsHandler } from "./tools.list";

const ORG = "0191d0a0-0000-7000-8000-000000000001";
const WS = "0191d0a0-0000-7000-8000-000000000002";
const SCOPE = { orgId: ORG, workspaceId: WS };
const CTX = makeCTX({ orgId: ORG, workspaceId: WS, userId: "user_1" });
const AT = new Date("2026-09-28T15:00:12Z");

const READ_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member", "Viewer"],
};

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
  'schema = "mcp-tools/v1"',
  "",
  "[tools.list_charges]",
  'risk = "low"',
  'side_effect = "read"',
  'egress = "third_party"',
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

/** The lock compile() and lock() write for STRIPE_TOOLS over list_charges. */
function stripeLock(): string {
  const compiled = compile({
    server: must(parseServerToml(STRIPE_SERVER)),
    tools: must(parseToolsToml(STRIPE_TOOLS)),
    upstream: [upstreamFromMcpTool(mcpToolSchema.parse(LIST_CHARGES))],
    security_schemes: {},
    descriptor_set: undefined,
  });
  return formatJson(lock({ compiled, source: STRIPE_SOURCE, previous: undefined }));
}

/** The stripe folder on the production branch. */
function stripeTree(): Record<string, string> {
  return {
    [serverTomlPath("stripe")]: STRIPE_SERVER,
    [toolsTomlPath("stripe")]: STRIPE_TOOLS,
    [toolsLockPath("stripe")]: stripeLock(),
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

function toolsDouble(tools: StoredTool[], withheldUpstream: string[] = []) {
  return {
    read: vi.fn(async () => ({ tools, withheldUpstream })),
  } satisfies DiscoveryToolsStore;
}

function storeDouble(mcpServerId: string | null = "mcs_1") {
  return { steeringServerId: vi.fn(async () => mcpServerId) };
}

beforeEach(() => {
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
});

describe("list_studio_tools", () => {
  it("lists the imported keys, then the tools discovery found, for a Viewer", async () => {
    const steering = fakeSteering(stripeTree());
    const tools = toolsDouble([
      stored(LIST_CHARGES, "snap_1"),
      stored(CREATE_CUSTOMER, "snap_2"),
    ]);
    const store = storeDouble();
    const handler = createListStudioToolsHandler({ steering, tools, store });

    const out = await handler({ server: "stripe" }, CTX);

    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS, userId: "user_1" },
      READ_ROLES,
    );
    expect(steering.open).toHaveBeenCalledWith(SCOPE);
    expect(tools.read).toHaveBeenCalledWith(SCOPE, "stripe");
    expect(store.steeringServerId).toHaveBeenCalledWith(SCOPE, "stripe");
    expect(out).toMatchObject({
      server: "stripe",
      mcpServerId: "mcs_1",
      imported: 1,
      offered: 2,
      compileError: null,
    });
    expect(out.tools.map((tool) => [tool.name, tool.state, tool.key])).toEqual([
      ["list_charges", "imported", "list_charges"],
      ["create_customer", "available", null],
    ]);
  });

  it("refuses a caller outside the workspace before it reads the folder", async () => {
    roleGate.refuse = true;
    const steering = fakeSteering(stripeTree());
    const tools = toolsDouble([]);
    const handler = createListStudioToolsHandler({
      steering,
      tools,
      store: storeDouble(),
    });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(steering.open).not.toHaveBeenCalled();
    expect(tools.read).not.toHaveBeenCalled();
  });

  it("answers not found when the folder has no server.toml", async () => {
    const tree = stripeTree();
    delete tree[serverTomlPath("stripe")];
    const handler = createListStudioToolsHandler({
      steering: fakeSteering(tree),
      tools: toolsDouble([]),
      store: storeDouble(null),
    });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "mcp_server_not_found",
    });
  });

  it("answers conflict with the file's path when tools.toml is missing", async () => {
    const tree = stripeTree();
    delete tree[toolsTomlPath("stripe")];
    const handler = createListStudioToolsHandler({
      steering: fakeSteering(tree),
      tools: toolsDouble([]),
      store: storeDouble(),
    });

    const refusal = handler({ server: "stripe" }, CTX);
    await expect(refusal).rejects.toMatchObject({
      code: "conflict",
      reason: "server_file_invalid",
    });
    await expect(refusal).rejects.toThrow(toolsTomlPath("stripe"));
  });

  it("answers not found for a name that cannot be a server folder", async () => {
    const steering = fakeSteering(stripeTree());
    const tools = toolsDouble([]);
    const handler = createListStudioToolsHandler({
      steering,
      tools,
      store: storeDouble(),
    });

    await expect(handler({ server: "../Stripe" }, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "mcp_server_not_found",
    });
    expect(steering.open).not.toHaveBeenCalled();
    expect(tools.read).not.toHaveBeenCalled();
  });

  it("passes any other refusal through unchanged", async () => {
    const refused = new DiscoveryRefused(
      "source",
      "The workspace's steering repository could not be read.",
    );
    const steering = { open: vi.fn<SteeringFiles["open"]>(() => Promise.reject(refused)) };
    const handler = createListStudioToolsHandler({
      steering,
      tools: toolsDouble([]),
      store: storeDouble(),
    });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toBe(refused);
  });

  it("lets an unexpected error propagate", async () => {
    const failure = new Error("socket hang up");
    const steering = { open: vi.fn<SteeringFiles["open"]>(() => Promise.reject(failure)) };
    const handler = createListStudioToolsHandler({
      steering,
      tools: toolsDouble([]),
      store: storeDouble(),
    });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toBe(failure);
  });
});
