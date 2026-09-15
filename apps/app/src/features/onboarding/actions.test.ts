// The organization action through the real viewer and kernel seams: the session
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether create_org ran.
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, getSession, redirect } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  getSession: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { createOrganizationAction } = await import("./actions");

const form = {
  name: "  Acme Robotics ",
  slug: "acme",
  workspaceName: "Core platform",
  workspaceSlug: "core-platform",
};
const created = {
  publicId: "org_01",
  name: "Acme Robotics",
  slug: "acme",
  type: "business",
  createdAt: "2026-09-15T00:00:00.000Z",
  workspace: { publicId: "wrk_01", slug: "core-platform" },
};

beforeEach(() => {
  invoke.mockReset();
  redirect.mockClear();
  getSession.mockResolvedValue({
    user: { id: "u-owner", email: "priya@acme.example" },
  });
});

describe("createOrganizationAction", () => {
  it("sends a signed-out visitor to log in and back, creating nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(createOrganizationAction(form)).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Fnew-organization",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an invalid field with its catalog key, creating nothing (negative)", async () => {
    expect(
      await createOrganizationAction({ ...form, workspaceSlug: "billing" }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "workspaceSlugReserved",
      field: "workspaceSlug",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a kernel denial as denied (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        organizationCreate.name,
        "authz_denied",
        "denied",
      ),
    );
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
  });

  it("returns a taken address as the handler's conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "conflict", reason: "slug_taken" }),
    );
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      reason: "conflict",
      code: "slug_taken",
    });
  });

  it("creates the organization as the signed-in person before any tenant and lands on its first workspace", async () => {
    invoke.mockResolvedValue(created);
    expect(await createOrganizationAction(form)).toEqual({
      ok: true,
      value: { to: "/acme/core-platform" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_org",
      {
        name: "Acme Robotics",
        slug: "acme",
        workspace: { name: "Core platform", slug: "core-platform" },
      },
      expect.objectContaining({
        userId: "u-owner",
        orgId: "",
        workspaceId: "",
      }),
    );
  });
});
