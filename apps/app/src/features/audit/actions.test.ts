// Build bundle (actions.ts): export_data with scope "org" for the organization
// the viewer resolved, never one named by the input, answered with the export
// id; a refusal passes through as the kernel seam classified it (INV-19).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, kernelWrite } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  kernelWrite: vi.fn(),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/server/kernel", () => ({ kernelWrite }));

const { privacyDataExport } = await import(
  "@oxagen/oxagen/contracts/privacy.data.export"
);
const { buildBundle } = await import("./actions");

const ctx = { orgId: "7a000000-0000-4000-8000-0000000000a1", orgSlug: "acme" };
const EXPORT_ID = "3f1c2b7a-9d4e-4c1b-8a2f-5e6d7c8b9a01";

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
  kernelWrite.mockReset();
});

describe("buildBundle", () => {
  it("queues export_data for the viewer's organization and answers the export id", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { exportId: EXPORT_ID, status: "queued" },
    });
    expect(await buildBundle("acme")).toEqual({
      ok: true,
      value: { exportId: EXPORT_ID },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(kernelWrite).toHaveBeenCalledWith(ctx, privacyDataExport, {
      scope: "org",
      orgId: ctx.orgId,
    });
  });

  it("passes a refusal through, so a member who is not an owner or admin is told (negative)", async () => {
    const denied = { ok: false, reason: "denied", code: "forbidden" } as const;
    kernelWrite.mockResolvedValue(denied);
    expect(await buildBundle("acme")).toEqual(denied);
  });

  it("passes an invalid answer through (negative)", async () => {
    const invalid = {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "orgId",
    } as const;
    kernelWrite.mockResolvedValue(invalid);
    expect(await buildBundle("acme")).toEqual(invalid);
  });
});
