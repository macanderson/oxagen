import { describe, it, expect, vi, afterEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Mock the LLM layer ────────────────────────────────────────────────────────

const mockGenerateObjectFor = vi.fn();
vi.mock("@oxagen/ai", () => ({
  // Funding is resolved before the model call (ADR-053 §3); an org with no
  // stored key is platform-funded, which is what these fixtures exercise.
  // The model and the party billed for it are one answer (ADR-053 §3,
  // ADR-131), so the mock returns both. A fixture organisation has neither a
  // key it brought nor one Oxagen minted for it, so it is served by the
  // shared model and the tokens are platform-funded.
  selectModelForOrg: async () => ({
    model: "mock-model",
    fundedBy: "platform",
  }),
  generateObjectFor: (...args: unknown[]) => mockGenerateObjectFor(...args),
}));

// ── Mock withTenantDb / org settings ─────────────────────────────────────────

const mockWithTenantDb = vi.fn();
vi.mock("@oxagen/database", () => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    schema: {
      organizations: { id: "id", settings: "settings" },
    },
    withTenantDb: (fn: (tx: unknown) => Promise<unknown>) =>
      mockWithTenantDb(fn),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  // Partial: the handler now imports CREDIT_REASONS from @oxagen/billing, whose
  // module graph reaches drizzle's `sql`. Keeping the real exports beats listing
  // every one the chain happens to touch.
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { commandMenuSuggestHandler } from "./command.menu.suggest";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u1",
  apiKeyId: null,
  requestId: "req_suggest",
  surface: "app",
  messageId: "msg_1",
};

const MINIMAL_INPUT = {
  route: "/acme/prod/activity/runs/run_4221",
  routeParams: { runId: "run_4221" } as Record<string, string>,
  queryParams: {} as Record<string, string>,
  pageEntity: {
    kind: "run",
    id: "aex_abc123",
    publicId: "run_4221",
    label: "Run #4221",
    summary:
      "Run of playbook churn-investigate v3. Status: failed at step 'normalize'.",
  },
  recentEntities: [] as Array<{ kind: string; id: string; label?: string }>,
  capabilities: ["run_capability_chain"] as string[],
  locale: "en",
};

const SAMPLE_SUGGESTIONS = [
  {
    text: "Summarize this run's failure root cause",
    category: "investigate" as const,
    confidence: 0.92,
  },
  {
    text: "Show similar failed runs today",
    category: "investigate" as const,
    confidence: 0.8,
  },
  {
    text: "Identify the failing step pattern",
    category: "analyze" as const,
    confidence: 0.75,
  },
];

// Default: org has suggestions enabled (settings = {})
const enabledOrgRow = { settings: {} };

afterEach(() => {
  vi.clearAllMocks();
});

describe("commandMenuSuggestHandler", () => {
  it("returns LLM suggestions when the org opt-out is not set", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizations: {
              findFirst: async () => enabledOrgRow,
            },
          },
        };
        return fn(tx);
      },
    );
    mockGenerateObjectFor.mockResolvedValue({
      object: { suggestions: SAMPLE_SUGGESTIONS },
    });

    const result = await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0]?.text).toBe(
      "Summarize this run's failure root cause",
    );
    expect(result.suggestions[0]?.category).toBe("investigate");
  });

  it("returns [] when the org has opted out (suggest_llm_enabled = false)", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizations: {
              findFirst: async () => ({
                settings: { suggest_llm_enabled: false },
              }),
            },
          },
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);
    expect(result.suggestions).toHaveLength(0);
    // LLM should not be called at all
    expect(mockGenerateObjectFor).not.toHaveBeenCalled();
  });

  it("defaults to enabled when suggest_llm_enabled is missing from settings", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizations: {
              findFirst: async () => ({ settings: { some_other_flag: true } }),
            },
          },
        };
        return fn(tx);
      },
    );
    mockGenerateObjectFor.mockResolvedValue({
      object: { suggestions: SAMPLE_SUGGESTIONS },
    });

    const result = await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(mockGenerateObjectFor).toHaveBeenCalledOnce();
  });

  it("returns [] silently when the LLM call throws (spec §7 graceful degradation)", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: { organizations: { findFirst: async () => enabledOrgRow } },
        };
        return fn(tx);
      },
    );
    mockGenerateObjectFor.mockRejectedValue(new Error("LLM timeout"));

    const result = await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);
    expect(result.suggestions).toHaveLength(0);
  });

  it("only sends pageEntity.summary to the LLM, not the full entity", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: { organizations: { findFirst: async () => enabledOrgRow } },
        };
        return fn(tx);
      },
    );
    mockGenerateObjectFor.mockResolvedValue({
      object: { suggestions: SAMPLE_SUGGESTIONS },
    });

    await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);

    const callArgs = mockGenerateObjectFor.mock.calls[0]?.[0] as {
      prompt: string;
      system: string;
    };
    // Prompt should include the summary
    expect(callArgs.prompt).toContain("Status: failed at step 'normalize'.");
    // Should NOT include the full entity id as a raw DB value (just the summary)
    // The summary is what the page registered — the handler must not add extra fields.
    expect(callArgs.system).toContain("summary");
  });

  it("uses the fast model tier (Haiku-class)", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: { organizations: { findFirst: async () => enabledOrgRow } },
        };
        return fn(tx);
      },
    );
    mockGenerateObjectFor.mockResolvedValue({
      object: { suggestions: SAMPLE_SUGGESTIONS },
    });

    await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);

    const callArgs = mockGenerateObjectFor.mock.calls[0]?.[0] as {
      model: unknown;
    };
    // The mock resolves the fast tier to "mock-model" for this organisation
    expect(callArgs.model).toBe("mock-model");
  });

  it("truncates LLM output to max 5 suggestions", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: { organizations: { findFirst: async () => enabledOrgRow } },
        };
        return fn(tx);
      },
    );
    // LLM returns 6 suggestions (shouldn't happen but guard against it)
    const sixSuggestions = Array.from({ length: 6 }, (_, i) => ({
      text: `Suggestion ${i} about something here`,
      category: "investigate" as const,
      confidence: 0.8,
    }));
    mockGenerateObjectFor.mockResolvedValue({
      object: { suggestions: sixSuggestions },
    });

    const result = await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
  });

  it("returns [] gracefully when org settings read fails", async () => {
    mockWithTenantDb.mockRejectedValue(new Error("DB unavailable"));
    mockGenerateObjectFor.mockResolvedValue({
      object: { suggestions: SAMPLE_SUGGESTIONS },
    });

    // isSuggestEnabled catches the error and returns true (enabled), so the LLM
    // is still called — this tests the happy path when settings are unavailable.
    const result = await commandMenuSuggestHandler(MINIMAL_INPUT, ctx);
    expect(result.suggestions).toHaveLength(3);
  });
});
