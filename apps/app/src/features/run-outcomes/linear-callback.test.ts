import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  viewer: vi.fn(),
  write: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.get, set: mocks.set }),
}));
vi.mock("@/server/viewer", () => ({ requireViewer: mocks.viewer }));
vi.mock("@/server/kernel", () => ({ kernelWrite: mocks.write }));
vi.mock("@/shared/navigation", () => ({ responseRedirect: mocks.redirect }));
import { handleLinearCallback } from "./linear-callback";
const state = "a".repeat(43);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({
    value: JSON.stringify({ org: "acme", ws: "core", runId: "run_1", state }),
  });
  mocks.viewer.mockResolvedValue({ orgId: "verified-org" });
  mocks.write.mockResolvedValue({
    ok: true,
    value: { connectionId: "con_new" },
  });
  mocks.redirect.mockReturnValue(new Response(null, { status: 307 }));
});
describe("Linear browser callback", () => {
  it("refuses a mismatched browser state before invoking the kernel", async () => {
    expect(
      (
        await handleLinearCallback(
          new Request(
            "https://app.oxagen.sh/api/run-outcomes/linear/callback?state=other&code=code",
          ),
        )
      ).status,
    ).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("requires the signed-in workspace viewer and consumes the scoped callback cookie", async () => {
    await handleLinearCallback(
      new Request(
        `https://app.oxagen.sh/api/run-outcomes/linear/callback?state=${state}&code=code`,
      ),
    );
    expect(mocks.viewer).toHaveBeenCalledWith("acme", "core");
    expect(mocks.write).toHaveBeenCalledWith(
      { orgId: "verified-org" },
      expect.objectContaining({ name: "authorize_issue_provider" }),
      { state, code: "code" },
    );
    expect(mocks.set).toHaveBeenCalledWith(
      "oxagen_run_linear",
      "",
      expect.objectContaining({
        maxAge: 0,
        path: "/api/run-outcomes/linear/callback",
      }),
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      expect.any(Request),
      "/acme/core/runs/run_1",
    );
  });
  it("does not report success when the policy or role has been revoked", async () => {
    mocks.write.mockResolvedValue({ ok: false, reason: "denied" });
    expect(
      (
        await handleLinearCallback(
          new Request(
            `https://app.oxagen.sh/api/run-outcomes/linear/callback?state=${state}&code=code`,
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
