import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      }),
    ),
  };
});

import { handler } from "./notification.mark";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

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
    await expect(
      handler({ id: "ntf_abc", read: true }, noUserCtx),
    ).rejects.toThrow("userId is required");
  });

  it("returns ok:true with no-op when neither read nor archived provided", async () => {
    const result = await handler({ id: "ntf_abc" }, ctx);
    expect(result).toEqual({ ok: true });
  });
});
