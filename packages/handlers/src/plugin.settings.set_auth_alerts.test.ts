import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mocks.withSystemDb,
  };
});

import { handler } from "./plugin.settings.set_auth_alerts";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

describe("plugin.settings.set_auth_alerts handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: DB update succeeds
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        }),
    );
  });

  it("returns ok:true", async () => {
    const result = await handler(
      { sendEmail: true, roles: ["Owner", "Admin"] },
      ctx,
    );
    expect(result).toEqual({ ok: true });
  });

  it("propagates DB error when withSystemDb rejects", async () => {
    mocks.withSystemDb.mockRejectedValueOnce(new Error("DB connection failed"));

    await expect(
      handler({ sendEmail: true, roles: ["Owner"] }, ctx),
    ).rejects.toThrow("DB connection failed");
  });

  it("propagates DB error when the update query throws", async () => {
    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          update: () => ({
            set: () => ({
              where: () => Promise.reject(new Error("constraint violation")),
            }),
          }),
        });
      },
    );

    await expect(handler({ sendEmail: false, roles: [] }, ctx)).rejects.toThrow(
      "constraint violation",
    );
  });
});
