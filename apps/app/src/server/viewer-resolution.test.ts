import { describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import type { MfaPolicy } from "./mfa-gate";
import type { SsoPolicy } from "./sso-gate";
import type { AppSession } from "./session";
import type { SystemLookups } from "./tenancy-lookups";
import {
  canonicalPath,
  type ResolveViewerDeps,
  resolveViewerWith,
} from "./viewer-resolution";

type OrgRecord = NonNullable<Awaited<ReturnType<SystemLookups["orgBySlug"]>>>;
type WorkspaceRecord = NonNullable<
  Awaited<ReturnType<SystemLookups["workspaceBySlug"]>>
>;

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
  user: {
    id: "u1",
    email: "m@acme.example",
    name: "Marcus",
    image: null,
    emailVerified: true,
    twoFactorEnabled: false,
  },
};
const now = new Date("2026-09-12T12:00:00Z");

type Overrides = Partial<{
  [K in keyof SystemLookups]: SystemLookups[K];
}>;

/** A member of acme and core-platform, no MFA policy, unless overridden. */
function lookups(overrides: Overrides = {}): SystemLookups {
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
    workspaceMember: vi.fn(() =>
      Promise.resolve({ id: "wsu_1", role: "member" }),
    ),
    mfaPolicy: vi.fn(() => Promise.resolve(null)),
    ssoPolicy: vi.fn(() => Promise.resolve(null)),
    twoFactorEnabled: vi.fn(() => Promise.resolve(false)),
    invitationByToken: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

const resolve = (l: SystemLookups, o: string, w?: string, s = session) =>
  resolveViewerWith({ session: s, lookups: l, now }, o, w);

describe("resolveViewerWith: allowed", () => {
  it("returns the member's organization and workspace fields", async () => {
    await expect(resolve(lookups(), "acme", "core-platform")).resolves.toEqual({
      kind: "ok",
      org: {
        userId: "u1",
        orgId: org.id,
        orgSlug: "acme",
        orgName: "Acme Robotics",
        orgRole: "member",
      },
      ws: {
        workspaceId: ws.id,
        wsSlug: "core-platform",
        wsName: "Core platform",
        wsRole: "member",
      },
    });
  });

  it("returns organization fields and no workspace, without a workspace lookup", async () => {
    const l = lookups();
    const result = await resolve(l, "acme");
    expect(result).toMatchObject({
      kind: "ok",
      org: { orgId: org.id },
      ws: null,
    });
    expect(l.workspaceBySlug).not.toHaveBeenCalled();
    expect(l.workspaceMember).not.toHaveBeenCalled();
  });

  // The stored set: packages/database/src/schema/org.ts:96 and :170.
  it.each(["owner", "admin", "member", "billing", "compliance", "viewer"])(
    "resolves a member whose stored role is %s with that role",
    async (role) => {
      const l = lookups({ orgRole: () => Promise.resolve(role) });
      await expect(resolve(l, "acme")).resolves.toMatchObject({
        kind: "ok",
        org: { orgRole: role },
      });
    },
  );

  // The stored set: packages/database/src/schema/workspace.ts:148. The
  // workspace role is the viewer's authority inside the workspace, and a page
  // that gates on `orgRole` alone is narrower than a capability granting a
  // workspace role (#3143) — so every stored value has to survive the
  // resolution, not just the ones an org role would have admitted anyway.
  it.each(["owner", "admin", "member", "billing", "compliance", "viewer"])(
    "carries a workspace role of %s onto the workspace fields",
    async (role) => {
      const l = lookups({
        orgRole: () => Promise.resolve("member"),
        workspaceMember: () => Promise.resolve({ id: "wsu_1", role }),
      });
      await expect(resolve(l, "acme", "core-platform")).resolves.toMatchObject({
        kind: "ok",
        org: { orgRole: "member" },
        ws: { wsRole: role },
      });
    },
  );

  it("carries an organization role and a workspace role that differ", async () => {
    // The case the import gate turns on: an org `member` who owns the
    // workspace. Neither field may be inferred from the other.
    const l = lookups({
      orgRole: () => Promise.resolve("member"),
      workspaceMember: () => Promise.resolve({ id: "wsu_1", role: "owner" }),
    });
    await expect(resolve(l, "acme", "core-platform")).resolves.toMatchObject({
      kind: "ok",
      org: { orgRole: "member" },
      ws: { wsRole: "owner" },
    });
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
    ["a--b", undefined],
    ["acme-", undefined],
    ["a.b", undefined],
    ["a".repeat(129), undefined],
    ["acme", "Core"],
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

  it.each(["invitee", "superuser", ""])(
    "404s a member whose stored role %j is outside the stored set, failing closed",
    async (role) => {
      const l = lookups({ orgRole: () => Promise.resolve(role) });
      await expect(resolve(l, "acme")).resolves.toEqual({ kind: "not_found" });
      expect(l.mfaPolicy).not.toHaveBeenCalled();
    },
  );

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

  it("404s an organization member who is not a member of the workspace, on the membership lookup alone", async () => {
    // F3: the workspace guard used to read the organization's workspace list
    // through the shell port and let a slug through when that read failed.
    // Resolution takes the session, the tenancy lookups and the clock, so a
    // failing shell context read has no way in; the decision is the membership row.
    const l = lookups({
      workspaceMember: vi.fn(() => Promise.resolve(null)),
    });
    const deps: ResolveViewerDeps = { session, lookups: l, now };
    await expect(
      resolveViewerWith(deps, "acme", "core-platform"),
    ).resolves.toEqual({ kind: "not_found" });
    expect(l.workspaceBySlug).toHaveBeenCalledWith(org.id, "core-platform");
    expect(l.workspaceMember).toHaveBeenCalledWith(ws.id, "u1");
    const failingShell = {
      context: () =>
        Promise.resolve(readError("control_plane_unavailable", 503)),
    };
    // @ts-expect-error -- a shell read port is not a dependency of viewer resolution
    void ((_: ResolveViewerDeps) => 0)({ ...deps, port: failingShell });
  });

  it("404s a workspace membership whose role is outside the stored set", async () => {
    // Fails closed exactly as an unknown organization role does. The CHECK
    // makes this unreachable through the app, so a value that got here came
    // from somewhere that does not speak the canonical set, and the viewer is
    // not minted with authority nobody can read.
    const l = lookups({
      workspaceMember: () => Promise.resolve({ id: "wsu_1", role: "auditor" }),
    });
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
      workspaceMember: () => Promise.resolve(null),
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

describe("resolveViewerWith: SSO gate", () => {
  const sso: SsoPolicy = { ssoRequired: true, providerIds: ["acme-okta"] };
  const withMethod = (authMethod: string | null): AppSession => ({
    ...session,
    authMethod,
  });

  it("sends a member signed in with a password to SSO", async () => {
    const l = lookups({ ssoPolicy: () => Promise.resolve(sso) });
    await expect(
      resolve(l, "acme", "core-platform", withMethod("password")),
    ).resolves.toEqual({ kind: "sso_required" });
  });

  it("sends a stale session that recorded no method to SSO", async () => {
    const l = lookups({ ssoPolicy: () => Promise.resolve(sso) });
    await expect(resolve(l, "acme")).resolves.toEqual({
      kind: "sso_required",
    });
  });

  it("lets a session from one of the organization's providers through", async () => {
    const l = lookups({ ssoPolicy: () => Promise.resolve(sso) });
    expect(
      (await resolve(l, "acme", "core-platform", withMethod("sso:acme-okta")))
        .kind,
    ).toBe("ok");
  });

  it("refuses a session from another organization's provider", async () => {
    const l = lookups({ ssoPolicy: () => Promise.resolve(sso) });
    await expect(
      resolve(l, "acme", undefined, withMethod("sso:globex-okta")),
    ).resolves.toEqual({ kind: "sso_required" });
  });

  it("lets an owner through on a password session (break-glass)", async () => {
    const l = lookups({
      orgRole: () => Promise.resolve("owner"),
      ssoPolicy: () => Promise.resolve(sso),
    });
    const result = await resolve(l, "acme", undefined, withMethod("password"));
    expect(result.kind).toBe("ok");
  });

  it("checks SSO before MFA enrollment", async () => {
    const l = lookups({
      orgRole: () => Promise.resolve("admin"),
      ssoPolicy: () => Promise.resolve(sso),
      mfaPolicy: () =>
        Promise.resolve({
          mfaRequired: true,
          mfaGraceHours: 0,
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        }),
    });
    await expect(resolve(l, "acme")).resolves.toEqual({
      kind: "sso_required",
    });
  });

  it("does not disclose the policy to a non-member", async () => {
    const l = lookups({
      orgRole: () => Promise.resolve(null),
      ssoPolicy: vi.fn(() => Promise.resolve(sso)),
    });
    await expect(resolve(l, "acme")).resolves.toEqual({ kind: "not_found" });
    expect(l.ssoPolicy).not.toHaveBeenCalled();
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
