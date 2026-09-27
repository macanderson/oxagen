// The Runtimes writes. Add a runtime names one through `create_runtime`
// (ADR-198) and answers the register flow with that runtime chosen. The
// Containment switch sets one field through `update_runtime` (ADR-204). Unenroll
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
const { runtimeUpdate } = await import(
  "@oxagen/oxagen/contracts/runtime.update"
);
const { createRuntime, setRuntimeContainment, unenrollRuntime } = await import(
  "./actions"
);

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

  it("asks for containment only when the person chose it (ADR-204)", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { runtime: { id: "rtm_gpu", name: "GPU box", slug: "gpu-box" } },
    });
    await createRuntime("acme", "core-platform", {
      name: "GPU box",
      slug: "gpu-box",
      containmentRequired: true,
    });
    expect(kernelWrite).toHaveBeenLastCalledWith(ctx, runtimeCreate, {
      name: "GPU box",
      slug: "gpu-box",
      containmentRequired: true,
    });
    await createRuntime("acme", "core-platform", {
      name: "GPU box",
      slug: "gpu-box",
      containmentRequired: false,
    });
    expect(kernelWrite).toHaveBeenLastCalledWith(ctx, runtimeCreate, {
      name: "GPU box",
      slug: "gpu-box",
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

describe("setRuntimeContainment (ADR-204)", () => {
  it("sends the runtime and the new value, and answers the value recorded", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        runtime: {
          id: "rtm_macslaptop",
          name: "Mac's laptop",
          slug: "macs-laptop",
        },
        containmentRequired: true,
      },
    });
    const result = await setRuntimeContainment(
      "acme",
      "core-platform",
      "rtm_macslaptop",
      true,
    );
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(ctx, runtimeUpdate, {
      runtimeId: "rtm_macslaptop",
      containmentRequired: true,
    });
    expect(result).toEqual({ ok: true, value: { containmentRequired: true } });
  });

  it("sends a false value rather than leaving the field out", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        runtime: {
          id: "rtm_macslaptop",
          name: "Mac's laptop",
          slug: "macs-laptop",
        },
        containmentRequired: false,
      },
    });
    await expect(
      setRuntimeContainment("acme", "core-platform", "rtm_macslaptop", false),
    ).resolves.toEqual({ ok: true, value: { containmentRequired: false } });
    expect(kernelWrite).toHaveBeenCalledWith(ctx, runtimeUpdate, {
      runtimeId: "rtm_macslaptop",
      containmentRequired: false,
    });
  });

  it("returns a refusal as the seam classified it (negative)", async () => {
    const denied = { ok: false, reason: "denied", code: "forbidden" };
    kernelWrite.mockResolvedValue(denied);
    await expect(
      setRuntimeContainment("acme", "core-platform", "rtm_macslaptop", true),
    ).resolves.toEqual(denied);
  });

  it("returns a runtime that is gone as not_found (negative)", async () => {
    const gone = {
      ok: false,
      reason: "not_found",
      code: "runtime_not_found",
    };
    kernelWrite.mockResolvedValue(gone);
    await expect(
      setRuntimeContainment("acme", "core-platform", "rtm_gone", true),
    ).resolves.toEqual(gone);
  });
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
