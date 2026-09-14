/**
 * session.test.ts — unit tests for getSession and getSessionOrRedirect.
 *
 * Both functions rely on server-only Next.js APIs (headers, redirect) and
 * Better Auth. We mock at the adapter seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted stubs
// ---------------------------------------------------------------------------
const { mockGetSession, mockRedirect, mockHeaders } = vi.hoisted(() => {
  const mockGetSession = vi.fn();
  const mockRedirect = vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  const mockHeaders = vi.fn(() => Promise.resolve(new Headers()));
  return { mockGetSession, mockRedirect, mockHeaders };
});

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the module under test.
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("./auth", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

import { getSession, getSessionOrRedirect } from "./session";

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------
describe("getSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the session when auth resolves one", async () => {
    const session = { user: { id: "user-1", email: "a@b.com" } };
    mockGetSession.mockResolvedValue(session);
    expect(await getSession()).toEqual(session);
  });

  it("returns null when no session exists", async () => {
    mockGetSession.mockResolvedValue(null);
    expect(await getSession()).toBeNull();
  });

  it("calls auth.api.getSession with the headers object", async () => {
    mockGetSession.mockResolvedValue(null);
    await getSession();
    expect(mockGetSession).toHaveBeenCalledOnce();
    expect(mockHeaders).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getSessionOrRedirect
// ---------------------------------------------------------------------------
describe("getSessionOrRedirect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the session when a user is present", async () => {
    const session = { user: { id: "user-1" } };
    mockGetSession.mockResolvedValue(session);
    const result = await getSessionOrRedirect();
    expect(result).toEqual(session);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects to /login when session is null", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(getSessionOrRedirect()).rejects.toThrow("REDIRECT:/login");
    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to /login when session.user is falsy", async () => {
    mockGetSession.mockResolvedValue({ user: null });
    await expect(getSessionOrRedirect()).rejects.toThrow("REDIRECT:/login");
  });

  it("accepts a custom redirect path", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(getSessionOrRedirect("/custom-login")).rejects.toThrow(
      "REDIRECT:/custom-login",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/custom-login");
  });
});
