/**
 * Task planner — proves a goal decomposes into a valid plan: unique task ids,
 * dependencies pruned to real tasks, and each task's tier reconciled UP with the
 * cost router so a high-stakes task is never under-spent. The model call and the
 * prompt enhancer are mocked, so no gateway or filesystem is touched.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { tmpdir } from "node:os";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));
vi.mock("../prompt-enhancer.js", () => ({
  enhancePrompt: async ({ prompt }: { prompt: string }) => ({
    prompt,
    context: "",
    resolved: [],
    lessons: [],
  }),
}));

import { generateObject } from "ai";
import { planTasks } from "../planner.js";
import { MissingAiKeyError } from "../env.js";
import { uninstallDirectAnthropicProviderForTests } from "../anthropic-direct.js";

const mockGen = generateObject as unknown as Mock;

interface RawTask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  files: string[];
  tier: "fast" | "balanced" | "precise";
}

function resolveWith(tasks: RawTask[]): void {
  mockGen.mockResolvedValueOnce({
    object: { tasks },
    usage: { inputTokens: 10, outputTokens: 20 },
  });
}

beforeEach(() => {
  process.env["AI_GATEWAY_API_KEY"] = "test-key";
  delete process.env["ANTHROPIC_API_KEY"];
  uninstallDirectAnthropicProviderForTests();
  delete process.env["OXAGEN_LLM_FAST"];
  delete process.env["OXAGEN_LLM_BALANCED"];
  delete process.env["OXAGEN_LLM_PRECISE"];
  delete process.env["OXAGEN_MODEL"];
});

describe("planTasks", () => {
  it("builds a draft plan from the model's tasks", async () => {
    resolveWith([
      {
        id: "a",
        title: "Do A",
        description: "first",
        dependsOn: [],
        files: ["a.ts"],
        tier: "fast",
      },
      {
        id: "b",
        title: "Do B",
        description: "second",
        dependsOn: ["a"],
        files: ["b.ts"],
        tier: "balanced",
      },
    ]);
    const plan = await planTasks({ goal: "do the thing", cwd: tmpdir() });
    expect(plan.status).toBe("draft");
    expect(plan.goal).toBe("do the thing");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.every((t) => t.status === "queued")).toBe(true);
    expect(plan.tasks[1]?.dependsOn).toEqual(["a"]);
    expect(plan.tasks[0]?.model).toContain("haiku");
    expect(plan.tasks[0]?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("escalates a task's tier when its description is high-stakes", async () => {
    resolveWith([
      {
        id: "pay",
        title: "Add refund",
        description: "implement the stripe billing refund flow",
        dependsOn: [],
        files: ["pay.ts"],
        tier: "fast", // model under-estimated
      },
    ]);
    const plan = await planTasks({ goal: "billing", cwd: tmpdir() });
    expect(plan.tasks[0]?.tier).toBe("precise");
    expect(plan.tasks[0]?.model).toContain("fable");
  });

  it("never downgrades a precise task the model already flagged", async () => {
    resolveWith([
      {
        id: "x",
        title: "tiny",
        description: "rename a local var",
        dependsOn: [],
        files: [],
        tier: "precise",
      },
    ]);
    const plan = await planTasks({ goal: "g", cwd: tmpdir() });
    expect(plan.tasks[0]?.tier).toBe("precise");
  });

  it("de-duplicates repeated ids", async () => {
    resolveWith([
      {
        id: "x",
        title: "One",
        description: "d",
        dependsOn: [],
        files: [],
        tier: "fast",
      },
      {
        id: "x",
        title: "Two",
        description: "d",
        dependsOn: [],
        files: [],
        tier: "fast",
      },
    ]);
    const plan = await planTasks({ goal: "g", cwd: tmpdir() });
    const ids = plan.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("x");
  });

  it("drops dependencies that point at nonexistent or self ids", async () => {
    resolveWith([
      {
        id: "a",
        title: "A",
        description: "d",
        dependsOn: ["ghost", "b", "a"],
        files: [],
        tier: "fast",
      },
      {
        id: "b",
        title: "B",
        description: "d",
        dependsOn: [],
        files: [],
        tier: "fast",
      },
    ]);
    const plan = await planTasks({ goal: "g", cwd: tmpdir() });
    expect(plan.tasks[0]?.dependsOn).toEqual(["b"]);
  });

  it("throws MissingAiKeyError when neither a gateway nor an Anthropic key is resolvable", async () => {
    delete process.env["AI_GATEWAY_API_KEY"];
    // cwd in the OS temp dir → no .env.local up the tree, and config is mocked empty.
    await expect(
      planTasks({ goal: "g", cwd: tmpdir() }),
    ).rejects.toBeInstanceOf(MissingAiKeyError);
    expect(mockGen).not.toHaveBeenCalled();
  });

  it("plans with only ANTHROPIC_API_KEY (direct-Anthropic BYOK fallback)", async () => {
    delete process.env["AI_GATEWAY_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    resolveWith([
      {
        id: "a",
        title: "A",
        description: "d",
        dependsOn: [],
        files: [],
        tier: "fast",
      },
    ]);
    const plan = await planTasks({ goal: "g", cwd: tmpdir() });
    expect(plan.tasks).toHaveLength(1);
    uninstallDirectAnthropicProviderForTests();
  });
});
