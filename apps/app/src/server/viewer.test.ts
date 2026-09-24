import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvitationRecord } from "./tenancy-lookups";
import type { ViewerResolution } from "./viewer-resolution";

/** A context's own fields as a plain object, for comparison with the fields it was minted from. */
const fieldsOf = (ctx: object) => Object.fromEntries(Object.entries(ctx));

class NavigationInterrupt extends Error {
  constructor(
    kind: string,
    readonly url?: string,
  ) {
    super(kind);
  }
}

const nav = vi.hoisted(() => {
  const interrupt = (kind: string) =>
    vi.fn((url?: string) => {
      throw new NavigationInterrupt(kind, url);
    });
  return {
    redirect: interrupt("NEXT_REDIRECT"),
    permanentRedirect: interrupt("NEXT_PERMANENT_REDIRECT"),
    notFound: interrupt("NEXT_NOT_FOUND"),
  };
});
const {
  requestHeaders,
  getSessionMock,
  resolveMock,
  invitationByToken,
  mfaPolicy,
  freePlanIncludedGau,
} = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  getSessionMock: vi.fn(),
  resolveMock: vi.fn<() => Promise<ViewerResolution>>(),
  invitationByToken: vi.fn<() => Promise<InvitationRecord | null>>(),
  mfaPolicy: vi.fn(),
  freePlanIncludedGau: vi.fn<() => Promise<number | null>>(),
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
  systemLookups: {
    name: "live",
    invitationByToken,
    mfaPolicy,
    freePlanIncludedGau,
  },
}));
vi.mock("./viewer-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./viewer-resolution")>()),
  resolveViewerWith: resolveMock,
}));

import { routes } from "@/shared/safe-path";
import { MFA_ENROLL_PATH } from "./mfa-gate";
import { systemLookups } from "./tenancy-lookups";
import {
  InviteeCtx,
  OrgCtx,
  orgTwoFactorPolicy,
  type OrgFields,
  PretenantCtx,
  readFreePlanAllowance,
  readInvitation,
  requireInvitee,
  requireUser,
  requireViewer,
  resolveWorkspaceViewer,
  WsCtx,
  type WsFields,
} from "./viewer";
import { unsafeMint } from "./viewer.testing";

const orgFields: OrgFields = {
  userId: "u1",
  orgId: "11111111-1111-4111-8111-111111111111",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
};
const wsFields: WsFields = {
  ...orgFields,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
};
const session = { user: { id: "u1", email: "Priya@Acme.example" } };
const invitation: InvitationRecord = {
  invitationId: "0192f1c4-0000-7000-8000-0000000000aa",
  orgId: orgFields.orgId,
  orgName: "Acme Robotics",
  orgSlug: "acme",
  email: " priya@acme.example",
  role: "Admin",
  status: "pending",
  invitedAt: new Date("2026-09-11T09:00:00Z"),
  expiresAt: null,
  inviterName: "Priya Natarajan",
  inviterRole: "Owner",
};

beforeEach(() => {
  for (const key of [...requestHeaders.keys()]) requestHeaders.delete(key);
  resolveMock.mockReset();
  invitationByToken.mockReset();
  freePlanIncludedGau.mockReset();
  getSessionMock.mockResolvedValue(null);
});

describe("the context classes", () => {
  it("a minted context is recognised by its own class and frozen", () => {
    const ctx = unsafeMint(OrgCtx, orgFields);
    expect(OrgCtx.is(ctx)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(fieldsOf(ctx)).toEqual(orgFields);
  });

  it.each([
    ["a plain object with the right keys", () => ({ ...orgFields })],
    [
      "an Object.assign copy",
      // eslint-disable-next-line no-restricted-syntax -- the copy INV-02 refuses at runtime
      () => Object.assign({}, unsafeMint(OrgCtx, orgFields), { orgId: "x" }),
    ],
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- the copy INV-02 refuses at runtime
    ["a spread copy", () => ({ ...unsafeMint(OrgCtx, orgFields) })],
    // eslint-disable-next-line no-restricted-syntax -- the clone INV-02 refuses at runtime
    ["a structuredClone", () => structuredClone(unsafeMint(OrgCtx, orgFields))],
    [
      "Object.create(OrgCtx.prototype)",
      (): unknown => Object.create(OrgCtx.prototype),
    ],
  ])("OrgCtx.is refuses %s (negative)", (_form, make) => {
    expect(OrgCtx.is(make())).toBe(false);
  });

  it("Object.assign onto a minted context throws TypeError (negative)", () => {
    const ctx = unsafeMint(OrgCtx, orgFields);
    // eslint-disable-next-line no-restricted-syntax -- the write INV-02 refuses at runtime
    expect(() => Object.assign(ctx, { orgId: "victim" })).toThrow(TypeError);
    expect(ctx.orgId).toBe(orgFields.orgId);
  });

  it.each([
    // @ts-expect-error -- a token not minted by viewer-mint.ts
    ["OrgCtx", () => OrgCtx.mint(Symbol("mint"), orgFields)],
    // @ts-expect-error -- a token not minted by viewer-mint.ts
    ["WsCtx", () => WsCtx.mint(Symbol("mint"), wsFields)],
    // @ts-expect-error -- a token not minted by viewer-mint.ts
    ["PretenantCtx", () => PretenantCtx.mint(Symbol("mint"), { userId: "u1" })],
    [
      "InviteeCtx",
      // @ts-expect-error -- a token not minted by viewer-mint.ts
      () => InviteeCtx.mint(Symbol("mint"), { ...invitation, userId: "u1" }),
    ],
  ])(
    "%s.mint refuses a forged token with invalid_ctx (negative)",
    (_c, mint) => {
      expect(mint).toThrow("invalid_ctx");
    },
  );

  it("a WsCtx satisfies OrgCtx.is and an OrgCtx does not satisfy WsCtx.is", () => {
    const ws = unsafeMint(WsCtx, wsFields);
    expect(OrgCtx.is(ws)).toBe(true);
    expect(WsCtx.is(ws)).toBe(true);
    expect(Object.isFrozen(ws)).toBe(true);
    expect(WsCtx.is(unsafeMint(OrgCtx, orgFields))).toBe(false);
  });

  it("no class recognises another class's context (negative)", () => {
    const org = unsafeMint(OrgCtx, orgFields);
    const pretenant = unsafeMint(PretenantCtx, { userId: "u1" });
    const invitee = unsafeMint(InviteeCtx, {
      userId: "u1",
      orgId: orgFields.orgId,
      invitationId: invitation.invitationId,
    });
    expect(PretenantCtx.is(org)).toBe(false);
    expect(InviteeCtx.is(org)).toBe(false);
    expect(OrgCtx.is(pretenant)).toBe(false);
    expect(OrgCtx.is(invitee)).toBe(false);
    expect([PretenantCtx.is(pretenant), InviteeCtx.is(invitee)]).toEqual([
      true,
      true,
    ]);
  });
});

describe("requireViewer", () => {
  it("hands the session and the database lookups to the resolver, and mints a WsCtx for a workspace", async () => {
    getSessionMock.mockResolvedValue(session);
    const {
      orgId: _o,
      orgSlug: _s,
      orgName: _n,
      orgRole: _r,
      userId: _u,
      ...ws
    } = wsFields;
    resolveMock.mockResolvedValue({ kind: "ok", org: orgFields, ws });
    const ctx = await requireViewer("acme", "core-platform");
    expect(WsCtx.is(ctx)).toBe(true);
    expect(fieldsOf(ctx)).toEqual(wsFields);
    expect(resolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ session, lookups: systemLookups }),
      "acme",
      "core-platform",
    );
  });

  it("mints an OrgCtx, never a WsCtx, for an organization", async () => {
    resolveMock.mockResolvedValue({ kind: "ok", org: orgFields, ws: null });
    const ctx = await requireViewer("acme");
    expect(OrgCtx.is(ctx)).toBe(true);
    expect(WsCtx.is(ctx)).toBe(false);
    expect(fieldsOf(ctx)).toEqual(orgFields);
  });

  it("redirects a signed-out request to login", async () => {
    resolveMock.mockResolvedValue({ kind: "unauthenticated" });
    await expect(requireViewer("acme")).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith("/login");
  });

  it("404s an unknown organization or a non-member", async () => {
    resolveMock.mockResolvedValue({ kind: "not_found" });
    await expect(requireViewer("acme", "finops")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(nav.notFound).toHaveBeenCalled();
  });

  it("sends an overdue privileged member to MFA enrollment", async () => {
    resolveMock.mockResolvedValue({ kind: "mfa_enroll" });
    await expect(requireViewer("acme")).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith(MFA_ENROLL_PATH);
  });

  it("sends a member without an SSO session to the SSO sign-in, carrying the page", async () => {
    requestHeaders.set(
      "x-url",
      "https://app.oxagen.sh/acme/core/spend?range=7d",
    );
    resolveMock.mockResolvedValue({ kind: "sso_required" });
    await expect(requireViewer("acme", "core")).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(nav.redirect).toHaveBeenCalledWith(
      "/login?next=%2Facme%2Fcore%2Fspend%3Frange%3D7d&sso=required",
    );
  });

  it("sends a member without an SSO session to the SSO sign-in with no page when the request URL is unknown", async () => {
    resolveMock.mockResolvedValue({ kind: "sso_required" });
    await expect(requireViewer("acme")).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith("/login?sso=required");
  });

  it("308s a historical slug to the canonical URL, keeping the path and query from x-url over next-url", async () => {
    requestHeaders.set("next-url", "/acme-robotics/platform/steering");
    requestHeaders.set(
      "x-url",
      "https://app.oxagen.sh/acme-robotics/platform/tools/connections?q=1",
    );
    resolveMock.mockResolvedValue({
      kind: "redirect",
      org: "acme",
      ws: "core-platform",
    });
    await expect(requireViewer("acme-robotics", "platform")).rejects.toThrow(
      "NEXT_PERMANENT_REDIRECT",
    );
    expect(nav.permanentRedirect).toHaveBeenCalledWith(
      "/acme/core-platform/tools/connections?q=1",
    );
  });

  it("reads next-url when x-url is absent", async () => {
    requestHeaders.set("next-url", "/acme-robotics/api-keys?x=1");
    resolveMock.mockResolvedValue({ kind: "redirect", org: "acme", ws: null });
    await expect(requireViewer("acme-robotics")).rejects.toThrow(
      "NEXT_PERMANENT_REDIRECT",
    );
    expect(nav.permanentRedirect).toHaveBeenCalledWith("/acme/api-keys?x=1");
  });

  it.each([
    ["the request path is not exposed", null],
    ["the header is not a URL", "http://[::1"],
  ])("308s to the canonical root when %s", async (_why, header) => {
    if (header !== null) requestHeaders.set("x-url", header);
    resolveMock.mockResolvedValue({ kind: "redirect", org: "acme", ws: null });
    await expect(requireViewer("acme-robotics")).rejects.toThrow(
      "NEXT_PERMANENT_REDIRECT",
    );
    expect(nav.permanentRedirect).toHaveBeenLastCalledWith("/acme");
  });
});

describe("orgTwoFactorPolicy", () => {
  it("reads the organization's policy row, the one the MFA gate enforces", async () => {
    mfaPolicy.mockResolvedValue({
      mfaRequired: true,
      mfaGraceHours: 72,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(await orgTwoFactorPolicy(unsafeMint(OrgCtx, orgFields))).toEqual({
      required: true,
    });
    expect(mfaPolicy).toHaveBeenCalledWith(orgFields.orgId);
  });

  it("requires nothing when the organization has no policy row", async () => {
    mfaPolicy.mockResolvedValue(null);
    expect(await orgTwoFactorPolicy(unsafeMint(OrgCtx, orgFields))).toEqual({
      required: false,
    });
  });

  it("refuses a forged context (negative)", async () => {
    await expect(
      // @ts-expect-error -- a context not minted by viewer-mint.ts
      orgTwoFactorPolicy({ ...orgFields }),
    ).rejects.toThrow(TypeError);
describe("resolveWorkspaceViewer", () => {
  const {
    orgId: _o,
    orgSlug: _s,
    orgName: _n,
    orgRole: _r,
    userId: _u,
    ...ws
  } = wsFields;
  /** The organization resolves; the workspace answers `forWs`. */
  function resolveWith(forWs: ViewerResolution) {
    resolveMock.mockImplementation((...args: unknown[]) =>
      Promise.resolve(
        args[2] === undefined
          ? { kind: "ok", org: orgFields, ws: null }
          : forWs,
      ),
    );
  }

  it("mints a WsCtx for a member of the workspace", async () => {
    resolveWith({ kind: "ok", org: orgFields, ws });
    const out = await resolveWorkspaceViewer("acme", "core-platform");
    expect(out.kind).toBe("ok");
    expect(WsCtx.is(out.ctx)).toBe(true);
    expect(fieldsOf(out.ctx)).toEqual(wsFields);
  });

  it("answers refused with the organization ctx for a workspace it will not admit (negative)", async () => {
    resolveWith({ kind: "not_found" });
    const out = await resolveWorkspaceViewer("acme", "finops");
    expect(out.kind).toBe("refused");
    expect(OrgCtx.is(out.ctx)).toBe(true);
    expect(WsCtx.is(out.ctx)).toBe(false);
    expect(fieldsOf(out.ctx)).toEqual(orgFields);
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("still 404s an organization the viewer is not a member of (negative)", async () => {
    resolveMock.mockResolvedValue({ kind: "not_found" });
    await expect(resolveWorkspaceViewer("acme", "finops")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("still redirects a historical workspace slug to its canonical URL", async () => {
    requestHeaders.set("x-url", "https://app.oxagen.sh/acme/platform/tools");
    resolveWith({ kind: "redirect", org: "acme", ws: "core-platform" });
    await expect(resolveWorkspaceViewer("acme", "platform")).rejects.toThrow(
      "NEXT_PERMANENT_REDIRECT",
    );
    expect(nav.permanentRedirect).toHaveBeenCalledWith(
      "/acme/core-platform/tools",
    );
  });
});

describe("requireUser", () => {
  it("mints a PretenantCtx for the signed-in person", async () => {
    getSessionMock.mockResolvedValue(session);
    const ctx = await requireUser();
    expect(PretenantCtx.is(ctx)).toBe(true);
    expect(fieldsOf(ctx)).toEqual({ userId: "u1" });
  });

  it("redirects a signed-out request to login (negative)", async () => {
    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith("/login");
  });

  it("carries the destination through login for a signed-out request (negative)", async () => {
    await expect(
      requireUser(routes.cliAuthorize({ state: "st_1" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith(
      "/login?next=%2Fcli%2Fauthorize%3Fstate%3Dst_1",
    );
  });
});

describe("readInvitation", () => {
  it("reads the invitation behind a token with no session and no interrupt", async () => {
    invitationByToken.mockResolvedValue(invitation);
    await expect(readInvitation("invi_live")).resolves.toBe(invitation);
    expect(invitationByToken).toHaveBeenCalledWith("invi_live");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("returns an expired invitation as stored, for the page to close as expired", async () => {
    const expired = {
      ...invitation,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    };
    invitationByToken.mockResolvedValue(expired);
    await expect(readInvitation("invi_old")).resolves.toBe(expired);
  });

  it("reads an unknown token as null, without an interrupt (negative)", async () => {
    invitationByToken.mockResolvedValue(null);
    await expect(readInvitation("invi_nope")).resolves.toBeNull();
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it("refuses a malformed token before any lookup (negative)", async () => {
    await expect(readInvitation("../../etc")).resolves.toBeNull();
    await expect(readInvitation("")).resolves.toBeNull();
    await expect(readInvitation("a".repeat(65))).resolves.toBeNull();
    expect(invitationByToken).not.toHaveBeenCalled();
  });
});

describe("readFreePlanAllowance", () => {
  it("reads the Free plan's allowance with no session", async () => {
    freePlanIncludedGau.mockResolvedValue(5000);
    await expect(readFreePlanAllowance()).resolves.toBe(5000);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("passes a missing plan row through as null (negative)", async () => {
    freePlanIncludedGau.mockResolvedValue(null);
    await expect(readFreePlanAllowance()).resolves.toBeNull();
  });
});

describe("requireInvitee", () => {
  it("mints an InviteeCtx with no orgRole for the invited address, ignoring case and surrounding space", async () => {
    getSessionMock.mockResolvedValue(session);
    invitationByToken.mockResolvedValue(invitation);
    const { ctx, invitation: read } = await requireInvitee("invi_live");
    expect(InviteeCtx.is(ctx)).toBe(true);
    expect(fieldsOf(ctx)).toEqual({
      userId: "u1",
      orgId: invitation.orgId,
      invitationId: invitation.invitationId,
    });
    expect(read).toBe(invitation);
    expect(invitationByToken).toHaveBeenCalledWith("invi_live");
  });

  it("redirects a signed-out request to login before any lookup (negative)", async () => {
    await expect(requireInvitee("invi_live")).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith("/login");
    expect(invitationByToken).not.toHaveBeenCalled();
  });

  it("404s an unknown token (negative)", async () => {
    getSessionMock.mockResolvedValue(session);
    invitationByToken.mockResolvedValue(null);
    await expect(requireInvitee("invi_nope")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s an invitation addressed to another email (negative)", async () => {
    getSessionMock.mockResolvedValue(session);
    invitationByToken.mockResolvedValue({
      ...invitation,
      email: "someone.else@acme.example",
    });
    await expect(requireInvitee("invi_live")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
