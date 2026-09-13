/**
 * actions.test.ts — unit tests for the Policies auth-alerts write action.
 *
 * Covers saveAuthAlertsAction:
 *  - validation: empty roles / unknown role → error, no invoke
 *  - unauthenticated → error, no invoke
 *  - admin assert failure → explicit deny (nothing fails open), no invoke
 *  - happy path → invokes set_auth_alerts + revalidates the policies path
 *  - invoke failure → surfaced error
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertOrgAdmin,
  mockInvoke,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertOrgAdmin: vi.fn(),
  mockInvoke: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  assertOrgAdmin: mockAssertOrgAdmin,
}));
vi.mock("../_lib/invoke-org", () => ({
  invokeOrgCapability: mockInvoke,
  ORG_ONLY_WS: "00000000-0000-0000-0000-000000000000",
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { saveAuthAlertsAction } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockAssertOrgAdmin.mockResolvedValue(undefined);
  mockInvoke.mockResolvedValue({ ok: true });
});

describe("saveAuthAlertsAction", () => {
  it("rejects an empty roles list without invoking", async () => {
    const out = await saveAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: [],
    });
    expect(out.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects an unknown role without invoking", async () => {
    const out = await saveAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: ["Root"],
    });
    expect(out.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers", async () => {
    mockGetSession.mockResolvedValue(null);
    const out = await saveAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: ["Owner"],
    });
    expect(out).toEqual({ ok: false, error: "Not authenticated." });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("denies non-admins explicitly", async () => {
    mockAssertOrgAdmin.mockRejectedValue(new Error("nope"));
    const out = await saveAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: false,
      roles: ["Owner", "Compliance"],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/owners and admins/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes set_auth_alerts and revalidates on success", async () => {
    const out = await saveAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: false,
      roles: ["Owner", "Compliance"],
    });
    expect(out).toEqual({ ok: true });
    expect(mockInvoke).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "set_auth_alerts",
      {
        sendEmail: false,
        roles: ["Owner", "Compliance"],
      },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/governance/policies",
    );
  });

  it("surfaces invoke failures", async () => {
    mockInvoke.mockRejectedValue(new Error("kernel down"));
    const out = await saveAuthAlertsAction({
      orgSlug: "acme",
      sendEmail: true,
      roles: ["Owner"],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/failed/i);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
