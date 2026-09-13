import { describe, expect, it, vi } from "vitest";
import type { MfaPolicy } from "./mfa-gate";
import type { AppSession } from "./session";
import type {
  OrgRecord,
  TenancyLookups,
  WorkspaceRecord,
} from "./tenancy-lookups";
import { ORG_ONLY_WS } from "./tenant-scope";
import {
  canonicalPath,
  isValidSlug,
  resolveViewerWith,
} from "./viewer-resolution";

const org: OrgRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  publicId: "org_a",
  slug: "acme",
  name: "Acme Robotics",
};
const ws: WorkspaceRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  publicId: "wks_a",
  orgId: org.id,
  slug: "core-platform",
  name: "Core platform",
};
const session: AppSession = {
  source: "better-auth",
  user: { id: "u1", email: "m@acme.example", name: "Marcus", image: null },
};
const now = new Date("2026-09-12T12:00:00Z");

type Overrides = Partial<{
  [K in keyof TenancyLookups]: TenancyLookups[K];
}>;

/** A member of acme and core-platform, no MFA policy, unless overridden. */
function lookups(overrides: Overrides = {}): TenancyLookups {
  return {
    orgBySlug: vi.fn((slug: string) =>
      Promise.resolve(slug === org.slug ? org : null),
    ),
    orgBySlugHistory: vi.fn(() => Promise.resolve(null)),
    workspaceBySlug: vi.fn((_orgId: string, slug: string) =>
      Promise.resolve(slug === ws.slug ? ws : null),
    ),
    workspaceBySlugHistory: vi.fn(() => Promise.resolve(null)),
    orgRole: vi.fn(() => Promise.resolve("member")),
    isWorkspaceMember: vi.fn(() => Promise.resolve(true)),
    mfaPolicy: vi.fn(() => Promise.resolve(null)),
    twoFactorEnabled: vi.fn(() => Promise.resolve(false)),
    ...overrides,
  };
}

const resolve = (l: TenancyLookups, o: string, w?: string, s = session) =>
  resolveViewerWith({ session: s, lookups: l, now }, o, w);

describe("resolveViewerWith: allowed", () => {
  it("returns the workspace viewer with its tenant scope", async () => {
    await expect(resolve(lookups(), "acme", "core-platform")).resolves.toEqual({
      kind: "ok",
      viewer: {
        userId: "u1",
        user: session.user,
        orgRole: "member",
        scope: { orgId: org.id, workspaceId: ws.id },
        org: { id: org.id, slug: "acme", name: "Acme Robotics" },
        ws: { id: ws.id, slug: "core-platform", name: "Core platform" },
      },
    });
  });

  it("returns an organization viewer under the org-only sentinel, without a workspace lookup", async () => {
    const l = lookups();
    const result = await resolve(l, "acme");
    expect(result).toMatchObject({
      kind: "ok",
      viewer: { ws: null, scope: { orgId: org.id, workspaceId: ORG_ONLY_WS } },
    });
    expect(l.workspaceBySlug).not.toHaveBeenCalled();
    expect(l.isWorkspaceMember).not.toHaveBeenCalled();
  });
});

describe("resolveViewerWith: refused", () => {
  it("is unauthenticated without a session, before any lookup", async () => {
    const l = lookups();
    await expect(
      resolveViewerWith({ session: null, lookups: l, now }, "acme"),
    ).resolves.toEqual({ kind: "unauthenticated" });
    expect(l.orgBySlug).not.toHaveBeenCalled();
  });

  it.each([
    ["favicon.ico", undefined],
    ["Acme", undefined],
    ["acme", "robots.txt"],
    ["acme", ""],
    ["-acme", undefined],
  ])(
    "404s a malformed slug (%s / %s) without a database round trip",
    async (o, w) => {
      const l = lookups();
      await expect(resolve(l, o, w)).resolves.toEqual({ kind: "not_found" });
      expect(l.orgBySlug).not.toHaveBeenCalled();
    },
  );

  it("404s an unknown organization", async () => {
    await expect(resolve(lookups(), "globex")).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("404s a non-member exactly like an unknown organization", async () => {
    const result = await resolve(
      lookups({ orgRole: () => Promise.resolve(null) }),
      "acme",
      "core-platform",
    );
    expect(result).toEqual({ kind: "not_found" });
  });

  it("does not disclose a rename to a non-member: 404, not a redirect", async () => {
    const l = lookups({
      orgBySlug: () => Promise.resolve(null),
      orgBySlugHistory: () => Promise.resolve(org),
      orgRole: () => Promise.resolve(null),
    });
    await expect(resolve(l, "acme-robotics")).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("404s an unknown workspace", async () => {
    await expect(resolve(lookups(), "acme", "finops")).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("404s an organization member who is not a member of the workspace", async () => {
    const l = lookups({ isWorkspaceMember: () => Promise.resolve(false) });
    await expect(resolve(l, "acme", "core-platform")).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("404s a workspace a lookup returned from another organization", async () => {
    const l = lookups({
      workspaceBySlug: () =>
        Promise.resolve({
          ...ws,
          orgId: "33333333-3333-4333-8333-333333333333",
        }),
    });
    await expect(resolve(l, "acme", "core-platform")).resolves.toEqual({
      kind: "not_found",
    });
  });
});

describe("resolveViewerWith: slug history", () => {
  it("redirects a renamed organization to its current slug", async () => {
    const l = lookups({
      orgBySlug: () => Promise.resolve(null),
      orgBySlugHistory: () => Promise.resolve(org),
    });
    await expect(resolve(l, "acme-robotics")).resolves.toEqual({
      kind: "redirect",
      org: "acme",
      ws: null,
    });
  });

  it("redirects a renamed workspace, keeping the organization", async () => {
    const l = lookups({
      workspaceBySlug: () => Promise.resolve(null),
      workspaceBySlugHistory: () => Promise.resolve(ws),
    });
    await expect(resolve(l, "acme", "platform")).resolves.toEqual({
      kind: "redirect",
      org: "acme",
      ws: "core-platform",
    });
  });

  it("still checks workspace membership before redirecting a renamed workspace", async () => {
    const l = lookups({
      workspaceBySlug: () => Promise.resolve(null),
      workspaceBySlugHistory: () => Promise.resolve(ws),
      isWorkspaceMember: () => Promise.resolve(false),
    });
    await expect(resolve(l, "acme", "platform")).resolves.toEqual({
      kind: "not_found",
    });
  });
});

describe("resolveViewerWith: MFA gate", () => {
  const policy: MfaPolicy = {
    mfaRequired: true,
    mfaGraceHours: 1,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  };

  it("sends an unenrolled owner to enrollment", async () => {
    const l = lookups({
      orgRole: () => Promise.resolve("owner"),
      mfaPolicy: () => Promise.resolve(policy),
    });
    await expect(resolve(l, "acme", "core-platform")).resolves.toEqual({
      kind: "mfa_enroll",
    });
  });

  it("lets an enrolled owner through", async () => {
    const l = lookups({
      orgRole: () => Promise.resolve("owner"),
      mfaPolicy: () => Promise.resolve(policy),
      twoFactorEnabled: () => Promise.resolve(true),
    });
    expect((await resolve(l, "acme")).kind).toBe("ok");
  });

  it("skips the enrollment read for a role the gate does not cover", async () => {
    const l = lookups({ mfaPolicy: () => Promise.resolve(policy) });
    expect((await resolve(l, "acme")).kind).toBe("ok");
    expect(l.twoFactorEnabled).not.toHaveBeenCalled();
  });
});

describe("isValidSlug", () => {
  it("accepts kebab-case and rejects everything else", () => {
    expect(isValidSlug("core-platform")).toBe(true);
    expect(isValidSlug("a1")).toBe(true);
    for (const bad of ["", "a--b", "a-", "A", "a.b", "a/b", "a".repeat(129)])
      expect(isValidSlug(bad)).toBe(false);
  });
});

describe("canonicalPath", () => {
  it("rewrites the organization segment and keeps the rest of the path and query", () => {
    expect(
      canonicalPath({
        pathname: "/acme-robotics/core-platform/runs/arun_1",
        search: "?tab=chain",
        base: "/",
        from: { org: "acme-robotics", ws: null },
        to: { org: "acme", ws: null },
      }),
    ).toBe("/acme/core-platform/runs/arun_1?tab=chain");
  });

  it("rewrites only the workspace segment at its position, not a later equal segment", () => {
    expect(
      canonicalPath({
        pathname: "/acme/platform/tools/platform",
        search: "",
        base: "/",
        from: { org: "acme", ws: "platform" },
        to: { org: "acme", ws: "core-platform" },
      }),
    ).toBe("/acme/core-platform/tools/platform");
  });

  it("rewrites the stream route under /api/mc/", () => {
    expect(
      canonicalPath({
        pathname: "/api/mc/acme-robotics/platform/stream",
        search: "?run=arun_1",
        base: "/api/mc/",
        from: { org: "acme-robotics", ws: "platform" },
        to: { org: "acme", ws: "core-platform" },
      }),
    ).toBe("/api/mc/acme/core-platform/stream?run=arun_1");
  });

  it("maps the bare scope root", () => {
    expect(
      canonicalPath({
        pathname: "/acme-robotics",
        search: "?x=1",
        base: "/",
        from: { org: "acme-robotics", ws: null },
        to: { org: "acme", ws: null },
      }),
    ).toBe("/acme?x=1");
  });

  it("falls back to the canonical root when the path is unknown or does not match", () => {
    for (const pathname of ["", "/elsewhere", "/acme-robotics-2/x"]) {
      expect(
        canonicalPath({
          pathname,
          search: "?drop=me",
          base: "/",
          from: { org: "acme-robotics", ws: "platform" },
          to: { org: "acme", ws: "core-platform" },
        }),
      ).toBe("/acme/core-platform");
    }
  });
});
