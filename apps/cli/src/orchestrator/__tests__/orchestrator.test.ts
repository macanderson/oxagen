import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollaboratorNotWiredError,
  JudgeMustDifferError,
  NonTrivialWorkError,
  Orchestrator,
  createOrchestrator,
} from "../orchestrator.js";
import type { OrchestratorLogEntry } from "../logging.js";
import type { ContextResolver, JudgeTool, MonitorService, WorkerResult } from "../types.js";
import type { CompletionResult, ModelProvider } from "../../runtime/types.js";

/** A stub provider that records calls and returns canned output. */
function fakeProvider(id: string, text = "diff --git a b"): ModelProvider {
  const complete = vi.fn(
    async (): Promise<CompletionResult> => ({
      text,
      usage: { inputTokens: 10, outputTokens: 5 },
      model: id,
      kind: "cloud",
      costUsd: 0.002,
    }),
  );
  return {
    id: () => id,
    kind: () => "cloud",
    isAvailable: async () => true,
    ensureReady: async () => {},
    complete,
    estimateCost: () => ({ tokens: 120, usd: 0.002 }),
    capabilities: () => ({
      id,
      kind: "cloud",
      vendor: "test",
      contextWindow: 1000,
      offline: false,
      tools: true,
    }),
  };
}

const ENV_KEYS = ["OXAGEN_COORDINATOR", "OXAGEN_ROUTING_TRIVIAL_MAX"];

describe("Orchestrator", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env["OXAGEN_COORDINATOR"] = "on-device";
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("dispatches a worker through ModelProvider and records the worker model", async () => {
    const built: string[] = [];
    const entries: OrchestratorLogEntry[] = [];
    const orch = new Orchestrator({
      buildProvider: (id) => {
        built.push(id);
        return fakeProvider(id);
      },
      log: (e) => entries.push(e),
    });

    const result = await orch.dispatchWorker({ model: "sonnet-5", prompt: "add a route" });

    expect(built).toContain("sonnet-5");
    expect(result.workerModel).toBe("sonnet-5");
    expect(result.diff).toContain("diff --git");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    // Pipeline state records the worker so the judge can be forced to differ.
    expect(orch.recordedWorkerModel).toBe("sonnet-5");
    // Dispatch was logged.
    expect(entries.some((e) => e.kind === "dispatch" && e.worker === "sonnet-5")).toBe(true);
  });

  it("passes a per-call timeout signal to the provider", async () => {
    let seenSignal: AbortSignal | undefined;
    const orch = new Orchestrator({
      buildProvider: (id) => {
        const p = fakeProvider(id);
        p.complete = async (req) => {
          seenSignal = req.signal;
          return {
            text: "ok",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: id,
            kind: "cloud",
            costUsd: 0,
          };
        };
        return p;
      },
      log: () => {},
    });
    await orch.dispatchWorker({ model: "sonnet-5", prompt: "x", timeoutMs: 5000 });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("folds structured graph context into the worker prompt", async () => {
    let seenPrompt = "";
    const orch = new Orchestrator({
      buildProvider: (id) => {
        const p = fakeProvider(id);
        const orig = p.complete;
        p.complete = async (req) => {
          seenPrompt = req.messages[0]!.content;
          return orig(req);
        };
        return p;
      },
      log: () => {},
    });

    await orch.dispatchWorker({
      model: "sonnet-5",
      prompt: "fix the bug",
      context: {
        impactedFiles: [{ path: "src/a.ts", reason: "defines the handler" }],
        symbols: [],
        edges: [],
        coverage: 0.9,
      },
    });

    expect(seenPrompt).toContain("fix the bug");
    expect(seenPrompt).toContain("src/a.ts");
    expect(seenPrompt).toContain("defines the handler");
  });

  it("route() delegates to the router and remembers the decision", () => {
    const orch = new Orchestrator({ log: () => {} });
    const d = orch.route({ complexity: "medium", writesCode: true, promptTokens: 100 });
    expect(d.model).toBe("sonnet-5");
    expect(d.isCoordinator).toBe(false);
  });

  describe("doTrivial", () => {
    it("runs the coordinator model for trivial work", async () => {
      const built: string[] = [];
      const orch = new Orchestrator({
        buildProvider: (id) => {
          built.push(id);
          return fakeProvider(id, "renamed");
        },
        log: () => {},
      });
      const out = await orch.doTrivial("rename foo to bar", "low");
      expect(out).toBe("renamed");
      expect(built).toContain("on-device");
    });

    it("throws rather than doing non-trivial work itself", async () => {
      const orch = new Orchestrator({ buildProvider: (id) => fakeProvider(id), log: () => {} });
      await expect(orch.doTrivial("rewrite the auth system", "high")).rejects.toBeInstanceOf(
        NonTrivialWorkError,
      );
    });

    it("defaults the complexity to trivial", async () => {
      const orch = new Orchestrator({
        buildProvider: (id) => fakeProvider(id, "ok"),
        log: () => {},
      });
      await expect(orch.doTrivial("read a file")).resolves.toBe("ok");
    });
  });

  describe("requestJudge", () => {
    it("refuses a judge that matches the worker model", async () => {
      const orch = new Orchestrator({ log: () => {} });
      await expect(
        orch.requestJudge({ diff: "x", workerModel: "sonnet-5", judgeModel: "sonnet-5" }),
      ).rejects.toBeInstanceOf(JudgeMustDifferError);
    });

    it("delegates to the judge tool when the models differ", async () => {
      const judgeTool: JudgeTool = {
        judge: vi.fn(async () => ({ verdict: "pass" as const, score: 0.9, notes: "lgtm" })),
      };
      const orch = new Orchestrator({ judgeTool, log: () => {} });
      const out = await orch.requestJudge({
        diff: "x",
        workerModel: "sonnet-5",
        judgeModel: "openai-most-capable-coding-model",
      });
      expect(out.verdict).toBe("pass");
      expect(judgeTool.judge).toHaveBeenCalledOnce();
    });

    it("throws when the judge tool is not wired", async () => {
      const orch = new Orchestrator({ log: () => {} });
      await expect(
        orch.requestJudge({
          diff: "x",
          workerModel: "sonnet-5",
          judgeModel: "openai-most-capable-coding-model",
        }),
      ).rejects.toBeInstanceOf(CollaboratorNotWiredError);
    });
  });

  describe("judgeModelFor", () => {
    it("returns the registry judge default, which differs from the worker", async () => {
      const orch = new Orchestrator({ buildProvider: (id) => fakeProvider(id), log: () => {} });
      await orch.dispatchWorker({ model: "sonnet-5", prompt: "x" });
      const judge = orch.judgeModelFor(orch.recordedWorkerModel!);
      expect(judge).toBe("openai-most-capable-coding-model");
      expect(judge).not.toBe(orch.recordedWorkerModel);
    });

    it("throws if the only judge coincides with the worker", () => {
      const orch = new Orchestrator({ log: () => {} });
      expect(() => orch.judgeModelFor("openai-most-capable-coding-model")).toThrow(
        JudgeMustDifferError,
      );
    });
  });

  describe("verifyWork", () => {
    const result: WorkerResult = {
      workerModel: "sonnet-5",
      diff: "diff",
      evidence: ["tests pass"],
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    };

    it("passes without a gate when verifyWork is off", async () => {
      const orch = new Orchestrator({ log: () => {} });
      await expect(
        orch.verifyWork({ ...result, evidence: [], diff: "" }),
      ).resolves.toBe(true);
    });

    it("requires evidence and a diff when verifyWork is on", async () => {
      const orch = new Orchestrator({ verifyWork: true, log: () => {} });
      await expect(orch.verifyWork(result)).resolves.toBe(true);
      await expect(orch.verifyWork({ ...result, evidence: [] })).resolves.toBe(false);
      await expect(orch.verifyWork({ ...result, diff: "   " })).resolves.toBe(false);
    });
  });

  describe("collaborator seams", () => {
    it("gatherContext delegates to the injected resolver", async () => {
      const context: ContextResolver = {
        query: vi.fn(async () => ({
          impactedFiles: [{ path: "a.ts", reason: "r" }],
          symbols: [],
          edges: [],
          coverage: 1,
        })),
      };
      const orch = new Orchestrator({ context, log: () => {} });
      const r = await orch.gatherContext({ query: "auth" });
      expect(r.impactedFiles[0]!.path).toBe("a.ts");
      expect(context.query).toHaveBeenCalledOnce();
    });

    it("gatherContext throws when the resolver is not wired", async () => {
      const orch = new Orchestrator({ log: () => {} });
      await expect(orch.gatherContext({ query: "x" })).rejects.toBeInstanceOf(
        CollaboratorNotWiredError,
      );
    });

    it("dispatchMonitor delegates and never blocks", async () => {
      const monitors: MonitorService = {
        dispatch: vi.fn(async () => ({ subagentId: "sub-1", background: true as const })),
      };
      const orch = new Orchestrator({ monitors, log: () => {} });
      const r = await orch.dispatchMonitor({ targetType: "ci_job", targetId: "job-9" });
      expect(r).toEqual({ subagentId: "sub-1", background: true });
    });

    it("dispatchMonitor throws when the monitor service is not wired", async () => {
      const orch = new Orchestrator({ log: () => {} });
      await expect(
        orch.dispatchMonitor({ targetType: "pull_request", targetId: "42" }),
      ).rejects.toBeInstanceOf(CollaboratorNotWiredError);
    });
  });

  it("createOrchestrator builds a working coordinator", () => {
    const orch = createOrchestrator({ log: () => {} });
    expect(orch).toBeInstanceOf(Orchestrator);
  });
});
