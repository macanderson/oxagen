import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({
          set: (values: unknown) => {
            mocks.set(values);
            return {
              where: (cond: unknown) => {
                mocks.where(cond);
                return { returning: mocks.returning };
              },
            };
          },
        }),
      }),
  };
});

import { userProfileUpdateHandler } from "./user.profile.update";
import { makeCTX } from "./test-utils/fixtures";

const CTX = makeCTX({ userId: "u_1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.returning.mockResolvedValue([
    { displayName: "Ada Lovelace", avatarUrl: null },
  ]);
});

describe("update_profile", () => {
  it("writes the acting principal's row and answers with what was persisted", async () => {
    const out = await userProfileUpdateHandler(
      { displayName: "Ada Lovelace", avatarUrl: null },
      CTX,
    );
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Ada Lovelace",
        avatarUrl: null,
        updatedById: "u_1",
      }),
    );
    expect(out).toEqual({ displayName: "Ada Lovelace", avatarUrl: null });
  });

  it("writes a provided avatar URL through unchanged", async () => {
    mocks.returning.mockResolvedValueOnce([
      { displayName: "Ada", avatarUrl: "https://example.com/a.png" },
    ]);
    const out = await userProfileUpdateHandler(
      { displayName: "Ada", avatarUrl: "https://example.com/a.png" },
      CTX,
    );
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: "https://example.com/a.png" }),
    );
    expect(out.avatarUrl).toBe("https://example.com/a.png");
  });

  // The privilege-escalation guard lives in the contract (no user-id field to
  // parse), but the handler must independently never read one even if a
  // caller smuggled it past validation — it always targets ctx.userId.
  it("never reads a target id from input — only ctx.userId scopes the write", async () => {
    await userProfileUpdateHandler(
      {
        displayName: "Ada",
        avatarUrl: null,
        // @ts-expect-error -- deliberately probing for an id the handler must ignore
        userId: "u_someone_else",
      },
      CTX,
    );
    // drizzle's `eq()` builds an object graph that is circular (column ->
    // table -> column) and not JSON-serializable, so inspect its query-chunk
    // values directly rather than stringifying it.
    const whereArg = mocks.where.mock.calls[0]?.[0] as {
      queryChunks?: unknown[];
    };
    const values = (whereArg.queryChunks ?? []).flatMap((chunk) =>
      chunk && typeof chunk === "object" && "value" in chunk
        ? [(chunk as { value: unknown }).value]
        : [],
    );
    expect(values).toContain("u_1");
    expect(values).not.toContain("u_someone_else");
  });

  it("refuses a caller with no principal as forbidden (negative)", async () => {
    await expect(
      userProfileUpdateHandler(
        { displayName: "Ada", avatarUrl: null },
        makeCTX({ userId: null }),
      ),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "forbidden");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("raises not_found when the row disappears mid-write (negative)", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await expect(
      userProfileUpdateHandler({ displayName: "Ada", avatarUrl: null }, CTX),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "not_found");
  });
});
