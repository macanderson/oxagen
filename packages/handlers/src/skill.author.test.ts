import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  invoke: vi.fn(),
  parseSkill: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@oxagen/skills", () => ({
  parseSkill: mocks.parseSkill,
}));

import { skillAuthorHandler } from "./skill.author";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const SYNTHESIS_RESULT = {
  name: "pr-review",
  description: "How to review pull requests for correctness, readability, and coverage.",
  weight: "high" as const,
  category: "engineering",
  body: "# PR Review\n\nLoad this skill when the user asks you to review a pull request.\n\n## Rules\n\n1. Check for correctness bugs first.\n2. Check for readability.\n3. Verify test coverage.",
};

const INSTALL_RESULT = {
  publicId: "skl_TEST01",
  slug: "pr-review",
  activeVersion: 1,
  installed: true,
};

const BASE_INPUT = {
  prompt: "Teach the agent how to review pull requests effectively",
  nameHint: "pr-review" as string | undefined,
  category: "engineering" as string | undefined,
  activate: true,
  workspace_id: undefined as string | undefined,
};

function setupHappyPath(overrides: Partial<typeof BASE_INPUT> = {}) {
  mocks.generateObjectFor.mockResolvedValue({ object: SYNTHESIS_RESULT });
  mocks.parseSkill.mockReturnValue({
    slug: "pr-review",
    name: "pr-review",
    description: SYNTHESIS_RESULT.description,
    metadata: { weight: "high", category: "engineering" },
    body: SYNTHESIS_RESULT.body,
    references: [],
    source: "tenant",
    version: "1.0.0",
  });
  mocks.invoke.mockResolvedValue(INSTALL_RESULT);
  return { ...BASE_INPUT, ...overrides };
}

describe("skillAuthorHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns publicId, slug, body, activeVersion, and installed on success", async () => {
    const input = setupHappyPath();
    const result = await skillAuthorHandler(input, TEST_CTX);

    expect(result.publicId).toBe("skl_TEST01");
    expect(result.slug).toBe("pr-review");
    expect(result.activeVersion).toBe(1);
    expect(result.installed).toBe(true);
    expect(result.body).toContain("---");
    expect(result.body).toContain("name: pr-review");
    expect(result.body).toContain("weight: high");
  });

  it("assembles valid .skill.md frontmatter in the body", async () => {
    const input = setupHappyPath();
    const result = await skillAuthorHandler(input, TEST_CTX);

    expect(result.body).toMatch(/^---\n/);
    expect(result.body).toContain("name: pr-review");
    expect(result.body).toContain("description:");
    expect(result.body).toContain("metadata:");
    expect(result.body).toContain("weight: high");
    expect(result.body).toContain("category: engineering");
    expect(result.body).toContain("---\n");
  });

  it("calls generateObjectFor with the prompt embedded", async () => {
    const input = setupHappyPath();
    await skillAuthorHandler(input, TEST_CTX);

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    const call = mocks.generateObjectFor.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain(input.prompt);
  });

  it("calls generateObjectFor with telemetry containing orgId + workspaceId", async () => {
    const input = setupHappyPath();
    await skillAuthorHandler(input, TEST_CTX);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { orgId: string; workspaceId: string };
    };
    expect(call.telemetry.orgId).toBe(TEST_CTX.orgId);
    expect(call.telemetry.workspaceId).toBe(TEST_CTX.workspaceId);
  });

  it("calls parseSkill to validate the assembled body before writing", async () => {
    const input = setupHappyPath();
    await skillAuthorHandler(input, TEST_CTX);

    expect(mocks.parseSkill).toHaveBeenCalledTimes(1);
    const [rawBody] = mocks.parseSkill.mock.calls[0] as [string];
    expect(rawBody).toContain("name: pr-review");
  });

  it("calls invoke('skill.workspace.install') with the assembled body", async () => {
    const input = setupHappyPath();
    await skillAuthorHandler(input, TEST_CTX);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [capName, invokeInput] = mocks.invoke.mock.calls[0] as [
      string,
      { custom: { name: string; body: string } },
    ];
    expect(capName).toBe("skill.workspace.install");
    expect(invokeInput.custom.name).toBe("pr-review");
    expect(invokeInput.custom.body).toContain("name: pr-review");
  });

  it("returns installed=false when the skill already existed (idempotent)", async () => {
    setupHappyPath();
    mocks.invoke.mockResolvedValue({ ...INSTALL_RESULT, installed: false });
    const input = { ...BASE_INPUT };
    const result = await skillAuthorHandler(input, TEST_CTX);

    expect(result.installed).toBe(false);
  });

  it("forwards workspace_id to invoke when provided", async () => {
    const input = setupHappyPath({ workspace_id: "ws_EXPLICIT" });
    await skillAuthorHandler(input, TEST_CTX);

    const [, invokeInput] = mocks.invoke.mock.calls[0] as [string, { workspace_id?: string }];
    expect(invokeInput.workspace_id).toBe("ws_EXPLICIT");
  });

  it("omits category from frontmatter when not provided by the model", async () => {
    setupHappyPath();
    mocks.generateObjectFor.mockResolvedValue({
      object: { ...SYNTHESIS_RESULT, category: undefined },
    });
    const input = { ...BASE_INPUT, category: undefined };
    const result = await skillAuthorHandler(input, TEST_CTX);

    expect(result.body).not.toContain("category:");
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("throws when workspaceId is missing from context", async () => {
    setupHappyPath();
    const noWsCtx = makeCTX({ workspaceId: undefined });

    await expect(
      skillAuthorHandler(BASE_INPUT, noWsCtx as unknown as typeof TEST_CTX),
    ).rejects.toThrow("workspaceId is required");
  });

  it("throws when generateObjectFor fails", async () => {
    const input = setupHappyPath();
    mocks.generateObjectFor.mockRejectedValue(new Error("model unavailable"));

    await expect(skillAuthorHandler(input, TEST_CTX)).rejects.toThrow(
      /model unavailable/,
    );
  });

  it("throws when parseSkill rejects the assembled body (invalid slug from model)", async () => {
    const input = setupHappyPath();
    // Model returns an uppercase name that would fail parseSkill
    mocks.generateObjectFor.mockResolvedValue({
      object: { ...SYNTHESIS_RESULT, name: "Bad_Slug" },
    });
    mocks.parseSkill.mockImplementation(() => {
      throw new Error("kebab-case-slug only");
    });

    await expect(skillAuthorHandler(input, TEST_CTX)).rejects.toThrow(/kebab-case/i);
    // invoke must NOT be called when parseSkill fails
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("throws when skill.workspace.install invoke fails", async () => {
    const input = setupHappyPath();
    mocks.invoke.mockRejectedValue(new Error("install failed"));

    await expect(skillAuthorHandler(input, TEST_CTX)).rejects.toThrow("install failed");
  });

  // ── telemetry ─────────────────────────────────────────────────────────────

  it("passes surface from context to generateObjectFor telemetry", async () => {
    const input = setupHappyPath();
    const mcpCtx = makeCTX({ surface: "mcp" });
    await skillAuthorHandler(input, mcpCtx);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { surface: string };
    };
    expect(call.telemetry.surface).toBe("mcp");
  });

  it("uses messageId from context in telemetry when available", async () => {
    const input = setupHappyPath();
    const ctxWithMsg = makeCTX({ messageId: "msg_XYZ" });
    await skillAuthorHandler(input, ctxWithMsg);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { messageId: string };
    };
    expect(call.telemetry.messageId).toBe("msg_XYZ");
  });

  it("falls back to requestId in telemetry when messageId is null", async () => {
    const input = setupHappyPath();
    const ctxNoMsg = makeCTX({ messageId: null, requestId: "req_FALLBACK" });
    await skillAuthorHandler(input, ctxNoMsg);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { messageId: string };
    };
    expect(call.telemetry.messageId).toBe("req_FALLBACK");
  });
});
