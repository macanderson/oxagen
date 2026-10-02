// The steering connect's landing (#5151): where each viewer goes after GitHub
// returns. A member goes on to `return_to` with the outcome, anyone else gets
// the result page, and no branch ends on the organization's 404.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteViewer } from "@/server/viewer";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { handleSteeringLanding } = await import("./steering-landing");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const APP = "https://app.oxagen.sh";
const resolveViewer = vi.fn<(org: string) => Promise<RouteViewer>>();

/** The landing's URL, with the query the API's callback writes. */
function landing(query: Record<string, string>): Request {
  return new Request(
    `${APP}/github/steering?${new URLSearchParams(query).toString()}`,
  );
}

/** Where the landing sent the browser, as a path on the app. */
async function land(query: Record<string, string>): Promise<string> {
  const res = await handleSteeringLanding(landing(query), { resolveViewer });
  expect(res.status).toBe(307);
  const target = new URL(res.headers.get("location") ?? "");
  expect(target.origin).toBe(APP);
  return `${target.pathname}${target.search}`;
}

beforeEach(() => {
  resolveViewer.mockReset();
});

describe("a return that names an organization", () => {
  it("sends a member on to return_to with the outcome", async () => {
    resolveViewer.mockResolvedValue({ kind: "ok", ctx });
    expect(
      await land({ return_to: "/acme/core/steering", steering: "connected" }),
    ).toBe("/acme/core/steering?steering=connected");
    expect(resolveViewer).toHaveBeenCalledWith("acme");
  });

  it("reads the organization from an onboarding return", async () => {
    resolveViewer.mockResolvedValue({ kind: "ok", ctx });
    expect(
      await land({
        return_to: "/welcome/acme/new-workspace",
        steering: "error",
        code: "github_install_requested",
      }),
    ).toBe(
      "/welcome/acme/new-workspace?steering=error&code=github_install_requested",
    );
    expect(resolveViewer).toHaveBeenCalledWith("acme");
  });

  it("sends anyone who can't open the organization to the result page (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "not_found" });
    expect(
      await land({ return_to: "/steering-live", steering: "connected" }),
    ).toBe("/github/steering/result?steering=connected");
  });

  it("carries a failure's reason to the result page", async () => {
    resolveViewer.mockResolvedValue({ kind: "not_found" });
    expect(
      await land({
        return_to: "/welcome/acme/new-workspace",
        steering: "error",
        code: "store_failed",
      }),
    ).toBe("/github/steering/result?steering=error&code=store_failed");
  });

  it("drops a reason that is not a short snake_case word (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "not_found" });
    expect(
      await land({ return_to: "/acme", steering: "error", code: "<b>x</b>" }),
    ).toBe("/github/steering/result?steering=error");
  });

  it("sends a stranger home when the query names no outcome", async () => {
    resolveViewer.mockResolvedValue({ kind: "not_found" });
    expect(await land({ return_to: "/acme" })).toBe("/");
  });

  it("sends a browser with no session to log in, then back to the landing", async () => {
    resolveViewer.mockResolvedValue({ kind: "unauthenticated" });
    const query = { return_to: "/acme", steering: "connected" };
    const target = new URL(await land(query), APP);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(
      `/github/steering?${new URLSearchParams(query).toString()}`,
    );
  });

  it.each([
    { kind: "redirect", org: "acme-robotics", ws: null },
    { kind: "mfa_enroll" },
    { kind: "sso_required" },
  ] satisfies RouteViewer[])(
    "leaves $kind to the organization's own gate",
    async (viewer) => {
      resolveViewer.mockResolvedValue(viewer);
      expect(await land({ return_to: "/acme", steering: "connected" })).toBe(
        "/acme?steering=connected",
      );
    },
  );
});

describe("a return that names no organization", () => {
  it.each([
    ["the root", "/", "/?steering=connected"],
    ["an app page", "/new-organization", "/new-organization?steering=connected"],
    [
      "a reserved first segment",
      "/onboarding/steering",
      "/onboarding/steering?steering=connected",
    ],
    ["an onboarding path with no organization", "/welcome", "/welcome?steering=connected"],
  ])("goes straight to %s without a membership check", async (_, returnTo, expected) => {
    expect(await land({ return_to: returnTo, steering: "connected" })).toBe(
      expected,
    );
    expect(resolveViewer).not.toHaveBeenCalled();
  });

  it.each([
    ["another host", "//evil.example/acme"],
    ["a backslash", "/\\evil.example"],
    ["the sign-in flow", "/login"],
  ])("reads %s in return_to as the root (negative)", async (_, returnTo) => {
    expect(await land({ return_to: returnTo, steering: "connected" })).toBe(
      "/?steering=connected",
    );
    expect(resolveViewer).not.toHaveBeenCalled();
  });

  it("reads a missing return_to as the root", async () => {
    expect(await land({ steering: "connected" })).toBe("/?steering=connected");
  });
});
