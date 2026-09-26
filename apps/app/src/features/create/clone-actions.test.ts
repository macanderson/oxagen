import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  kernelRead: vi.fn(),
  kernelWrite: vi.fn(),
}));
vi.mock("@/server/viewer", () => ({ requireViewer: calls.requireViewer }));
vi.mock("@/server/kernel", () => ({
  kernelRead: calls.kernelRead,
  kernelWrite: calls.kernelWrite,
  readToActionResult: (value: unknown) => value,
}));
import { configurationCloneGet } from "@oxagen/oxagen/contracts/configuration.clone.get";
import { configurationClonePropose } from "@oxagen/oxagen/contracts/configuration.clone.propose";
import { readCloneDraft, proposeClone } from "./clone-actions";
const ctx = { orgId: "org", workspaceId: "workspace", userId: "owner" };
const draft = {
  kind: "skill" as const,
  sourceId: "review",
  sourceDigest: `sha256:${"a".repeat(64)}`,
  slug: "review-cloned",
  name: "review-cloned",
  source: "edited text",
  files: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  calls.requireViewer.mockResolvedValue(ctx);
});
describe("clone actions", () => {
  it("resolves the viewer for both the draft read and create-only proposal", async () => {
    calls.kernelRead.mockResolvedValue({ ok: true, value: draft });
    calls.kernelWrite.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    expect(await readCloneDraft("acme", "core", "skill", "review")).toEqual({
      ok: true,
      value: draft,
    });
    expect(calls.kernelRead).toHaveBeenCalledWith(ctx, {
      contract: configurationCloneGet,
      input: { kind: "skill", sourceId: "review" },
      page: "steering",
    });
    expect(await proposeClone("acme", "core", draft)).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    expect(calls.kernelWrite).toHaveBeenCalledWith(
      ctx,
      configurationClonePropose,
      draft,
    );
    expect(calls.requireViewer).toHaveBeenCalledTimes(2);
  });
  it("does not dispatch a proposal without a viewer", async () => {
    calls.requireViewer.mockRejectedValue(new Error("no session"));
    await expect(proposeClone("acme", "core", draft)).rejects.toThrow(
      "no session",
    );
    expect(calls.kernelWrite).not.toHaveBeenCalled();
  });
});
