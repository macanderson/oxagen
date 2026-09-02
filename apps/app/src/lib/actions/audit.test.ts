/**
 * audit.test.ts — unit tests for queryAuditLogAction.
 *
 * Mock seam: @oxagen/oxagen → invoke. Verifies the session/org/workspace
 * resolution chain, the default source/limit/offset values, and that the
 * capability's own input/output parse round-trips the mocked result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  resolveWorkspace: vi.fn(),
  assertOrgMember: vi.fn(),
}));
vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen/contracts/audit.log.query", () => ({
  auditLogQuery: {
    name: "query_audit_log",
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));

import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";
import { queryAuditLogAction } from "./audit";

const mockGetSession = vi.mocked(getSessionOrRedirect);
const mockResolveOrg = vi.mocked(resolveOrg);
const mockResolveWorkspace = vi.mocked(resolveWorkspace);
const mockAssertOrgMember = vi.mocked(assertOrgMember);
const mockInvoke = vi.mocked(invoke);

const SESSION = { user: { id: "user-1" } } as never;
const ORG = { id: "org-1", slug: "acme" } as never;
const WS = { id: "ws-1", slug: "main" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WS);
  mockAssertOrgMember.mockResolvedValue(undefined);
});

describe("queryAuditLogAction", () => {
  it("resolves org/workspace, asserts membership, and defaults source/limit/offset", async () => {
    const page = { rows: [], total: 0 };
    mockInvoke.mockResolvedValue(page);

    const result = await queryAuditLogAction({
      orgSlug: "acme",
      workspaceSlug: "main",
    });

    expect(mockResolveOrg).toHaveBeenCalledWith("acme");
    expect(mockResolveWorkspace).toHaveBeenCalledWith("org-1", "main");
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "query_audit_log",
      expect.objectContaining({
        source: "all",
        workspaceId: "ws-1",
        limit: 50,
        offset: 0,
      }),
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(result).toBe(page);
  });

  it("passes through explicit filters and pagination", async () => {
    mockInvoke.mockResolvedValue({ rows: [], total: 0 });

    await queryAuditLogAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      source: "security",
      capability: "create_workspace",
      outcome: "deny",
      limit: 25,
      offset: 25,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "query_audit_log",
      expect.objectContaining({
        source: "security",
        capability: "create_workspace",
        outcome: "deny",
        limit: 25,
        offset: 25,
      }),
      expect.anything(),
      { surface: "agent" },
    );
  });
});
