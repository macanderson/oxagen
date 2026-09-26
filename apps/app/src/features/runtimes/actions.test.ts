// The Runtimes writes. Add a runtime names one through `create_runtime`
// (ADR-192) and answers the register flow with that runtime chosen. Unenroll
// (runtimes.md, Permissions: `runtime.unenroll`) resolves the viewer the URL
// names and revokes the one enrollment the page shows through
// `revoke_tacho_enrollment`, sending no reason it did not ask for. A refusal
// comes back unchanged, so the dialog can name it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const kernelWrite = vi.fn<(...args: unknown[]) => unknown>();
const requireViewer = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("@/server/kernel", () => ({
  kernelWrite: (...args: unknown[]) => kernelWrite(...args),
}));
vi.mock("@/server/viewer", () => ({
  requireViewer: (...args: unknown[]) => requireViewer(...args),
}));

const { tachoEnrollmentRevoke } = await import(
  "@oxagen/oxagen/contracts/tacho.enrollment.revoke"
);
const { runtimeCreate } = await import(
  "@oxagen/oxagen/contracts/runtime.create"
);
const { createRuntime, unenrollRuntime } = await import("./actions");

const ctx = { marker: "viewer", orgSlug: "acme", wsSlug: "core-platform" };

describe("createRuntime", () => {
  it("names the runtime and answers the register flow with it chosen", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        runtime: {
          id: "rtm_macslaptop",
          name: "Mac's laptop",
          slug: "macs-laptop",
        },
      },
    });
    const result = await createRuntime("acme", "core-platform", {
      name: "  Mac's laptop ",
      slug: "macs-laptop",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(ctx, runtimeCreate, {
      name: "Mac's laptop",
      slug: "macs-laptop",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: "rtm_macslaptop",
        name: "Mac's laptop",
        slug: "macs-laptop",
        register: "/acme/core-platform/register/name?runtime=rtm_macslaptop",
      },
    });
  });

  it("leaves an empty slug for the handler to derive", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { runtime: { id: "rtm_gpu", name: "GPU box", slug: "gpu-box" } },
    });
    await createRuntime("acme", "core-platform", {
      name: "GPU box",
      slug: " ",
    });
    expect(kernelWrite).toHaveBeenCalledWith(ctx, runtimeCreate, {
      name: "GPU box",
    });
  });

  it("returns a taken slug as the conflict the handler named", async () => {
    const taken = { ok: false, reason: "conflict", code: "runtime_slug_taken" };
    kernelWrite.mockResolvedValue(taken);
    await expect(
      createRuntime("acme", "core-platform", {
        name: "GPU box",
        slug: "gpu-box",
      }),
    ).resolves.toEqual(taken);
  });
});

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
