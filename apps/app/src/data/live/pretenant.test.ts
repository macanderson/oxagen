// The pretenant port: kernel reads with a PretenantCtx, mapped into
// organization and workspace choices, with a refusal passed through and an
// unmappable record reported once.
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { PretenantCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { pretenant } = await import("./pretenant");

const ctx = unsafeMint(PretenantCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
});

const organization = {
  id: "7a000000-0000-4000-8000-0000000000a1",
  publicId: "org_acme",
  slug: "acme",
  namespace: "acme",
  name: "Acme Robotics",
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("pretenant.orgs", () => {
  it("reads list_orgs through the kernel seam with the PretenantCtx", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        organizations: [{ ...organization, role: "owner", avatarUrl: null }],
      }),
    );
    expect(await pretenant.orgs(ctx)).toEqual(
      readOk([{ slug: "acme", name: "Acme Robotics", avatarUrl: null }]),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: orgList,
      input: {},
      page: "shell",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for an organization the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        organizations: [
          { ...organization, slug: "", role: "owner", avatarUrl: null },
        ],
      }),
    );
    expect(await pretenant.orgs(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("pretenant.workspaces", () => {
  it("reads list_workspaces for the organization and keeps the viewer's memberships", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        organization,
        workspaces: [
          {
            id: "7b000000-0000-4000-8000-000000000001",
            publicId: "ws_core",
            slug: "core",
            namespace: "core",
            name: "Core platform",
            role: "member",
          },
          {
            id: "7b000000-0000-4000-8000-000000000002",
            publicId: "ws_finance",
            slug: "finance",
            namespace: "finance",
            name: "Finance",
            role: null,
          },
        ],
      }),
    );
    expect(await pretenant.workspaces(ctx, "acme")).toEqual(
      readOk([{ slug: "core", name: "Core platform", avatarUrl: null }]),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: workspaceList,
      input: { orgSlug: "acme" },
      page: "shell",
    });
  });

  it("answers denied for an organization the person is not a member of (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.read" };
    kernelRead.mockResolvedValue(denied);
    expect(await pretenant.workspaces(ctx, "globex")).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a workspace the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        organization,
        workspaces: [
          {
            id: "7b000000-0000-4000-8000-000000000001",
            publicId: "ws_core",
            slug: "",
            namespace: "core",
            name: "Core platform",
            role: "owner",
          },
        ],
      }),
    );
    expect(await pretenant.workspaces(ctx, "acme")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
