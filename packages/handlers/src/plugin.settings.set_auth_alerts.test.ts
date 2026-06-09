import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  ),

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
  it("returns ok:true", async () => {
    const result = await handler({ sendEmail: true, roles: ["Owner", "Admin"] }, ctx);
    expect(result).toEqual({ ok: true });
  });
});
