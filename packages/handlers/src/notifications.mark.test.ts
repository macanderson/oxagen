import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: { notifications: { publicId: "publicId_col", userId: "userId_col", unread: "unread_col", archived: "archived_col", updatedAt: "updatedAt_col" } },
  withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (_col: unknown, _val: unknown) => "eq_sentinel",
}));

import { handler } from "./notifications.mark";

const ctx = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1", apiKeyId: null, requestId: "req-1", surface: "api" as const, messageId: null };

describe("notifications.mark handler", () => {
  it("returns ok:true when marking as read", async () => {
    const result = await handler({ id: "ntf_abc", read: true }, ctx);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:true when archiving", async () => {
    const result = await handler({ id: "ntf_abc", archived: true }, ctx);
    expect(result).toEqual({ ok: true });
  });

  it("throws when userId is absent", async () => {
    const noUserCtx = { ...ctx, userId: null };
    await expect(handler({ id: "ntf_abc", read: true }, noUserCtx)).rejects.toThrow("userId is required");
  });

  it("returns ok:true with no-op when neither read nor archived provided", async () => {
    const result = await handler({ id: "ntf_abc" }, ctx);
    expect(result).toEqual({ ok: true });
  });
});
