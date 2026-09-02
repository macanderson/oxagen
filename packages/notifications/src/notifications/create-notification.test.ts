import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @oxagen/database before importing the module under test.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const mockTx = {
    insert: (_table: unknown) => ({
      values: (_v: unknown) => ({
        returning: () =>
          Promise.resolve([
            {
              id: "uuid-1",
              publicId: "ntf_abc",
              createdAt: new Date("2026-01-01"),
            },
          ]),
      }),
    }),
  };
  return {
    ...real,
    withSystemDb: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
    ),
  };
});

import { createNotification } from "./create-notification";
import { withSystemDb } from "@oxagen/database";

describe("createNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a notification row and returns id/publicId/createdAt", async () => {
    const result = await createNotification({
      orgId: "org-1",
      userId: "user-1",
      kind: "security",
      title: "Reconnect GitHub",
      body: "The GitHub OAuth token expired.",
      deepLink: "/org/ws/settings/integrations/reauth/porg_123",
    });

    expect(withSystemDb).toHaveBeenCalledOnce();
    expect(result.id).toBe("uuid-1");
    expect(result.publicId).toBe("ntf_abc");
  });

  it("accepts optional workspaceId", async () => {
    const result = await createNotification({
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      kind: "system",
      title: "Test",
    });
    expect(result.id).toBe("uuid-1");
  });

  it("rejects an invalid kind at runtime with a thrown error", async () => {
    await expect(
      createNotification({
        orgId: "org-1",
        userId: "user-1",
        // @ts-expect-error intentional bad kind for runtime guard test
        kind: "invalid_kind",
        title: "Bad",
      }),
    ).rejects.toThrow("Invalid notification kind");
  });
});
