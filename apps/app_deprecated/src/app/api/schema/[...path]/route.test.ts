/**
 * route.test.ts — how POST /api/schema/<capability> reports a handler error.
 *
 * The schema chat handler bounds its model call with AbortSignal.timeout so a
 * slow gateway ends as its own error rather than as a proxy 504. That error
 * must reach the client as a 504, apart from the 400 a bad request gets.
 * Route handlers are excluded from this package's coverage gate; this is the
 * unit guard for the status mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSessionOrRedirect,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockAssertWorkspaceMember,
  mockGetOrgRole,
  mockInvoke,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockGetSessionOrRedirect: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockAssertWorkspaceMember: vi.fn(),
  mockGetOrgRole: vi.fn(),
  mockInvoke: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
  assertWorkspaceMember: mockAssertWorkspaceMember,
  getOrgRole: mockGetOrgRole,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: mockLoggerError },
}));

import { POST } from "./route";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WORKSPACE = { id: "ws-1", slug: "main" };

function chat(): Parameters<typeof POST> {
  const request = new Request("https://app.oxagen.sh/api/schema/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgSlug: "acme",
      workspaceSlug: "main",
      message: "generate schemas for a B2B SaaS company",
    }),
  });
  return [
    request as Parameters<typeof POST>[0],
    { params: Promise.resolve({ path: ["chat"] }) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionOrRedirect.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WORKSPACE);
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockAssertWorkspaceMember.mockResolvedValue(undefined);
  mockGetOrgRole.mockResolvedValue("member");
});

describe("POST /api/schema/chat — a timed-out model call is a 504", () => {
  it("maps the TimeoutError AbortSignal.timeout raises to 504", async () => {
    mockInvoke.mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    const res = await POST(...chat());
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: "The operation was aborted due to timeout",
    });
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("still answers 400 for an ordinary handler error", async () => {
    mockInvoke.mockRejectedValue(new Error("draftVersionId is not a uuid"));
    const res = await POST(...chat());
    expect(res.status).toBe(400);
  });
});
