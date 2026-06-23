/**
 * actions.test.ts — unit tests for createOrgAction.
 *
 * Covers:
 *   (a) Happy path — valid FormData, org + workspace created, free credits granted.
 *   (b) FormData validation — missing/invalid required fields (name, slug).
 *   (c) Capability contract validation — orgInput fails (e.g. invalid slug chars).
 *   (d) Slug conflict (23505) — friendly error returned.
 *   (e) Generic DB error — message surfaced.
 *   (f) grantFreeCredits failure — swallowed, org still created.
 *   (g) resolveOrgAvatarUrl logic — owned blob URL kept, arbitrary URL dropped.
 *   (h) Seed wiring — three *System seeders called with correct args on success.
 *   (i) Seed failure — seeder throw does NOT reject the action (fire-and-log).
 *
 * Mock seam: @/lib/session, @oxagen/database, @oxagen/billing, @oxagen/storage,
 *            @oxagen/handlers/iam-provision, @oxagen/handlers/workspace-agents,
 *            @oxagen/handlers/workspace-registry-seed,
 *            @oxagen/handlers/workspace-capability-seed,
 *            @oxagen/handlers/skill-workspace-seed,
 *            @oxagen/oxagen/contracts/*.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockGetSessionOrRedirect,
  mockWithSystemDb,
  mockGrantFreeCredits,
  mockIngestImageFromUrl,
  mockIsIngestibleImageUrl,
  mockBootstrapOrgIAM,
  mockBootstrapWorkspaceAgents,
  mockSeedRegistry,
  mockSeedCapabilities,
  mockSeedSkills,
  mockOrgCreateParse,
  mockWsCreateParse,
} = vi.hoisted(() => ({
  mockGetSessionOrRedirect: vi.fn(),
  mockWithSystemDb: vi.fn(),
  mockGrantFreeCredits: vi.fn(),
  mockIngestImageFromUrl: vi.fn(),
  mockIsIngestibleImageUrl: vi.fn(),
  mockBootstrapOrgIAM: vi.fn(),
  mockBootstrapWorkspaceAgents: vi.fn(),
  mockSeedRegistry: vi.fn(),
  mockSeedCapabilities: vi.fn(),
  mockSeedSkills: vi.fn(),
  mockOrgCreateParse: vi.fn(),
  mockWsCreateParse: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withSystemDb: mockWithSystemDb,

  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    grantFreeCredits: mockGrantFreeCredits,
  };
});

vi.mock("@oxagen/storage", () => ({
  ingestImageFromUrl: mockIngestImageFromUrl,
  isIngestibleImageUrl: mockIsIngestibleImageUrl,
}));

vi.mock("@oxagen/handlers/iam-provision", () => ({
  bootstrapOrgIAM: mockBootstrapOrgIAM,
}));

// Silence logger output in tests (seed-failure branches call logger.error).
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/handlers/workspace-agents", () => ({
  bootstrapWorkspaceAgents: mockBootstrapWorkspaceAgents,
}));
vi.mock("@oxagen/handlers/workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistrySystem: mockSeedRegistry,
}));
vi.mock("@oxagen/handlers/workspace-capability-seed", () => ({
  seedWorkspaceDefaultCapabilitiesSystem: mockSeedCapabilities,
}));
vi.mock("@oxagen/handlers/skill-workspace-seed", () => ({
  seedWorkspaceDefaultSkillsSystem: mockSeedSkills,
}));

// We need to mock the contracts so we can control safeParse.
// The actual z.object schemas are statically defined — to avoid re-implementing
// them, we mock the module and delegate to the real zod check via a wrapper.
vi.mock("@oxagen/oxagen/contracts/organization.create", async () => {
  const { z } = await import("zod");
  const realSchema = z.object({
    name: z.string().min(1),
    slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
    type: z.enum(["personal", "business"]).default("business"),
    website: z.string().optional(),
    industry: z.string().optional(),
    employeeSize: z.string().optional(),
    billingEmail: z.string().optional(),
    billingAddress: z
      .object({
        line1: z.string(),
        line2: z.string().optional(),
        city: z.string(),
        region: z.string().optional(),
        postalCode: z.string(),
        country: z.string(),
        placeId: z.string().optional(),
      })
      .optional(),
    planSlug: z.string().optional(),
  });
  return {
    organizationCreate: {
      input: {
        safeParse: (data: unknown) => {
          const result = mockOrgCreateParse(data);
          if (result !== null) return result;
          // Fall through to real schema when mock returns null
          return realSchema.safeParse(data);
        },
      },
    },
  };
});

vi.mock("@oxagen/oxagen/contracts/workspace.create", async () => {
  const { z } = await import("zod");
  const realSchema = z.object({
    name: z.string().min(1),
    slug: z.string().min(2).max(40),
  });
  return {
    workspaceCreate: {
      input: {
        safeParse: (data: unknown) => {
          const result = mockWsCreateParse(data);
          if (result !== null) return result;
          return realSchema.safeParse(data);
        },
      },
    },
  };
});

import { createOrgAction } from "./actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSession = { user: { id: "user-abc", email: "user@example.com", name: "Alice" } };

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("name", overrides.name ?? "Acme Inc");
  fd.set("slug", overrides.slug ?? "acme-inc");
  fd.set("type", overrides.type ?? "business");
  // Optional fields always present (may be empty string)
  for (const key of ["website", "industry", "employeeSize", "billingEmail", "avatarUrl",
    "addressLine1", "addressLine2", "addressCity", "addressRegion",
    "addressPostalCode", "addressCountry", "addressPlaceId"]) {
    fd.set(key, overrides[key] ?? "");
  }
  return fd;
}

function makeSuccessfulDb(orgId = "org-123", orgSlug = "acme-inc", workspaceSlug = "default") {
  return {
    insert: (table: unknown) => ({
      values: (_data: unknown) => ({
        returning: () => {
          const name = getTableName(table as Parameters<typeof getTableName>[0]);
          if (name === "organizations") {
            return Promise.resolve([{ id: orgId, slug: orgSlug }]);
          }
          if (name === "workspaces") {
            return Promise.resolve([{ id: "ws-456", slug: workspaceSlug }]);
          }
          return Promise.resolve([{ id: "row-misc" }]);
        },
      }),
    }),
  };
}

// The action now returns { orgId, orgSlug, workspaceId, workspaceSlug } from the
// withSystemDb callback. mockWithSystemDb must resolve to that shape so the
// post-tx seed calls have a workspaceId to work with.
function wrapWithSuccessfulDb(fn: (tx: unknown) => Promise<unknown>) {
  const tx = makeSuccessfulDb();
  return fn(tx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOrgAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionOrRedirect.mockResolvedValue(mockSession);
    mockGrantFreeCredits.mockResolvedValue(undefined);
    mockIsIngestibleImageUrl.mockReturnValue(false);
    mockIngestImageFromUrl.mockResolvedValue(null);
    mockBootstrapOrgIAM.mockResolvedValue(undefined);
    mockBootstrapWorkspaceAgents.mockResolvedValue(undefined);
    mockSeedRegistry.mockResolvedValue("mreg_onboarding_123");
    mockSeedCapabilities.mockResolvedValue(undefined);
    mockSeedSkills.mockResolvedValue({ scanned: 3, inserted: 3 });
    // By default, let mocks return null so real schema runs
    mockOrgCreateParse.mockReturnValue(null);
    mockWsCreateParse.mockReturnValue(null);
    // Default: DB succeeds
    mockWithSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      return wrapWithSuccessfulDb(fn as (tx: unknown) => Promise<unknown>);
    });
  });

  // ---------------------------------------------------------------------------
  // (a) Happy path
  // ---------------------------------------------------------------------------

  it("returns ok:true with orgSlug and workspaceSlug on valid input", async () => {
    const result = await createOrgAction(makeFormData());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orgSlug).toBe("acme-inc");
      expect(result.workspaceSlug).toBe("default");
    }
  });

  it("calls withSystemDb once for the transaction", async () => {
    await createOrgAction(makeFormData());
    expect(mockWithSystemDb).toHaveBeenCalledOnce();
  });

  it("calls grantFreeCredits after a successful org creation", async () => {
    await createOrgAction(makeFormData());
    expect(mockGrantFreeCredits).toHaveBeenCalledOnce();
    expect(mockGrantFreeCredits).toHaveBeenCalledWith("org-123");
  });

  it("works with type=personal (no business fields required)", async () => {
    const result = await createOrgAction(makeFormData({ type: "personal" }));
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (b) FormData validation
  // ---------------------------------------------------------------------------

  it("returns ok:false when name is empty", async () => {
    const result = await createOrgAction(makeFormData({ name: "" }));
    expect(result.ok).toBe(false);
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });

  it("returns ok:false when slug is shorter than 2 chars", async () => {
    const result = await createOrgAction(makeFormData({ slug: "a" }));
    expect(result.ok).toBe(false);
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });

  it("returns ok:false when slug has invalid characters (uppercase)", async () => {
    const result = await createOrgAction(makeFormData({ slug: "Acme-Inc" }));
    expect(result.ok).toBe(false);
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });

  it("returns ok:false when type is not personal or business", async () => {
    const result = await createOrgAction(makeFormData({ type: "enterprise" }));
    expect(result.ok).toBe(false);
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (d) Slug conflict (23505)
  // ---------------------------------------------------------------------------

  it("returns ok:false with friendly message on slug conflict (23505)", async () => {
    mockWithSystemDb.mockRejectedValue({ code: "23505" });

    const result = await createOrgAction(makeFormData({ slug: "taken-slug" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/already taken/i);
    }
  });

  // ---------------------------------------------------------------------------
  // (e) Generic DB error
  // ---------------------------------------------------------------------------

  it("returns ok:false with a generic message on a generic DB error (no raw error leak)", async () => {
    mockWithSystemDb.mockRejectedValue(new Error("disk full"));

    const result = await createOrgAction(makeFormData());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Raw driver/SQL error text must NEVER reach the user (information leak).
      expect(result.error).toBe("Failed to create organization. Please try again.");
      expect(result.error).not.toContain("disk full");
    }
  });

  // ---------------------------------------------------------------------------
  // (f) grantFreeCredits failure — swallowed
  // ---------------------------------------------------------------------------

  it("still returns ok:true when grantFreeCredits throws (non-fatal)", async () => {
    mockGrantFreeCredits.mockRejectedValue(new Error("billing service down"));

    const result = await createOrgAction(makeFormData());

    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (g) resolveOrgAvatarUrl — owned blob URL kept, arbitrary URL dropped
  // ---------------------------------------------------------------------------

  it("keeps an owned blob URL without re-ingesting it", async () => {
    const blobUrl = "https://abc.public.blob.vercel-storage.com/avatar.png";
    await createOrgAction(makeFormData({ avatarUrl: blobUrl }));

    // isIngestibleImageUrl should NOT be called for owned blob URLs
    expect(mockIsIngestibleImageUrl).not.toHaveBeenCalled();
    expect(mockIngestImageFromUrl).not.toHaveBeenCalled();
  });

  it("ingests a trusted OAuth image URL via ingestImageFromUrl", async () => {
    const oauthUrl = "https://lh3.googleusercontent.com/photo.jpg";
    mockIsIngestibleImageUrl.mockReturnValue(true);
    mockIngestImageFromUrl.mockResolvedValue({ url: "https://abc.public.blob.vercel-storage.com/ingested.jpg" });

    await createOrgAction(makeFormData({ avatarUrl: oauthUrl }));

    expect(mockIngestImageFromUrl).toHaveBeenCalledOnce();
    expect(mockIngestImageFromUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: oauthUrl, kind: "avatar" }),
    );
  });

  it("drops an arbitrary user-supplied URL that is not ingestible", async () => {
    const arbitraryUrl = "https://shady-cdn.com/avatar.jpg";
    mockIsIngestibleImageUrl.mockReturnValue(false);

    await createOrgAction(makeFormData({ avatarUrl: arbitraryUrl }));

    expect(mockIngestImageFromUrl).not.toHaveBeenCalled();
  });

  it("handles empty avatarUrl (no URL processing attempted)", async () => {
    // Empty string is allowed by FormSchema (literal("")); resolveOrgAvatarUrl
    // returns null immediately for empty/falsy URLs.
    mockIsIngestibleImageUrl.mockReturnValue(false);

    const result = await createOrgAction(makeFormData({ avatarUrl: "" }));

    expect(result.ok).toBe(true);
    expect(mockIsIngestibleImageUrl).not.toHaveBeenCalled();
    expect(mockIngestImageFromUrl).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Billing address / billingProfile insert
  // ---------------------------------------------------------------------------

  it("inserts billing profile when billing email is provided", async () => {
    let billingInsertCalled = false;
    mockWithSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: (table: unknown) => ({
          values: (_data: unknown) => {
            const name = getTableName(table as Parameters<typeof getTableName>[0]);
            if (name === "org_billing_profiles") {
              billingInsertCalled = true;
            }
            return {
              returning: () => {
                if (name === "organizations") return Promise.resolve([{ id: "org-123", slug: "acme-inc" }]);
                if (name === "workspaces") return Promise.resolve([{ id: "ws-456", slug: "default" }]);
                return Promise.resolve([{ id: "row-misc" }]);
              },
            };
          },
        }),
      };
      return fn(tx);
    });

    const result = await createOrgAction(
      makeFormData({ billingEmail: "billing@acme.com" }),
    );

    expect(result.ok).toBe(true);
    expect(billingInsertCalled).toBe(true);
  });

  it("inserts billing profile with full address when all address fields present", async () => {
    let billingInsertCalled = false;
    mockWithSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: (table: unknown) => ({
          values: (_data: unknown) => {
            const name = getTableName(table as Parameters<typeof getTableName>[0]);
            if (name === "org_billing_profiles") billingInsertCalled = true;
            return {
              returning: () => {
                if (name === "organizations") return Promise.resolve([{ id: "org-123", slug: "acme-inc" }]);
                if (name === "workspaces") return Promise.resolve([{ id: "ws-456", slug: "default" }]);
                return Promise.resolve([{ id: "row-misc" }]);
              },
            };
          },
        }),
      };
      return fn(tx);
    });

    const result = await createOrgAction(
      makeFormData({
        addressLine1: "123 Main St",
        addressCity: "Springfield",
        addressPostalCode: "12345",
        addressCountry: "US",
        addressRegion: "il",
      }),
    );

    expect(result.ok).toBe(true);
    expect(billingInsertCalled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (h) Seed wiring
  // ---------------------------------------------------------------------------

  it("calls all three *System seeders with correct orgId and workspaceId on success", async () => {
    const result = await createOrgAction(makeFormData());
    expect(result.ok).toBe(true);

    expect(mockSeedRegistry).toHaveBeenCalledOnce();
    expect(mockSeedRegistry).toHaveBeenCalledWith({ orgId: "org-123", workspaceId: "ws-456" });

    expect(mockSeedCapabilities).toHaveBeenCalledOnce();
    expect(mockSeedCapabilities).toHaveBeenCalledWith({ orgId: "org-123", workspaceId: "ws-456" });

    expect(mockSeedSkills).toHaveBeenCalledOnce();
    expect(mockSeedSkills).toHaveBeenCalledWith({ orgId: "org-123", workspaceId: "ws-456" });
  });

  it("calls bootstrapWorkspaceAgents inside the tx with correct args on success", async () => {
    const result = await createOrgAction(makeFormData());
    expect(result.ok).toBe(true);

    expect(mockBootstrapWorkspaceAgents).toHaveBeenCalledOnce();
    expect(mockBootstrapWorkspaceAgents).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-456", orgId: "org-123" }),
    );
  });

  // ---------------------------------------------------------------------------
  // (i) Seed failure — fire-and-log, must not reject the action
  // ---------------------------------------------------------------------------

  it("seed failure in seedWorkspaceDefaultRegistrySystem does NOT reject the action", async () => {
    mockSeedRegistry.mockRejectedValue(new Error("registry seed failed"));
    const result = await createOrgAction(makeFormData());
    expect(result.ok).toBe(true);
  });

  it("seed failure in seedWorkspaceDefaultCapabilitiesSystem does NOT reject the action", async () => {
    mockSeedCapabilities.mockRejectedValue(new Error("capabilities seed failed"));
    const result = await createOrgAction(makeFormData());
    expect(result.ok).toBe(true);
  });

  it("seed failure in seedWorkspaceDefaultSkillsSystem does NOT reject the action", async () => {
    mockSeedSkills.mockRejectedValue(new Error("skills seed failed"));
    const result = await createOrgAction(makeFormData());
    expect(result.ok).toBe(true);
  });

  it("seeders are NOT called when the action returns ok:false (validation failure)", async () => {
    const result = await createOrgAction(makeFormData({ name: "" }));
    expect(result.ok).toBe(false);
    expect(mockSeedRegistry).not.toHaveBeenCalled();
    expect(mockSeedCapabilities).not.toHaveBeenCalled();
    expect(mockSeedSkills).not.toHaveBeenCalled();
  });

  it("seeders are NOT called when the tx fails (DB error)", async () => {
    mockWithSystemDb.mockRejectedValue(new Error("disk full"));
    const result = await createOrgAction(makeFormData());
    expect(result.ok).toBe(false);
    expect(mockSeedRegistry).not.toHaveBeenCalled();
    expect(mockSeedCapabilities).not.toHaveBeenCalled();
    expect(mockSeedSkills).not.toHaveBeenCalled();
  });
});
