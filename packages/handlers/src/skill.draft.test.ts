import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

import { skillDraftHandler } from "./skill.draft";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const SYNTHESIS_RESULT = {
  displayName: "PR Review",
  name: "pr-review",
  description:
    "How to review pull requests for correctness, readability, and coverage.",
  weight: "high" as const,
  category: "engineering",
  body: "# PR Review\n\nLoad this skill when the user asks you to review a pull request.\n\n## Rules\n\n1. Check for correctness bugs first.\n2. Check for readability.\n3. Verify test coverage.",
};

const BASE_INPUT = {
  prompt: "Teach the agent how to review pull requests effectively",
  nameHint: "pr-review" as string | undefined,
  category: "engineering" as string | undefined,
};

function setupHappyPath(overrides: Partial<typeof BASE_INPUT> = {}) {
  mocks.generateObjectFor.mockResolvedValue({ object: SYNTHESIS_RESULT });
  return { ...BASE_INPUT, ...overrides };
}

describe("skillDraftHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns the structured draft with all form fields on success", async () => {
    const input = setupHappyPath();
    const result = await skillDraftHandler(input, TEST_CTX);

    expect(result.draft.displayName).toBe("PR Review");
    expect(result.draft.slug).toBe("pr-review");
    expect(result.draft.description).toBe(SYNTHESIS_RESULT.description);
    expect(result.draft.weight).toBe("high");
    expect(result.draft.category).toBe("engineering");
    expect(result.draft.body).toBe(SYNTHESIS_RESULT.body);
  });

  it("returns canonical TOML and its parsed artifact", async () => {
    const input = setupHappyPath();
    const result = await skillDraftHandler(input, TEST_CTX);

    expect(result.content).toMatch(/^schema_version = 1\n/);
    expect(result.content).toContain('name = "pr-review"');
    expect(result.content).toContain('weight = "high"');
    expect(result.artifact.name).toBe("pr-review");
    expect(result.artifact.instructions).toBe(SYNTHESIS_RESULT.body);
  });

  it("calls generateObjectFor with the prompt embedded", async () => {
    const input = setupHappyPath();
    await skillDraftHandler(input, TEST_CTX);

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      prompt: string;
    };
    expect(call.prompt).toContain(input.prompt);
  });

  it("forwards nameHint and category into the system prompt", async () => {
    const input = setupHappyPath({
      nameHint: "pr-review",
      category: "engineering",
    });
    await skillDraftHandler(input, TEST_CTX);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(call.system).toContain("pr-review");
    expect(call.system).toContain("engineering");
  });

  it("calls generateObjectFor with telemetry containing orgId + workspaceId", async () => {
    const input = setupHappyPath();
    await skillDraftHandler(input, TEST_CTX);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { orgId: string; workspaceId: string };
    };
    expect(call.telemetry.orgId).toBe(TEST_CTX.orgId);
    expect(call.telemetry.workspaceId).toBe(TEST_CTX.workspaceId);
  });

  it("omits category from the draft and metadata when the model returns none", async () => {
    setupHappyPath();
    mocks.generateObjectFor.mockResolvedValue({
      object: { ...SYNTHESIS_RESULT, category: undefined },
    });
    const input = { ...BASE_INPUT, category: undefined };
    const result = await skillDraftHandler(input, TEST_CTX);

    expect(result.draft.category).toBeUndefined();
    expect(result.content).not.toContain("category =");
  });

  it("trims the draft body", async () => {
    setupHappyPath();
    mocks.generateObjectFor.mockResolvedValue({
      object: { ...SYNTHESIS_RESULT, body: `\n\n${SYNTHESIS_RESULT.body}\n\n` },
    });
    const result = await skillDraftHandler(BASE_INPUT, TEST_CTX);

    expect(result.draft.body).toBe(SYNTHESIS_RESULT.body);
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("throws when workspaceId is missing from context", async () => {
    setupHappyPath();
    const noWsCtx = makeCTX({ workspaceId: undefined });

    await expect(
      skillDraftHandler(BASE_INPUT, noWsCtx as unknown as typeof TEST_CTX),
    ).rejects.toThrow("workspaceId is required");
  });

  it("throws when generateObjectFor fails", async () => {
    const input = setupHappyPath();
    mocks.generateObjectFor.mockRejectedValue(new Error("model unavailable"));

    await expect(skillDraftHandler(input, TEST_CTX)).rejects.toThrow(
      /model unavailable/,
    );
  });

  it("throws when artifact validation rejects the assembled document", async () => {
    const input = setupHappyPath();
    mocks.generateObjectFor.mockResolvedValue({
      object: { ...SYNTHESIS_RESULT, name: "Bad_Slug" },
    });
    await expect(skillDraftHandler(input, TEST_CTX)).rejects.toThrow(
      /kebab-case/i,
    );
  });

  // ── telemetry ─────────────────────────────────────────────────────────────

  it("passes surface from context to generateObjectFor telemetry", async () => {
    const input = setupHappyPath();
    const mcpCtx = makeCTX({ surface: "mcp" });
    await skillDraftHandler(input, mcpCtx);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { surface: string };
    };
    expect(call.telemetry.surface).toBe("mcp");
  });

  it("falls back to requestId in telemetry when messageId is null", async () => {
    const input = setupHappyPath();
    const ctxNoMsg = makeCTX({ messageId: null, requestId: "req_FALLBACK" });
    await skillDraftHandler(input, ctxNoMsg);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { messageId: string };
    };
    expect(call.telemetry.messageId).toBe("req_FALLBACK");
  });
});
