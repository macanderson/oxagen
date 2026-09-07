import { describe, expect, it, vi } from "vitest";

// ── hoisted stubs ───────────────────────────────────────────────────────────
// withTenantDb must be mocked before the module under test is imported.
// We capture the mock factory so individual tests can configure the return values.
const mockWithTenantDb = vi.hoisted(() => vi.fn());

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});

// drizzle-orm eq is used as a comparator; mock it as an identity pass-through
// so the query objects built inside the function don't throw.

import { loadEffectiveModelDefaults } from "./load-effective-model-defaults";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTx(
  userPrefsRow: Record<string, unknown> | undefined,
  workspaceRow: Record<string, unknown> | undefined | null,
) {
  return {
    query: {
      userPreferences: {
        findFirst: vi.fn().mockResolvedValue(userPrefsRow),
      },
      workspaces: {
        findFirst: vi.fn().mockResolvedValue(workspaceRow),
      },
    },
  };
}

// withTenantDb(fn) calls fn with a tx and returns its result.
function setupWithTenantDb(
  userPrefsRow: Record<string, unknown> | undefined,
  workspaceRow: Record<string, unknown> | undefined | null,
) {
  const tx = makeTx(userPrefsRow, workspaceRow);
  mockWithTenantDb.mockImplementation(
    async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(tx),
  );
  return tx;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("loadEffectiveModelDefaults", () => {
  it("returns all-null defaults when user has no preferences and no workspace", async () => {
    setupWithTenantDb(undefined, null);
    const result = await loadEffectiveModelDefaults({
      userId: "user-1",
      workspaceId: null,
    });
    expect(result.text).toEqual({ tier: null, model: null });
    expect(result.overriddenByWorkspace).toEqual({ text: false });
  });

  it("resolves user preferences when workspace is null", async () => {
    setupWithTenantDb(
      {
        defaultTextTier: "fast",
        defaultTextModel: null,
      },
      null,
    );
    const result = await loadEffectiveModelDefaults({
      userId: "user-1",
      workspaceId: null,
    });
    expect(result.text).toEqual({ tier: "fast", model: null });
    expect(result.overriddenByWorkspace.text).toBe(false);
  });

  it("workspace preferences override user preferences", async () => {
    setupWithTenantDb(
      {
        defaultTextTier: "fast",
        defaultTextModel: "anthropic/claude-haiku-4.5",
      },
      {
        defaultTextTier: "precise",
        defaultTextModel: "anthropic/claude-opus-4.8",
      },
    );
    const result = await loadEffectiveModelDefaults({
      userId: "user-1",
      workspaceId: "ws-1",
    });
    expect(result.text).toEqual({
      tier: "precise",
      model: "anthropic/claude-opus-4.8",
    });
    expect(result.overriddenByWorkspace).toEqual({ text: true });
  });

  it("does not query workspaces when workspaceId is null", async () => {
    const tx = setupWithTenantDb(undefined, null);
    await loadEffectiveModelDefaults({ userId: "user-2", workspaceId: null });
    // The workspace query factory should never be called when workspaceId is null.
    expect(tx.query.workspaces.findFirst).not.toHaveBeenCalled();
  });

  // ADR-043: media generation is gone — neither query selects a media column.
  it("selects only the text model columns from both tables", async () => {
    const tx = setupWithTenantDb(
      { defaultTextTier: "fast", defaultTextModel: null },
      { defaultTextTier: null, defaultTextModel: null },
    );
    await loadEffectiveModelDefaults({ userId: "user-3", workspaceId: "ws-3" });

    for (const findFirst of [
      tx.query.userPreferences.findFirst,
      tx.query.workspaces.findFirst,
    ]) {
      const arg = findFirst.mock.calls[0]?.[0] as {
        columns: Record<string, boolean>;
      };
      expect(Object.keys(arg.columns).sort()).toEqual([
        "defaultTextModel",
        "defaultTextTier",
      ]);
    }
  });
});
