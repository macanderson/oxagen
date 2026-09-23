// The Runtimes write (runtimes.md, Permissions: `runtime.unenroll`): Unenroll
// resolves the viewer the URL names and revokes the one enrollment the page
// shows through `revoke_tacho_enrollment`, sending no reason it did not ask
// for. A refusal comes back unchanged, so the dialog can name it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const kernelWrite = vi.fn();
const requireViewer = vi.fn();
vi.mock("@/server/kernel", () => ({
  kernelWrite: (...args: unknown[]) => kernelWrite(...args),
}));
vi.mock("@/server/viewer", () => ({
  requireViewer: (...args: unknown[]) => requireViewer(...args),
}));

const { tachoEnrollmentRevoke } = await import(
  "@oxagen/oxagen/contracts/tacho.enrollment.revoke"
);
const { unenrollRuntime } = await import("./actions");

const ctx = { marker: "viewer" };

beforeEach(() => {
  kernelWrite.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("unenrollRuntime", () => {
  it("revokes the enrollment for the viewer the URL names", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        hostEnrollmentId: "tch_mbellmbp16aaaaaaaaaaaaa",
        status: "revoked",
        revokedAt: "2026-09-23T10:00:00.000Z",
      },
    });
    const result = await unenrollRuntime(
      "acme",
      "core-platform",
      "tch_mbellmbp16aaaaaaaaaaaaa",
    );
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(ctx, tachoEnrollmentRevoke, {
      hostEnrollmentId: "tch_mbellmbp16aaaaaaaaaaaaa",
    });
    expect(result).toEqual({
      ok: true,
      value: { revokedAt: "2026-09-23T10:00:00.000Z" },
    });
  });

  it("returns a refusal as the seam classified it", async () => {
    const denied = { ok: false, reason: "denied", code: "authz_denied" };
    kernelWrite.mockResolvedValue(denied);
    await expect(
      unenrollRuntime("acme", "core-platform", "tch_mbellmbp16aaaaaaaaaaaaa"),
    ).resolves.toEqual(denied);
  });

  it("returns an input the contract refuses as invalid", async () => {
    const invalid = {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "hostEnrollmentId",
    };
    kernelWrite.mockResolvedValue(invalid);
    await expect(
      unenrollRuntime("acme", "core-platform", "not-an-id"),
    ).resolves.toEqual(invalid);
  });
});
