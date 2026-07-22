import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  EventPayload,
  WaitForEventOptions,
  StepContext,
  ConcurrencyConfig,
  CancelOnConfig,
  DurableFunctionConfig,
  DurableFunctionTrigger,
  DurableFunctionHandlerContext,
  DurableFunctionHandler,
  DurableFunction,
  EventClient,
  CreateFunctionFactory,
} from "./types";
import { NonRetriableError } from "./types";

describe("@oxagen/functions type contracts", () => {
  describe("EventPayload", () => {
    it("accepts name and generic data", () => {
      const event: EventPayload<{ orgId: string }> = {
        name: "test/event",
        data: { orgId: "org_123" },
      };
      expectTypeOf(event.name).toBeString();
      expectTypeOf(event.data.orgId).toBeString();
    });

    it("defaults data to Record<string, unknown>", () => {
      const event: EventPayload = {
        name: "test/event",
        data: { anything: true },
      };
      expectTypeOf(event.data).toEqualTypeOf<Record<string, unknown>>();
    });
  });

  describe("StepContext", () => {
    it("run() accepts name and async function, returns typed result", () => {
      expectTypeOf<StepContext["run"]>().toBeCallableWith(
        "step-name",
        async () => 42,
      );
    });

    it("sendEvent() accepts label and single event", () => {
      const step = {} as StepContext;
      expectTypeOf(step.sendEvent).toBeCallableWith("emit", {
        name: "test/event",
        data: { key: "value" },
      });
    });

    it("sendEvent() accepts label and array of events", () => {
      const step = {} as StepContext;
      expectTypeOf(step.sendEvent).toBeCallableWith("emit-batch", [
        { name: "test/a", data: {} },
        { name: "test/b", data: {} },
      ]);
    });

    it("waitForEvent() returns event or null", () => {
      const step = {} as StepContext;
      type WaitResult = Awaited<ReturnType<typeof step.waitForEvent>>;
      // Verify the union members are correct.
      expectTypeOf<EventPayload>().toMatchTypeOf<NonNullable<WaitResult>>();
      // Null is assignable to the result (timeout case).
      const _check: WaitResult = null;
      void _check;
    });

    it("sleep() accepts string duration", () => {
      const step = {} as StepContext;
      expectTypeOf(step.sleep).toBeCallableWith("wait", "30s");
    });

    it("sleep() accepts Date", () => {
      const step = {} as StepContext;
      expectTypeOf(step.sleep).toBeCallableWith("wait-until", new Date());
    });
  });

  describe("WaitForEventOptions", () => {
    it("requires event and timeout, optional match", () => {
      const opts: WaitForEventOptions = {
        event: "agent/subagent.fanout.completed",
        timeout: "300s",
        match: "data.fanoutId",
      };
      expectTypeOf(opts.event).toBeString();
      expectTypeOf(opts.timeout).toBeString();
      expectTypeOf(opts.match).toEqualTypeOf<string | undefined>();
    });
  });

  describe("DurableFunctionConfig", () => {
    it("requires id, optional retries/concurrency/cancelOn", () => {
      const minimal: DurableFunctionConfig = { id: "my-function" };
      expectTypeOf(minimal.id).toBeString();
      expectTypeOf(minimal.retries).toEqualTypeOf<number | undefined>();
      expectTypeOf(minimal.concurrency).toEqualTypeOf<
        ConcurrencyConfig | undefined
      >();
      expectTypeOf(minimal.cancelOn).toEqualTypeOf<
        CancelOnConfig[] | undefined
      >();
    });

    it("full config matches existing inngest usage patterns", () => {
      const full: DurableFunctionConfig = {
        id: "agent.workflow.supervisor",
        retries: 1,
        concurrency: { limit: 10, key: "event.data.orgId" },
        cancelOn: [
          {
            event: "agent/workflow.cancel",
            if: "event.data.executionId == async.data.executionId",
          },
        ],
      };
      expect(full.id).toBe("agent.workflow.supervisor");
      expect(full.retries).toBe(1);
      expect(full.concurrency?.limit).toBe(10);
      expect(full.cancelOn?.[0]?.event).toBe("agent/workflow.cancel");
    });

    it("supports optional batchEvents config", () => {
      const config: DurableFunctionConfig = {
        id: "ingestion.provider-metadata-batch",
        batchEvents: { maxSize: 50, timeout: "30s", key: "event.data.orgId" },
      };
      expectTypeOf(config.batchEvents).toEqualTypeOf<
        { maxSize: number; timeout: string; key?: string } | undefined
      >();
      expect(config.batchEvents?.maxSize).toBe(50);
      expect(config.batchEvents?.timeout).toBe("30s");
      expect(config.batchEvents?.key).toBe("event.data.orgId");
    });

    it("supports optional timeouts with finish duration", () => {
      const config: DurableFunctionConfig = {
        id: "agent.video-render",
        timeouts: { finish: "16m" },
      };
      expectTypeOf(config.timeouts).toEqualTypeOf<
        { finish?: string } | undefined
      >();
      expect(config.timeouts?.finish).toBe("16m");
    });

    it("supports optional onFailure handler", () => {
      const config: DurableFunctionConfig = {
        id: "my-function",
        onFailure: async ({ event, step }) => {
          await step.run("handle-failure", async () => event.data);
        },
      };
      expectTypeOf(config.onFailure).toEqualTypeOf<
        DurableFunctionHandler | undefined
      >();
      expect(config.onFailure).toBeTypeOf("function");
    });
  });

  describe("CreateFunctionFactory", () => {
    it("is callable with config, trigger, and handler returning DurableFunction[]", () => {
      const factory: CreateFunctionFactory = (_config, _trigger, _handler) => {
        return [{ config: _config, trigger: _trigger }];
      };
      expectTypeOf(factory).toBeCallableWith(
        { id: "test" },
        { event: "test/event" },
        async () => undefined,
      );
      expectTypeOf(factory).returns.toEqualTypeOf<DurableFunction[]>();
    });
  });

  describe("DurableFunctionTrigger", () => {
    it("can be event-based", () => {
      const trigger: DurableFunctionTrigger = {
        event: "agent/workflow.supervisor.start",
      };
      expectTypeOf(trigger).toMatchTypeOf<{ event: string }>();
    });

    it("can be cron-based", () => {
      const trigger: DurableFunctionTrigger = { cron: "0 1 * * *" };
      expectTypeOf(trigger).toMatchTypeOf<{ cron: string }>();
    });
  });

  describe("DurableFunctionHandler", () => {
    it("is an async function accepting context and returning unknown", () => {
      const handler: DurableFunctionHandler = async ({ event, step }) => {
        const result = await step.run("load", async () => ({ id: "123" }));
        await step.sendEvent("notify", {
          name: "done",
          data: { id: result.id },
        });
        return result;
      };
      expectTypeOf(handler).toBeFunction();
    });

    it("supports generic return type", () => {
      const handler: DurableFunctionHandler<{ count: number }> = async () => {
        return { count: 42 };
      };
      expectTypeOf(handler).returns.resolves.toEqualTypeOf<{ count: number }>();
    });
  });

  describe("DurableFunctionHandlerContext", () => {
    it("provides event and step", () => {
      expectTypeOf<DurableFunctionHandlerContext["event"]>().toEqualTypeOf<
        EventPayload<Record<string, unknown>>
      >();
      expectTypeOf<
        DurableFunctionHandlerContext["step"]
      >().toEqualTypeOf<StepContext>();
    });
  });

  describe("DurableFunction", () => {
    it("exposes config and trigger as readonly (id is config.id — no top-level id)", () => {
      const fn = {} as DurableFunction;
      expectTypeOf(fn.config).toEqualTypeOf<DurableFunctionConfig>();
      // id is exposed via config.id (type-level — no runtime access on the empty cast).
      expectTypeOf<DurableFunction["config"]["id"]>().toBeString();
      expectTypeOf(fn.trigger).toEqualTypeOf<DurableFunctionTrigger>();
    });
  });

  describe("EventClient", () => {
    it("send() accepts single event", () => {
      const client = {} as EventClient;
      expectTypeOf(client.send).toBeCallableWith({
        name: "test/event",
        data: { key: "val" },
      });
    });

    it("send() accepts array of events", () => {
      const client = {} as EventClient;
      expectTypeOf(client.send).toBeCallableWith([
        { name: "test/a", data: {} },
        { name: "test/b", data: {} },
      ]);
    });

    it("send() returns Promise<void>", () => {
      expectTypeOf<EventClient["send"]>().returns.toEqualTypeOf<
        Promise<void>
      >();
    });
  });

  describe("NonRetriableError", () => {
    it("is an Error subclass", () => {
      const err = new NonRetriableError("permanent failure");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("NonRetriableError");
      expect(err.message).toBe("permanent failure");
      expect(err.isNonRetriable).toBe(true);
    });

    it("supports cause via ErrorOptions", () => {
      const cause = new Error("root cause");
      const err = new NonRetriableError("wrapper", { cause });
      expect(err.cause).toBe(cause);
    });

    it("isNonRetriable is a const true", () => {
      const err = new NonRetriableError("test");
      expectTypeOf(err.isNonRetriable).toEqualTypeOf<true>();
    });
  });
});
