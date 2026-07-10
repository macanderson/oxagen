/**
 * route.test.ts — regression tests for POST /api/v1/graph/explore.
 *
 * The route's `BodySchema` is a discriminated union keyed on `op`. It must stay
 * in lockstep with the ops the client (`api-client.ts`) and service
 * (`explore-service.ts` `dispatchExplore`) actually send. When the schema lagged
 * behind, the missing branches (`vocab`, `similaritySearch`, and the node/edge
 * CRUD ops) made every such request fail `safeParse` and return 400 — silently
 * breaking the create/edit dialogs (the create-node label typeahead came up
 * empty because its `vocab` fetch 400'd and the caller swallows the error).
 *
 * These tests assert each op the client sends is ACCEPTED by the schema and
 * reaches `dispatchExplore`, and that the surrounding auth/membership/error
 * handling still returns real, handled Responses. They fail on the pre-fix
 * schema (vocab/upsert ops -> 400) and pass on the fixed schema.
 *
 * Route handlers are excluded from this package's coverage gate (they are
 * e2e-tested against the real stack), but this unit test is the regression
 * guard for the schema↔ops contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSessionOrRedirect,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertWorkspaceMember,
  mockDispatchExplore,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockGetSessionOrRedirect: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertWorkspaceMember: vi.fn(),
  mockDispatchExplore: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertWorkspaceMember: mockAssertWorkspaceMember,
}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: mockLoggerError },
}));
vi.mock("@/components/knowledge/graph-explorer/explore-service", () => ({
  dispatchExplore: mockDispatchExplore,
}));

import { POST } from "./route";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WORKSPACE = { id: "ws-1", slug: "main" };
const TENANT = { orgSlug: "acme", workspaceSlug: "main" };

/** Build a POST Request carrying `body` as JSON. */
function req(body: unknown): Request {
  return new Request("https://app.oxagen.sh/api/v1/graph/explore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionOrRedirect.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WORKSPACE);
  mockAssertWorkspaceMember.mockResolvedValue(undefined);
  mockDispatchExplore.mockResolvedValue({ ok: true });
});

describe("POST /api/v1/graph/explore — schema accepts every op the client sends", () => {
  // Each entry is a body the client (`api-client.ts`) actually posts. The
  // create/edit dialogs depend on the first four; before the fix they 400'd.
  const ACCEPTED_OPS: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "vocab", body: { ...TENANT, op: "vocab" } },
    {
      name: "similaritySearch",
      body: { ...TENANT, op: "similaritySearch", query: "mac", limit: 10 },
    },
    {
      name: "upsertNode",
      body: {
        ...TENANT,
        op: "upsertNode",
        label: "Person",
        displayName: "Mac Anderson",
        description: "founder",
        properties: { email: "mac@oxagen.ai" },
      },
    },
    {
      name: "deleteNode",
      body: { ...TENANT, op: "deleteNode", nodeId: "node-1" },
    },
    {
      name: "upsertEdge",
      body: {
        ...TENANT,
        op: "upsertEdge",
        fromNodeId: "node-1",
        toNodeId: "node-2",
        relationshipType: "WORKS_WITH",
        properties: { since: "2024" },
      },
    },
    {
      name: "deleteEdge",
      body: {
        ...TENANT,
        op: "deleteEdge",
        fromNodeId: "node-1",
        toNodeId: "node-2",
        edgeType: "WORKS_WITH",
      },
    },
    // Pre-existing read ops must keep working too.
    { name: "graph", body: { ...TENANT, op: "graph", limit: 50 } },
    // The runtime-lineage opt-in must round-trip on both seeded ops.
    {
      name: "graph+includeSystem",
      body: { ...TENANT, op: "graph", limit: 50, includeSystem: true },
    },
    {
      name: "nodes",
      body: { ...TENANT, op: "nodes", labels: ["Person"], limit: 25 },
    },
    {
      name: "nodes+includeSystem",
      body: { ...TENANT, op: "nodes", limit: 25, includeSystem: true },
    },
    { name: "search", body: { ...TENANT, op: "search", query: "mac" } },
    { name: "node", body: { ...TENANT, op: "node", nodeId: "node-1" } },
    { name: "expand", body: { ...TENANT, op: "expand", nodeId: "node-1" } },
  ];

  it.each(ACCEPTED_OPS)(
    "accepts op=$name and dispatches it (not a 400)",
    async ({ body }: { name: string; body: Record<string, unknown> }) => {
      const res = await POST(req(body) as never);

      expect(res.status).toBe(200);
      expect(mockDispatchExplore).toHaveBeenCalledTimes(1);
      // The parsed body (op + payload) is forwarded verbatim to the service.
      expect(mockDispatchExplore.mock.calls[0]![0]).toMatchObject({
        op: body.op,
      });
      // ...scoped to the resolved tenant, never the raw slugs.
      expect(mockDispatchExplore.mock.calls[0]![1]).toMatchObject({
        orgId: ORG.id,
        workspaceId: WORKSPACE.id,
        userId: SESSION.user.id,
        surface: "app",
      });
    },
  );
});

describe("POST /api/v1/graph/explore — validation and auth", () => {
  it("returns 400 for an unknown op without touching the service", async () => {
    const res = await POST(req({ ...TENANT, op: "totallyBogus" }) as never);

    expect(res.status).toBe(400);
    expect(mockDispatchExplore).not.toHaveBeenCalled();
  });

  it("returns 400 when a known op is missing its required payload", async () => {
    // upsertNode requires `label` + `displayName`.
    const res = await POST(req({ ...TENANT, op: "upsertNode" }) as never);

    expect(res.status).toBe(400);
    expect(mockDispatchExplore).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid JSON body", async () => {
    const bad = new Request("https://app.oxagen.sh/api/v1/graph/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    const res = await POST(bad as never);

    expect(res.status).toBe(400);
    expect(mockDispatchExplore).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    mockGetSessionOrRedirect.mockRejectedValueOnce(new Error("no session"));

    const res = await POST(req({ ...TENANT, op: "vocab" }) as never);

    expect(res.status).toBe(401);
    expect(mockDispatchExplore).not.toHaveBeenCalled();
  });

  it("returns 404 (IDOR guard) when workspace membership is denied", async () => {
    mockAssertWorkspaceMember.mockRejectedValueOnce(new Error("not a member"));

    const res = await POST(req({ ...TENANT, op: "vocab" }) as never);

    expect(res.status).toBe(404);
    expect(mockDispatchExplore).not.toHaveBeenCalled();
  });

  it("returns a logged 500 when the service throws", async () => {
    mockDispatchExplore.mockRejectedValueOnce(new Error("neo4j down"));

    const res = await POST(req({ ...TENANT, op: "vocab" }) as never);

    expect(res.status).toBe(500);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});
