import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  selectRows: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: (values: unknown) => {
            mocks.values(values);
            return { onConflictDoUpdate: mocks.onConflictDoUpdate };
          },
        }),
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => mocks.selectRows() }),
          }),
        }),
      }),
  };
});

import { userPreferencesSetHandler } from "./user.preferences.set";
import { makeCTX } from "./test-utils/fixtures";

const CTX = makeCTX({ userId: "u_1" });

/** The whole row the handler reads back, as the columns come off Postgres. */
const ROW = {
  language: "pt-BR",
  theme: "dark",
  timezone: "America/Sao_Paulo",
  fontSize: "large",
  density: "compact",
  enterToSubmit: true,
  pendingPromptBehavior: "interrupt",
  defaultTextTier: "precise",
  defaultTextModel: "anthropic/claude-sonnet-4",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onConflictDoUpdate.mockResolvedValue([]);
  mocks.selectRows.mockResolvedValue([ROW]);
});

describe("set_preferences", () => {
  it("upserts only the fields sent and answers with the row read back", async () => {
    const out = await userPreferencesSetHandler({ theme: "dark" }, CTX);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1", theme: "dark", language: "en" }),
    );
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: { updatedByUserId: "u_1", theme: "dark" },
      }),
    );
    expect(out).toEqual({
      locale: "pt-BR",
      theme: "dark",
      timezone: "America/Sao_Paulo",
      fontSize: "large",
      density: "compact",
      enterToSubmit: true,
      pendingPromptBehavior: "interrupt",
      defaultTextTier: "precise",
      defaultTextModel: "anthropic/claude-sonnet-4",
    });
  });

  // ADR-075: the row has one writer, so every column it holds has to be
  // reachable from here. A first insert supplies the column default for each
  // field the caller left out, or the insert is invalid.
  it("writes every field the caller sends, and defaults the rest on first insert", async () => {
    await userPreferencesSetHandler(
      {
        locale: "fr",
        theme: "light",
        timezone: "Europe/Paris",
        fontSize: "small",
        density: "spacious",
        enterToSubmit: true,
        pendingPromptBehavior: "interrupt",
        defaultTextTier: "fast",
        defaultTextModel: "openai/gpt-5",
      },
      CTX,
    );
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: {
          updatedByUserId: "u_1",
          language: "fr",
          theme: "light",
          timezone: "Europe/Paris",
          fontSize: "small",
          density: "spacious",
          enterToSubmit: true,
          pendingPromptBehavior: "interrupt",
          defaultTextTier: "fast",
          defaultTextModel: "openai/gpt-5",
        },
      }),
    );
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        fontSize: "small",
        density: "spacious",
        enterToSubmit: true,
        pendingPromptBehavior: "interrupt",
      }),
    );
  });

  it("defaults every non-null column on a first insert that sends nothing", async () => {
    await userPreferencesSetHandler({}, CTX);
    expect(mocks.values).toHaveBeenCalledWith({
      userId: "u_1",
      createdByUserId: "u_1",
      updatedByUserId: "u_1",
      language: "en",
      theme: "system",
      timezone: "UTC",
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: false,
      pendingPromptBehavior: "queue",
    });
  });

  // null clears the pinned model, undefined leaves it. Collapsing the two
  // would make "go back to workspace routing" unexpressible.
  it("clears a pinned model on an explicit null and leaves it on an omission", async () => {
    await userPreferencesSetHandler(
      { defaultTextTier: null, defaultTextModel: null },
      CTX,
    );
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: {
          updatedByUserId: "u_1",
          defaultTextTier: null,
          defaultTextModel: null,
        },
      }),
    );
    vi.clearAllMocks();
    mocks.onConflictDoUpdate.mockResolvedValue([]);
    mocks.selectRows.mockResolvedValue([ROW]);
    await userPreferencesSetHandler({ theme: "light" }, CTX);
    const set = mocks.onConflictDoUpdate.mock.calls[0]?.[0]?.set as object;
    expect("defaultTextTier" in set).toBe(false);
    expect("defaultTextModel" in set).toBe(false);
  });

  it("an empty write changes nothing but the audit column (negative)", async () => {
    await userPreferencesSetHandler({}, CTX);
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { updatedByUserId: "u_1" } }),
    );
  });

  it("reads a stored theme outside the three choices as system", async () => {
    mocks.selectRows.mockResolvedValueOnce([
      { ...ROW, language: "en", theme: "sepia", timezone: "UTC" },
    ]);
    const out = await userPreferencesSetHandler({ locale: "en" }, CTX);
    expect(out.theme).toBe("system");
  });

  it("refuses a caller with no user as forbidden (negative)", async () => {
    await expect(
      userPreferencesSetHandler({ theme: "light" }, makeCTX({ userId: null })),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "forbidden");
    expect(mocks.values).not.toHaveBeenCalled();
  });
});
