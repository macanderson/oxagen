import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerResolution } from "./viewer-resolution";

const nav = vi.hoisted(() => {
  const interrupt = (kind: string) =>
    vi.fn((url?: string) => {
      throw Object.assign(new Error(kind), { url });
    });
  return {
    redirect: interrupt("NEXT_REDIRECT"),
    permanentRedirect: interrupt("NEXT_PERMANENT_REDIRECT"),
    notFound: interrupt("NEXT_NOT_FOUND"),
  };
});
const { requestHeaders, getSessionMock, resolveMock } = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  getSessionMock: vi.fn(),
  resolveMock: vi.fn(),
}));

vi.mock("next/navigation", () => nav);
// requireViewer defers its clock read behind connection(), which needs a request scope.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: () => Promise.resolve(),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(requestHeaders),
}));
vi.mock("./session", () => ({ getSession: getSessionMock }));
vi.mock("./tenancy-lookups", () => ({
  liveTenancyLookups: { name: "live" },
}));
vi.mock("./viewer-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./viewer-resolution")>()),
  resolveViewerWith: resolveMock,
}));

import { MFA_ENROLL_PATH } from "./mfa-gate";
import { liveTenancyLookups } from "./tenancy-lookups";
import { requestUrl, requireViewer } from "./scope";

const viewer = { userId: "u1" };
const resolves = (r: ViewerResolution | { kind: "ok"; viewer: unknown }) =>
  resolveMock.mockResolvedValue(r);

beforeEach(() => {
  for (const key of [...requestHeaders.keys()]) requestHeaders.delete(key);
  resolveMock.mockReset();
  getSessionMock.mockResolvedValue(null);
});

describe("requireViewer", () => {
  it("hands the session and the database lookups to the resolver, and returns the viewer", async () => {
    const session = { user: { id: "u1" } };
    getSessionMock.mockResolvedValue(session);
    resolves({ kind: "ok", viewer });
    await expect(requireViewer("acme", "core-platform")).resolves.toBe(viewer);
    expect(resolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ session, lookups: liveTenancyLookups }),
      "acme",
      "core-platform",
    );
  });

  it("redirects a signed-out request to login", async () => {
    resolves({ kind: "unauthenticated" });
    await expect(requireViewer("acme")).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith("/login");
  });

  it("404s an unknown organization or a non-member", async () => {
    resolves({ kind: "not_found" });
    await expect(requireViewer("acme", "finops")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(nav.notFound).toHaveBeenCalled();
  });

  it("sends an overdue privileged member to MFA enrollment", async () => {
    resolves({ kind: "mfa_enroll" });
    await expect(requireViewer("acme")).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith(MFA_ENROLL_PATH);
  });

  it("308s a historical slug to the canonical URL, keeping the path and query from x-url", async () => {
    requestHeaders.set(
      "x-url",
      "https://app.oxagen.sh/acme-robotics/platform/tools/connections?q=1",
    );
    resolves({ kind: "redirect", org: "acme", ws: "core-platform" });
    await expect(requireViewer("acme-robotics", "platform")).rejects.toThrow(
      "NEXT_PERMANENT_REDIRECT",
    );
    expect(nav.permanentRedirect).toHaveBeenCalledWith(
      "/acme/core-platform/tools/connections?q=1",
    );
  });

  it("308s to the canonical root when the request path is not exposed", async () => {
    resolves({ kind: "redirect", org: "acme", ws: null });
    await expect(requireViewer("acme-robotics")).rejects.toThrow(
      "NEXT_PERMANENT_REDIRECT",
    );
    expect(nav.permanentRedirect).toHaveBeenCalledWith("/acme");
  });
});

describe("requestUrl", () => {
  it("prefers x-url, then next-url, and is null without either", async () => {
    await expect(requestUrl()).resolves.toBeNull();
    requestHeaders.set("next-url", "/acme/core-platform?x=1");
    await expect(requestUrl()).resolves.toEqual({
      pathname: "/acme/core-platform",
      search: "?x=1",
    });
    requestHeaders.set("x-url", "/acme/audit");
    await expect(requestUrl()).resolves.toEqual({
      pathname: "/acme/audit",
      search: "",
    });
  });

  it("is null for a header that is not a URL", async () => {
    requestHeaders.set("x-url", "http://[::1");
    await expect(requestUrl()).resolves.toBeNull();
  });
});
