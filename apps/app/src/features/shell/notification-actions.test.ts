// The bell's write: every listed row through `mark_notification` on the viewer
// the URL resolves, the ids and nothing that names a tenant, and the first
// refusal returned as it is.
import { notificationsMark } from "@oxagen/oxagen/contracts/notification.mark";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelWrite, requireViewer } = vi.hoisted(() => ({
  kernelWrite: vi.fn(),
  requireViewer: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelWrite }));
vi.mock("@/server/viewer", () => ({ requireViewer }));

const { markNotificationsRead } = await import("./notification-actions");

const ctx = { orgSlug: "acme", wsSlug: "core-platform" };

beforeEach(() => {
  kernelWrite.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("markNotificationsRead", () => {
  it("marks each row read on the viewer the URL resolves", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { ok: true } });
    expect(
      await markNotificationsRead("acme", "core-platform", [
        "ntf_01K5",
        "ntf_02K5",
      ]),
    ).toEqual({ ok: true, value: { marked: 2 } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenNthCalledWith(1, ctx, notificationsMark, {
      id: "ntf_01K5",
      read: true,
    });
    expect(kernelWrite).toHaveBeenNthCalledWith(2, ctx, notificationsMark, {
      id: "ntf_02K5",
      read: true,
    });
  });

  it("counts only the rows the handler matched", async () => {
    kernelWrite
      .mockResolvedValueOnce({ ok: true, value: { ok: true } })
      .mockResolvedValueOnce({ ok: true, value: { ok: false } });
    expect(
      await markNotificationsRead("acme", "core-platform", ["a_1", "b_2"]),
    ).toEqual({ ok: true, value: { marked: 1 } });
  });

  it("returns the first refusal and stops (negative)", async () => {
    const denied = { ok: false, reason: "denied", code: "mark_notification" };
    kernelWrite.mockResolvedValueOnce(denied);
    expect(
      await markNotificationsRead("acme", "core-platform", ["a_1", "b_2"]),
    ).toEqual(denied);
    expect(kernelWrite).toHaveBeenCalledOnce();
  });

  it("does nothing for no rows, and refuses more than the dialog lists (negative)", async () => {
    expect(await markNotificationsRead("acme", "core-platform", [])).toEqual({
      ok: true,
      value: { marked: 0 },
    });
    expect(
      await markNotificationsRead(
        "acme",
        "core-platform",
        Array.from({ length: 51 }, (_, i) => `ntf_${String(i)}`),
      ),
    ).toEqual({ ok: false, reason: "invalid", code: "too_many", field: "ids" });
    expect(requireViewer).not.toHaveBeenCalled();
    expect(kernelWrite).not.toHaveBeenCalled();
  });
});
