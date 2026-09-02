import { describe, it, expect, vi, beforeEach } from "vitest";
import { NonRetriableError } from "@oxagen/functions";
import type {
  DurableFunctionConfig,
  DurableFunctionTrigger,
  DurableFunctionHandler,
} from "@oxagen/functions";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  inngestCreateFunction: vi.fn(),
}));

vi.mock("./inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ INNGEST_EVENT_KEY: "evt-test" }),
}));

const { createFunction } = await import("./create-function");

// ─────────────────────────────────────────────────────────────────────────────

describe("createFunction adapter", () => {
  let capturedConfigs: unknown[] = [];
  let capturedTriggers: unknown[] = [];
  let capturedHandlers: Array<(ctx: unknown) => Promise<unknown>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedConfigs = [];
    capturedTriggers = [];
    capturedHandlers = [];

    mocks.inngestCreateFunction.mockImplementation(
      (
        config: unknown,
        trigger: unknown,
        handler: (ctx: unknown) => Promise<unknown>,
      ) => {
        capturedConfigs.push(config);
        capturedTriggers.push(trigger);
        capturedHandlers.push(handler);
        return { _inngestFn: true };
      },
    );
  });

  describe("basic function creation", () => {
    it("returns an array with one DurableFunction for simple config", () => {
      const config: DurableFunctionConfig = { id: "my-function", retries: 3 };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => "result";

      const result = createFunction(config, trigger, handler);

      expect(result).toHaveLength(1);
      // id lives on config (no top-level `id` — it would shadow Inngest's id() method).
      expect(result[0]!.config.id).toBe("my-function");
      expect(result[0]!.config).toEqual(config);
      expect(result[0]!.trigger).toEqual(trigger);
    });

    it("does NOT assign an own `id` property (would shadow Inngest's id() method)", () => {
      // Regression guard (serve crash "this.id is not a function"): Inngest's
      // InngestFunction exposes `id` as a METHOD that serve()/getConfig() calls.
      // The adapter must never Object.assign a string `id` onto it, or the
      // /api/inngest sync throws the moment the dev server connects.
      const config: DurableFunctionConfig = { id: "my-function" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => "result";

      const result = createFunction(config, trigger, handler);

      expect(Object.prototype.hasOwnProperty.call(result[0], "id")).toBe(false);
    });

    it("calls inngest.createFunction once for simple config", () => {
      const config: DurableFunctionConfig = { id: "test-fn" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      expect(mocks.inngestCreateFunction).toHaveBeenCalledTimes(1);
    });

    it("translates config fields to Inngest format", () => {
      const config: DurableFunctionConfig = {
        id: "agent.video-render",
        retries: 0,
        concurrency: { limit: 4, key: "event.data.orgId" },
        cancelOn: [
          { event: "agent/cancel", if: "event.data.id == async.data.id" },
        ],
        timeouts: { finish: "16m" },
      };
      const trigger: DurableFunctionTrigger = { event: "agent/video.render" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      const inngestConfig = capturedConfigs[0] as Record<string, unknown>;
      expect(inngestConfig.id).toBe("agent.video-render");
      expect(inngestConfig.retries).toBe(0);
      expect(inngestConfig.concurrency).toEqual({
        limit: 4,
        key: "event.data.orgId",
      });
      expect(inngestConfig.cancelOn).toEqual([
        { event: "agent/cancel", if: "event.data.id == async.data.id" },
      ]);
      expect(inngestConfig.timeouts).toEqual({ finish: "16m" });
    });

    it("translates event trigger to Inngest format", () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "my/event" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      expect(capturedTriggers[0]).toEqual({ event: "my/event" });
    });

    it("translates cron trigger to Inngest format", () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { cron: "0 1 * * *" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      expect(capturedTriggers[0]).toEqual({ cron: "0 1 * * *" });
    });
  });

  describe("step context proxying", () => {
    it("proxies step.run to inngest step.run", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async ({ step }) => {
        return await step.run("my-step", async () => 42);
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi
          .fn()
          .mockImplementation((_name: string, fn: () => unknown) => fn()),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      const result = await capturedHandlers[0]!({
        event: { name: "test/event", data: {} },
        step: mockStep,
      });

      expect(mockStep.run).toHaveBeenCalledWith(
        "my-step",
        expect.any(Function),
      );
      expect(result).toBe(42);
    });

    it("proxies step.sendEvent to inngest step.sendEvent", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async ({ step }) => {
        await step.sendEvent("emit", {
          name: "out/event",
          data: { key: "val" },
        });
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn().mockResolvedValue(undefined),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      await capturedHandlers[0]!({
        event: { name: "test/event", data: {} },
        step: mockStep,
      });

      expect(mockStep.sendEvent).toHaveBeenCalledWith("emit", {
        name: "out/event",
        data: { key: "val" },
      });
    });

    it("proxies step.waitForEvent to inngest step.waitForEvent", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async ({ step }) => {
        return await step.waitForEvent("wait-for-result", {
          event: "agent/done",
          timeout: "300s",
          match: "data.fanoutId",
        });
      };

      createFunction(config, trigger, handler);

      const fakeResult = { name: "agent/done", data: { fanoutId: "abc" } };
      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn().mockResolvedValue(fakeResult),
        sleep: vi.fn(),
      };

      const result = await capturedHandlers[0]!({
        event: { name: "test/event", data: {} },
        step: mockStep,
      });

      expect(mockStep.waitForEvent).toHaveBeenCalledWith("wait-for-result", {
        event: "agent/done",
        timeout: "300s",
        match: "data.fanoutId",
      });
      expect(result).toEqual(fakeResult);
    });

    it("proxies step.sleep to inngest step.sleep", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async ({ step }) => {
        await step.sleep("wait", "30s");
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
      };

      await capturedHandlers[0]!({
        event: { name: "test/event", data: {} },
        step: mockStep,
      });

      expect(mockStep.sleep).toHaveBeenCalledWith("wait", "30s");
    });

    it("passes event data to the handler context", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      let receivedEvent: unknown = null;
      const handler: DurableFunctionHandler = async ({ event }) => {
        receivedEvent = event;
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      await capturedHandlers[0]!({
        event: { name: "test/event", data: { orgId: "org_1" } },
        step: mockStep,
      });

      expect(receivedEvent).toEqual({
        name: "test/event",
        data: { orgId: "org_1" },
      });
    });
  });

  describe("NonRetriableError translation", () => {
    it("translates @oxagen/functions NonRetriableError to Inngest NonRetriableError", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => {
        throw new NonRetriableError("permanent failure");
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      // We need to dynamically import the Inngest NonRetriableError to check instanceof
      const { NonRetriableError: InngestNRE } = await import("inngest");

      await expect(
        capturedHandlers[0]!({
          event: { name: "test/event", data: {} },
          step: mockStep,
        }),
      ).rejects.toThrow(InngestNRE);
    });

    it("preserves the error message during translation", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => {
        throw new NonRetriableError("data validation failed");
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      try {
        await capturedHandlers[0]!({
          event: { name: "test/event", data: {} },
          step: mockStep,
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toBe("data validation failed");
      }
    });

    it("preserves cause during translation", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const rootCause = new Error("root");
      const handler: DurableFunctionHandler = async () => {
        throw new NonRetriableError("wrapped", { cause: rootCause });
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      try {
        await capturedHandlers[0]!({
          event: { name: "test/event", data: {} },
          step: mockStep,
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).cause).toBe(rootCause);
      }
    });

    it("re-throws non-NonRetriableError errors unchanged", async () => {
      const config: DurableFunctionConfig = { id: "test" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const originalError = new Error("transient failure");
      const handler: DurableFunctionHandler = async () => {
        throw originalError;
      };

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      try {
        await capturedHandlers[0]!({
          event: { name: "test/event", data: {} },
          step: mockStep,
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBe(originalError);
      }
    });
  });

  describe("onFailure companion function", () => {
    it("registers a companion function when config.onFailure is set", () => {
      const config: DurableFunctionConfig = {
        id: "my-function",
        onFailure: async () => undefined,
      };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => "primary";

      const result = createFunction(config, trigger, handler);

      expect(result).toHaveLength(2);
      expect(mocks.inngestCreateFunction).toHaveBeenCalledTimes(2);
    });

    it("companion has correct id suffix", () => {
      const config: DurableFunctionConfig = {
        id: "privacy.erasure-execute",
        onFailure: async () => undefined,
      };
      const trigger: DurableFunctionTrigger = {
        event: "privacy/erasure.execute",
      };
      const handler: DurableFunctionHandler = async () => undefined;

      const result = createFunction(config, trigger, handler);

      expect(result[1]!.config.id).toBe("privacy.erasure-execute.on-failure");
    });

    it("companion is triggered by inngest/function.failed with correct if-filter", () => {
      const config: DurableFunctionConfig = {
        id: "my-function",
        onFailure: async () => undefined,
      };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      // Second call is the on-failure function
      const failureTrigger = capturedTriggers[1] as Record<string, unknown>;
      expect(failureTrigger.event).toBe("inngest/function.failed");
      expect(failureTrigger.if).toBe("event.data.function_id == 'my-function'");
    });

    it("companion handler invokes the onFailure handler with adapted step", async () => {
      let failureHandlerCalled = false;
      const config: DurableFunctionConfig = {
        id: "my-function",
        onFailure: async ({ event, step }) => {
          failureHandlerCalled = true;
          await step.run("handle-failure", async () => event.data);
        },
      };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => "primary";

      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi
          .fn()
          .mockImplementation((_name: string, fn: () => unknown) => fn()),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };

      // capturedHandlers[1] is the on-failure handler
      await capturedHandlers[1]!({
        event: {
          name: "inngest/function.failed",
          data: { function_id: "my-function", error: { message: "boom" } },
        },
        step: mockStep,
      });

      expect(failureHandlerCalled).toBe(true);
      expect(mockStep.run).toHaveBeenCalledWith(
        "handle-failure",
        expect.any(Function),
      );
    });

    it("does not register companion when onFailure is not set", () => {
      const config: DurableFunctionConfig = { id: "my-function" };
      const trigger: DurableFunctionTrigger = { event: "test/event" };
      const handler: DurableFunctionHandler = async () => undefined;

      const result = createFunction(config, trigger, handler);

      expect(result).toHaveLength(1);
      expect(mocks.inngestCreateFunction).toHaveBeenCalledTimes(1);
    });

    it("companion gets minimal config without inheriting primary retries/concurrency/timeouts", () => {
      const config: DurableFunctionConfig = {
        id: "agent.video-render",
        retries: 0,
        concurrency: { limit: 4, key: "event.data.orgId" },
        cancelOn: [
          { event: "agent/cancel", if: "event.data.id == async.data.id" },
        ],
        timeouts: { finish: "16m" },
        onFailure: async () => undefined,
      };
      const trigger: DurableFunctionTrigger = { event: "agent/video.render" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      // The companion (second call) should only have the id
      const companionConfig = capturedConfigs[1] as Record<string, unknown>;
      expect(companionConfig).toEqual({ id: "agent.video-render.on-failure" });
      expect(companionConfig).not.toHaveProperty("retries");
      expect(companionConfig).not.toHaveProperty("concurrency");
      expect(companionConfig).not.toHaveProperty("cancelOn");
      expect(companionConfig).not.toHaveProperty("timeouts");
    });

    it("companion DurableFunction.config contains only the id", () => {
      const config: DurableFunctionConfig = {
        id: "privacy.erasure-execute",
        retries: 2,
        concurrency: { limit: 10 },
        onFailure: async () => undefined,
      };
      const trigger: DurableFunctionTrigger = {
        event: "privacy/erasure.execute",
      };
      const handler: DurableFunctionHandler = async () => undefined;

      const result = createFunction(config, trigger, handler);

      // The companion's DurableFunction.config should be minimal
      expect(result[1]!.config).toEqual({
        id: "privacy.erasure-execute.on-failure",
      });
      expect(result[1]!.config).not.toHaveProperty("retries");
      expect(result[1]!.config).not.toHaveProperty("concurrency");
      expect(result[1]!.config).not.toHaveProperty("onFailure");
    });
  });

  describe("batchEvents", () => {
    it("passes batchEvents through to the inngest function config", () => {
      const config: DurableFunctionConfig = {
        id: "batch-fn",
        batchEvents: { maxSize: 50, timeout: "30s", key: "event.data.orgId" },
      };
      const trigger: DurableFunctionTrigger = { event: "test/batch" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      expect(capturedConfigs[0]).toMatchObject({
        id: "batch-fn",
        batchEvents: { maxSize: 50, timeout: "30s", key: "event.data.orgId" },
      });
    });

    it("omits batchEvents when not configured", () => {
      const config: DurableFunctionConfig = { id: "plain-fn" };
      const trigger: DurableFunctionTrigger = { event: "test/plain" };
      const handler: DurableFunctionHandler = async () => undefined;

      createFunction(config, trigger, handler);

      expect(capturedConfigs[0]).not.toHaveProperty("batchEvents");
    });

    it("exposes ctx.events (the full batch) to the handler", async () => {
      const config: DurableFunctionConfig = {
        id: "batch-fn",
        batchEvents: { maxSize: 50, timeout: "30s" },
      };
      const trigger: DurableFunctionTrigger = { event: "test/batch" };
      let seen: unknown;
      const handler: DurableFunctionHandler = async ({ events }) => {
        seen = events;
      };
      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };
      await capturedHandlers[0]!({
        event: { name: "test/batch", data: { i: 0 } },
        events: [
          { name: "test/batch", data: { i: 0 } },
          { name: "test/batch", data: { i: 1 } },
        ],
        step: mockStep,
      });

      expect(seen).toEqual([
        { name: "test/batch", data: { i: 0 } },
        { name: "test/batch", data: { i: 1 } },
      ]);
    });

    it("falls back to a single-element ctx.events for non-batched runs", async () => {
      const config: DurableFunctionConfig = { id: "plain-fn" };
      const trigger: DurableFunctionTrigger = { event: "test/plain" };
      let seen: unknown;
      const handler: DurableFunctionHandler = async ({ events }) => {
        seen = events;
      };
      createFunction(config, trigger, handler);

      const mockStep = {
        run: vi.fn(),
        sendEvent: vi.fn(),
        waitForEvent: vi.fn(),
        sleep: vi.fn(),
      };
      await capturedHandlers[0]!({
        event: { name: "test/plain", data: { only: true } },
        step: mockStep,
      });

      expect(seen).toEqual([{ name: "test/plain", data: { only: true } }]);
    });
  });
});
