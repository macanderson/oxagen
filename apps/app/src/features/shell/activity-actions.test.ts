import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  viewer: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  context: vi.fn(),
  pending: vi.fn(),
  mandates: vi.fn(),
}));
vi.mock("@/server/viewer", () => ({ requireViewer: fake.viewer }));
vi.mock("@/server/kernel", () => ({
  kernelRead: fake.read,
  kernelWrite: fake.write,
  readToActionResult: (read: unknown) => read,
}));
vi.mock("@/data/source", () => ({
  dataSource: () => ({
    shell: { context: fake.context },
    approvals: { pending: fake.pending },
    mandates: { list: fake.mandates },
  }),
}));
import {
  markShellNotification,
  readShellActivity,
  readShellNavCounts,
} from "./activity-actions";

const notification = (publicId: string) => ({
  publicId,
  id: publicId,
  title: publicId,
  body: null,
  kind: "system",
  event: null,
  deepLink: null,
  unread: true,
  archived: false,
  createdAt: "2026-09-23T00:00:00Z",
});
const ok = <T>(value: T) => ({ ok: true, value });

beforeEach(() => {
  vi.resetAllMocks();
  fake.viewer.mockImplementation(async (org: string, ws?: string) => ({
    org,
    ws: ws ?? null,
  }));
  fake.context.mockResolvedValue(
    ok({
      orgs: [],
      workspaces: [
        { name: "One", slug: "one" },
        { name: "Two", slug: "two" },
      ],
    }),
  );
  fake.pending.mockResolvedValue(ok({ items: [], more: false }));
  fake.mandates.mockResolvedValue(
    ok({ mandates: [], asOf: "2026-09-23T00:00:00Z", truncatedAt: null }),
  );
  fake.read.mockImplementation(
    async (
      ctx: { ws: string | null },
      call: { contract: { name: string } },
    ) => {
      if (call.contract.name === "list_notifications")
        return ok({
          notifications: [
            notification("shared"),
            ...(ctx.ws ? [notification(ctx.ws)] : []),
          ],
          unreadCount: ctx.ws ? 2 : 1,
        });
      if (call.contract.name === "get_nav_counts")
        return ok({ approvals: 0, proposals: null, incidents: null });
      return ok({ items: [], nextCursor: null });
    },
  );
  fake.write.mockResolvedValue(ok({ ok: true }));
});

describe("organization activity", () => {
  it("reads only the selected workspace count for idle navigation", async () => {
    await readShellNavCounts("org", "two");
    expect(fake.viewer).toHaveBeenCalledWith("org", "two");
    expect(fake.read).toHaveBeenCalledOnce();
    expect(fake.read).toHaveBeenCalledWith(
      { org: "org", ws: "two" },
      expect.objectContaining({
        contract: expect.objectContaining({ name: "get_nav_counts" }),
      }),
    );
    expect(fake.context).not.toHaveBeenCalled();
    expect(fake.pending).not.toHaveBeenCalled();
    expect(fake.mandates).not.toHaveBeenCalled();
  });
  it("keeps the verified workspace on each notification and deduplicates shared rows", async () => {
    const result = await readShellActivity("org", "one");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.notifications.items.map((n) => [
        n.notification.publicId,
        n.ws,
      ]),
    ).toEqual([
      ["shared", null],
      ["one", "one"],
      ["two", "two"],
    ]);
    expect(fake.viewer.mock.calls).toEqual([
      ["org"],
      ["org", "one"],
      ["org", "two"],
    ]);
  });

  it("does not present a refused workspace read as an empty notification inbox", async () => {
    fake.read.mockImplementation(async () => ({
      ok: false,
      reason: "denied",
      permission: "notification.read",
    }));
    const result = await readShellActivity("org", "one");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notifications.partial).toBe(true);
    expect(result.value.notifications.failures).toHaveLength(3);
  });

  it("rechecks workspace access before attempting a notification mutation", async () => {
    fake.viewer.mockRejectedValue(new Error("membership_removed"));
    await expect(
      markShellNotification("org", "one", "ntf_1", false),
    ).rejects.toThrow("membership_removed");
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("carries the scoped mutation refusal back to the drawer", async () => {
    fake.write.mockResolvedValue(ok({ ok: false }));
    expect(await markShellNotification("org", "two", "ntf_1", true)).toEqual(
      ok({ ok: false }),
    );
    expect(fake.write).toHaveBeenCalledWith(
      { org: "org", ws: "two" },
      expect.objectContaining({ name: "mark_notification" }),
      { id: "ntf_1", read: true, archived: true },
    );
  });
});
