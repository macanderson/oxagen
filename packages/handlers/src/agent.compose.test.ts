import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock the AI layer — the planner + summarizer are the only non-deterministic
// parts. The executor runs against the REAL kernel + registered fake caps so
// output→input threading is genuinely exercised.
const generateObjectFor = vi.fn();
vi.mock("@oxagen/ai", () => ({
  generateObjectFor: (...a: unknown[]) => generateObjectFor(...a),
}));

import { clearRegistryForTests, registerCapability } from "@oxagen/oxagen";
import { clearHandlersForTests, registerHandler } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  agentComposeHandler,
  buildCatalog,
  isSafeToAutoExecute,
  readPath,
  resolveBindings,
  topoSort,
} from "./agent.compose";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u",
  apiKeyId: null,
  requestId: "req_compose",
  surface: "app",
  messageId: null,
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("readPath", () => {
  it("reads nested dot-paths and returns undefined off-path", () => {
    expect(readPath({ a: { b: "x" } }, "a.b")).toBe("x");
    expect(readPath({ a: null }, "a.b")).toBeUndefined();
  });
});

describe("resolveBindings", () => {
  const outputs = { step1: { nodeId: "n_1", meta: { score: 0.9 } } };
  it("resolves an exact-match token to the raw value (preserving type)", () => {
    expect(resolveBindings("$steps.step1.meta.score", outputs)).toBe(0.9);
    expect(resolveBindings("$steps.step1.nodeId", outputs)).toBe("n_1");
  });
  it("string-interpolates an embedded token", () => {
    expect(resolveBindings("node is $steps.step1.nodeId!", outputs)).toBe(
      "node is n_1!",
    );
  });
  it("recurses into objects and arrays", () => {
    expect(
      resolveBindings(
        { ref: "$steps.step1.nodeId", list: ["$steps.step1.nodeId"] },
        outputs,
      ),
    ).toEqual({ ref: "n_1", list: ["n_1"] });
  });
  it("leaves an unresolved token's exact-match string intact", () => {
    expect(resolveBindings("$steps.stepX.nope", outputs)).toBe(
      "$steps.stepX.nope",
    );
  });
});

describe("topoSort", () => {
  it("orders dependencies before dependents", () => {
    const order = topoSort([
      { id: "b", dependsOn: ["a"] },
      { id: "a", dependsOn: [] },
    ]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });
  it("throws on a cycle", () => {
    expect(() =>
      topoSort([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).toThrow(/cycle/i);
  });
});

describe("isSafeToAutoExecute", () => {
  it("blocks destructive and approval-required capabilities", () => {
    expect(isSafeToAutoExecute({ sensitivity: "low" })).toBe(true);
    expect(isSafeToAutoExecute({ sensitivity: "destructive" })).toBe(false);
    expect(
      isSafeToAutoExecute({
        sensitivity: "low",
        agent: { requiresApproval: true },
      }),
    ).toBe(false);
    expect(isSafeToAutoExecute(undefined)).toBe(false);
  });
});

// ── Executor / handler integration ────────────────────────────────────────────

function registerFakes(): void {
  // skill.workspace.list — required so readEnabledSkills (which no longer
  // swallows errors) has a real handler in tests. Returns an empty skill set
  // by default; individual tests can override the handler as needed.
  registerCapability({
    name: "list_workspace_skills",
    domain: "skill",
    description: "List skills available in the workspace",
    mode: "sync",
    surfaces: ["api", "mcp"],
    layers: ["schema"],
    scoped: true,
    sensitivity: "low",
    defaultEffect: "deny",
    defaultRoles: {
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
    },
    input: z.object({ workspace_id: z.string().optional() }),
    output: z.object({
      skills: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          enabled: z.boolean(),
        }),
      ),
    }),
  });
  registerHandler("list_workspace_skills", async () => async () => ({
    skills: [],
  }));

  // prompt.settings.read — required so readWorkspacePrompt has a handler.
  // Returns empty additional instructions by default.
  registerCapability({
    name: "get_prompt_settings",
    domain: "prompt",
    description: "Read workspace prompt settings",
    mode: "sync",
    surfaces: ["api", "mcp"],
    layers: ["schema"],
    scoped: true,
    sensitivity: "low",
    defaultEffect: "deny",
    defaultRoles: {
      org: {},
      workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
    },
    input: z.object({}),
    output: z.object({
      additionalInstructions: z.string().nullable().optional(),
    }),
  });
  registerHandler("get_prompt_settings", async () => async () => ({
    additionalInstructions: null,
  }));

  registerCapability({
    name: "test.compose.search",
    domain: "test",
    description: "search",
    mode: "sync",
    surfaces: ["agent"],
    layers: ["unit"],
    scoped: false,
    sensitivity: "low",
    defaultEffect: "allow",
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({ query: z.string() }),
    output: z.object({ nodeId: z.string(), title: z.string() }),
  });
  registerHandler("test.compose.search", async () => async () => ({
    nodeId: "n_1",
    title: "USS Nautilus",
  }));

  registerCapability({
    name: "test.compose.link",
    domain: "test",
    description: "link",
    mode: "sync",
    surfaces: ["agent"],
    layers: ["unit"],
    scoped: false,
    sensitivity: "low",
    defaultEffect: "allow",
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({ ref: z.string() }),
    output: z.object({ ok: z.boolean(), echoed: z.string() }),
  });
  registerHandler("test.compose.link", async () => async (input: unknown) => ({
    ok: true,
    echoed: (input as { ref: string }).ref,
  }));

  registerCapability({
    name: "test.compose.danger",
    domain: "test",
    description: "danger",
    mode: "sync",
    surfaces: ["agent"],
    layers: ["unit"],
    scoped: false,
    sensitivity: "destructive",
    defaultEffect: "allow",
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
  });
  registerHandler("test.compose.danger", async () => async () => ({
    done: true,
  }));
}

const PLAN = {
  object: {
    steps: [
      {
        id: "step1",
        capability: "test.compose.search",
        rationale: "search the web",
        inputJson: '{"query":"USS Nautilus"}',
        dependsOn: [],
      },
      {
        id: "step2",
        capability: "test.compose.link",
        rationale: "thread the node id forward",
        inputJson: '{"ref":"$steps.step1.nodeId"}',
        dependsOn: ["step1"],
      },
      {
        id: "step3",
        capability: "test.compose.danger",
        rationale: "would do something destructive",
        inputJson: "{}",
        dependsOn: [],
      },
    ],
  },
};
const SUMMARY = { object: { summary: "Found the node and linked it." } };

describe("agentComposeHandler", () => {
  beforeEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    generateObjectFor.mockReset();
    registerFakes();
  });
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
  });

  it("plans, executes, threads output→input, and skips destructive steps", async () => {
    generateObjectFor
      .mockResolvedValueOnce(PLAN)
      .mockResolvedValueOnce(SUMMARY);

    const result = await agentComposeHandler(
      { goal: "research", maxSteps: 6, autoExecute: true },
      ctx,
    );

    expect(result.executed).toBe(true);
    expect(result.summary).toBe("Found the node and linked it.");

    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
    // step1 ran and produced the node id
    expect(byId.step1?.status).toBe("success");
    expect((byId.step1?.output as { nodeId: string }).nodeId).toBe("n_1");
    // step2 consumed step1's nodeId via the $steps binding
    expect(byId.step2?.status).toBe("success");
    expect(byId.step2?.input).toEqual({ ref: "n_1" });
    expect((byId.step2?.output as { echoed: string }).echoed).toBe("n_1");
    // step3 was planned but skipped (destructive)
    expect(byId.step3?.status).toBe("skipped");
    expect(byId.step3?.error).toMatch(/destructive|approval/i);
  });

  it("returns all steps skipped on a dry run (autoExecute=false) without invoking them", async () => {
    generateObjectFor
      .mockResolvedValueOnce(PLAN)
      .mockResolvedValueOnce(SUMMARY);

    const result = await agentComposeHandler(
      { goal: "research", maxSteps: 6, autoExecute: false },
      ctx,
    );

    expect(result.executed).toBe(false);
    expect(result.steps.every((s) => s.status === "skipped")).toBe(true);
    expect(
      result.steps.every((s) => s.error === "Dry run — not executed."),
    ).toBe(true);
  });

  it("marks a step error when a dependency failed (binding unmet)", async () => {
    // step1 fails (input invalid for the contract → invoke throws), step2 should skip.
    const badPlan = {
      object: {
        steps: [
          {
            id: "step1",
            capability: "test.compose.search",
            rationale: "x",
            inputJson: "{}",
            dependsOn: [],
          },
          {
            id: "step2",
            capability: "test.compose.link",
            rationale: "y",
            inputJson: '{"ref":"$steps.step1.nodeId"}',
            dependsOn: ["step1"],
          },
        ],
      },
    };
    generateObjectFor
      .mockResolvedValueOnce(badPlan)
      .mockResolvedValueOnce(SUMMARY);

    const result = await agentComposeHandler(
      { goal: "g", maxSteps: 6, autoExecute: true },
      ctx,
    );
    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
    expect(byId.step1?.status).toBe("error"); // invalid_input from the kernel
    expect(byId.step2?.status).toBe("skipped"); // prerequisite did not succeed
  });

  it("buildCatalog excludes agent.compose itself and includes agent-surface caps", () => {
    const names = buildCatalog().map((c) => c.name);
    expect(names).not.toContain("run_capability_chain");
    expect(names).toContain("test.compose.search");
  });

  // ── readEnabledSkills error propagation ───────────────────────────────────
  // readEnabledSkills no longer swallows errors from invoke("skill.workspace.list").
  // A failure (e.g. IAM denial, DB timeout, handler not found) must propagate
  // to the agentComposeHandler caller so it surfaces as a real error rather
  // than silently degrading the planner prompt.

  it("propagates skill.workspace.list errors to the caller instead of silently degrading", async () => {
    // Rebuild the registry with the skills handler replaced by one that throws.
    // We must clear THEN re-register to avoid the double-registration guard.
    clearHandlersForTests();
    clearRegistryForTests();
    // Re-run registerFakes but swap in the throwing handler for skill.workspace.list
    // by registering everything fresh. We build the override set manually so we
    // never double-register.
    registerCapability({
      name: "list_workspace_skills",
      domain: "skill",
      description: "List skills",
      mode: "sync",
      surfaces: ["api", "mcp"],
      layers: ["schema"],
      scoped: true,
      sensitivity: "low",
      defaultEffect: "deny",
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({ workspace_id: z.string().optional() }),
      output: z.object({
        skills: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            enabled: z.boolean(),
          }),
        ),
      }),
    });
    registerHandler("list_workspace_skills", async () => async () => {
      throw new Error("skill listing DB timeout");
    });

    await expect(
      agentComposeHandler(
        { goal: "research", maxSteps: 6, autoExecute: true },
        ctx,
      ),
    ).rejects.toThrow("skill listing DB timeout");

    // generateObjectFor (planner) must NOT have been called — the error should
    // have propagated before planning begins.
    expect(generateObjectFor).not.toHaveBeenCalled();
  });

  it("propagates skill.workspace.list errors even when prompt.settings.read succeeds", async () => {
    clearHandlersForTests();
    clearRegistryForTests();
    // Register only the capabilities needed: prompt.settings.read (succeeds)
    // and skill.workspace.list (throws). No test-compose-* needed since we
    // expect failure before planning starts.
    registerCapability({
      name: "get_prompt_settings",
      domain: "prompt",
      description: "Read workspace prompt settings",
      mode: "sync",
      surfaces: ["api", "mcp"],
      layers: ["schema"],
      scoped: true,
      sensitivity: "low",
      defaultEffect: "deny",
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({}),
      output: z.object({
        additionalInstructions: z.string().nullable().optional(),
      }),
    });
    registerHandler("get_prompt_settings", async () => async () => ({
      additionalInstructions: null,
    }));

    registerCapability({
      name: "list_workspace_skills",
      domain: "skill",
      description: "List skills",
      mode: "sync",
      surfaces: ["api", "mcp"],
      layers: ["schema"],
      scoped: true,
      sensitivity: "low",
      defaultEffect: "deny",
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({ workspace_id: z.string().optional() }),
      output: z.object({
        skills: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            enabled: z.boolean(),
          }),
        ),
      }),
    });
    registerHandler("list_workspace_skills", async () => async () => {
      throw new Error("skills IAM denied");
    });

    await expect(
      agentComposeHandler(
        { goal: "test", maxSteps: 3, autoExecute: false },
        ctx,
      ),
    ).rejects.toThrow("skills IAM denied");
  });
});
