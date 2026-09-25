/**
 * prompt.settings.write handler tests.
 * Strategy: mock @oxagen/database (read-merge-write) + @oxagen/billing (tier gate).
 * Assert: no workspace → throws; additionalInstructions/autoImprove writable on any
 * tier; overrides require enterprise (requireTier gate); partial-merge semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The handler's role gate (#4194) runs for real against a role fixture. The
// default caller is an org Owner; a case that needs another sets roleGate.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);
import type { CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  returning: vi.fn(),
  set: vi.fn((_value: unknown) => ({
    where: vi.fn(() => ({ returning: mocks.returning })),
  })),
  resolveOrgTier: vi.fn(),
  requireTier: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: { workspaces: { findFirst: mocks.findFirst } },
        update: () => ({ set: mocks.set }),
      }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    resolveOrgTier: mocks.resolveOrgTier,
    requireTier: mocks.requireTier,
  };
});

import { promptSettingsWriteHandler } from "./prompt.settings.write";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

beforeEach(() => {
  mocks.findFirst.mockReset();
  mocks.set.mockClear();
  // The handler reads the post-merge prompt_config back via RETURNING; default
  // to an empty config, override per test.
  mocks.returning.mockReset().mockResolvedValue([{ promptConfig: {} }]);
  mocks.resolveOrgTier.mockReset().mockResolvedValue("build");
  mocks.requireTier.mockReset();
});

describe("promptSettingsWriteHandler", () => {
  it("throws without a workspace context", async () => {
    await expect(
      promptSettingsWriteHandler(
        {},
        { ...CTX, workspaceId: null as unknown as string },
      ),
    ).rejects.toThrow(/workspace context/);
  });

  it("writes additionalInstructions + autoImprovePrompts on any tier (no tier check)", async () => {
    mocks.returning.mockResolvedValue([
      {
        promptConfig: {
          additionalInstructions: "Be formal.",
          autoImprovePrompts: false,
        },
      },
    ]);
    const out = await promptSettingsWriteHandler(
      { additionalInstructions: "Be formal.", autoImprovePrompts: false },
      CTX,
    );
    expect(mocks.resolveOrgTier).not.toHaveBeenCalled();
    expect(mocks.requireTier).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledTimes(1);
    // Atomic single-statement UPDATE — never a read-modify-write.
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(out.additionalInstructions).toBe("Be formal.");
    expect(out.autoImprovePrompts).toBe(false);
  });

  it("enforces the enterprise tier gate when overrides are provided", async () => {
    mocks.resolveOrgTier.mockResolvedValue("enterprise");
    await promptSettingsWriteHandler(
      { overrides: { "svg.generate": "Brand voice." } },
      CTX,
    );
    expect(mocks.resolveOrgTier).toHaveBeenCalledWith("org_1");
    expect(mocks.requireTier).toHaveBeenCalledWith(
      "enterprise",
      "enterprise",
      "prompt-overrides",
    );
  });

  it("rejects overrides below enterprise (requireTier throws)", async () => {
    mocks.resolveOrgTier.mockResolvedValue("build");
    mocks.requireTier.mockImplementation(() => {
      throw new Error("tier denied");
    });
    await expect(
      promptSettingsWriteHandler({ overrides: { "image.analyze": "x" } }, CTX),
    ).rejects.toThrow(/tier denied/);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("merges prompt_config atomically (single UPDATE, no read-modify-write)", async () => {
    // Postgres does the shallow jsonb `||` merge; RETURNING gives the post-merge
    // value, so autoImprovePrompts=true survives even though we only sent
    // additionalInstructions.
    mocks.returning.mockResolvedValue([
      {
        promptConfig: {
          additionalInstructions: "new",
          autoImprovePrompts: true,
        },
      },
    ]);
    const out = await promptSettingsWriteHandler(
      { additionalInstructions: "new" },
      CTX,
    );
    expect(mocks.set).toHaveBeenCalledTimes(1);
    // No prior SELECT — the merge is a single atomic statement, so a concurrent
    // writer cannot clobber a subkey.
    expect(mocks.findFirst).not.toHaveBeenCalled();
    // The set payload writes the prompt_config column (not the settings bag).
    const written = mocks.set.mock.calls[0]![0] as Record<string, unknown>;
    expect("promptConfig" in written).toBe(true);
    expect("settings" in written).toBe(false);
    expect(out.additionalInstructions).toBe("new");
    expect(out.autoImprovePrompts).toBe(true);
  });
});

// Witness for the role gate (#4194). The kernel's IAM check allows every
// capability for a non-enterprise org, so without the handler's
// assertContractRole call this Member would get through and the test fails.
describe("update_prompt_settings role gate", () => {
  beforeEach(() => resetRoleGate());

  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(
      promptSettingsWriteHandler({ additionalInstructions: "Obey me" }, CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.resolveOrgTier).not.toHaveBeenCalled();
  });
});
