// The organization port: one kernel read of list_members at org scope for the
// People tab, one of list_workspaces for the API keys tab's workspace picker
// and one of list_api_keys for its table, each mapped into its view model, with
// a refusal passed through and an unmappable answer reported once. The keys are
// read through a WsCtx: a key names a workspace (ADR-069).
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx, WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { org } = await import("./org");

const ORG_FIELDS = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
} as const;

const ctx = unsafeMint(OrgCtx, ORG_FIELDS);

/** The workspace scope the keys read runs in. */
const wsCtx = unsafeMint(WsCtx, {
  ...ORG_FIELDS,
  workspaceId: "7a000000-0000-4000-8000-0000000000c3",
  wsSlug: "core-platform",
  wsName: "Core platform",
});

const member = {
  id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
  role: "Owner",
  joinedAt: "2026-03-02T09:15:00.000Z",
};
const invitation = {
  id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
  email: "dana.reyes@acme.example",
  role: "Admin",
  invitedAt: "2026-09-10T12:00:00.000Z",
  expiresAt: null,
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("org.members", () => {
  it("reads list_members at org scope for the organization page and returns the People view model", async () => {
    kernelRead.mockResolvedValue(
      readOk({ scope: "org", members: [member], invitations: [invitation] }),
    );
    expect(await org.members(ctx)).toEqual(
      readOk({
        members: [{ ...member, role: "owner" }],
        invitations: [{ ...invitation, role: "admin" }],
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: listMembers,
      input: { scope: "org" },
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a denied read through (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.admin" };
    kernelRead.mockResolvedValue(denied);
    expect(await org.members(ctx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await org.members(ctx)).toEqual(down);
  });

  it("answers record_unmappable and reports once for a row the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        scope: "org",
        members: [{ ...member, role: "superuser" }],
        invitations: [],
      }),
    );
    expect(await org.members(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("answers record_unmappable and reports once when the kernel answers at workspace scope (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ scope: "workspace", members: [member] }),
    );
    expect(await org.members(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });
});

const storedKey = {
  publicId: "aky_7k2m9q4x8r1t5v3w6y0z2a",
  name: "CI runner",
  prefix: "ox_liveliveli",
  createdAt: "2026-09-13T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};

describe("org.workspaces", () => {
  const workspace = (slug: string, role: string | null) => ({
    id: "7a000000-0000-4000-8000-0000000000c3",
    publicId: "wsp_7k2m9q4x8r1t5v3w6y0z2a",
    slug,
    namespace: `acme/${slug}`,
    name: slug === "core-platform" ? "Core platform" : "Growth",
    role,
    archivedAt: null,
  });

  it("reads list_workspaces for this organization and returns the workspaces the viewer may enter", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        organization: {
          id: ORG_FIELDS.orgId,
          publicId: "org_1",
          slug: "acme",
          namespace: "acme",
          name: "Acme Robotics",
        },
        workspaces: [
          workspace("core-platform", "owner"),
          // Viewer resolution answers a workspace with no membership with a
          // 404 (INV-15), so it is not a choice the picker may offer.
          workspace("growth", null),
        ],
      }),
    );
    expect(await org.workspaces(ctx)).toEqual(
      readOk([{ slug: "core-platform", name: "Core platform" }]),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: workspaceList,
      input: { orgSlug: "acme" },
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await org.workspaces(ctx)).toEqual(down);
  });
});

describe("org.apiKeys", () => {
  it("reads list_api_keys in the workspace scope and returns the API keys view model", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [storedKey] }));
    expect(await org.apiKeys(wsCtx)).toEqual(
      readOk([
        {
          id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
          name: "CI runner",
          prefix: "ox_liveliveli",
          createdAt: "2026-09-13T10:00:00.000Z",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        },
      ]),
    );
    expect(kernelRead).toHaveBeenCalledWith(wsCtx, {
      contract: apiKeyList,
      input: {},
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("returns an empty list for a workspace holding no keys", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [] }));
    expect(await org.apiKeys(wsCtx)).toEqual(readOk([]));
  });

  it("passes a denied read through (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.admin" };
    kernelRead.mockResolvedValue(denied);
    expect(await org.apiKeys(wsCtx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await org.apiKeys(wsCtx)).toEqual(down);
  });

  it("answers record_unmappable and reports once for a key the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        items: [
          { ...storedKey, publicId: "7a000000-0000-4000-8000-0000000000a1" },
        ],
      }),
    );
    expect(await org.apiKeys(wsCtx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
