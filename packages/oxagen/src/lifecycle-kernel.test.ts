import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clearHandlersForTests, invoke, registerHandler } from "./kernel";
import { clearRegistryForTests, registerCapability } from "./registry";
import type { CapabilityContext } from "./types";

const runnerContext: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "00000000-0000-0000-0000-000000000003",
  apiKeyId: null,
  requestId: "run-1",
  surface: "runner",
  messageId: null,
};

function registerLifecycleCapability(
  allowedEvents = ["before_intelligence"] as const,
) {
  return registerCapability({
    name: "build_prompt_patch",
    domain: "test",
    description: "Build a patch",
    mode: "sync" as const,
    surfaces: ["api"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "deny" as const,
    defaultRoles: { org: {}, workspace: {} },
    lifecycle: {
      allowedEvents,
      effect: "read" as const,
      idempotency: "supported" as const,
      outputKinds: ["prompt_patch"] as const,
    },
    input: z.object({ value: z.string() }).strict(),
    output: z.object({ operations: z.array(z.unknown()) }),
  });
}

describe("kernel lifecycle execution", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
  });

  it("checks opt-in and event before loading a handler", async () => {
    registerLifecycleCapability();
    const loader = vi.fn(async () => async (input: unknown) => input);
    registerHandler("build_prompt_patch", loader);
    await expect(
      invoke("build_prompt_patch", { value: "x" }, runnerContext, {
        execution: {
          kind: "lifecycle",
          event: "after_turn",
          invocationId: "hydrate",
          idempotencyKey: "stable-key",
          depth: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "lifecycle_event_denied" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("passes execution metadata in checked context without changing strict input", async () => {
    registerLifecycleCapability();
    const handler = vi.fn(async (input: unknown, context: unknown) => ({
      operations: [input, context],
    }));
    registerHandler("build_prompt_patch", async () => handler);
    const output = await invoke(
      "build_prompt_patch",
      { value: "x" },
      runnerContext,
      {
        execution: {
          kind: "lifecycle",
          event: "before_intelligence",
          invocationId: "hydrate",
          idempotencyKey: "stable-key",
          depth: 0,
        },
      },
    );
    expect(output).toEqual(
      expect.objectContaining({ operations: expect.any(Array) }),
    );
    expect(handler.mock.calls[0]?.[0]).toEqual({ value: "x" });
    expect(handler.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        surface: "runner",
        idempotencyKey: "stable-key",
        execution: expect.objectContaining({ event: "before_intelligence" }),
      }),
    );
  });

  it("fails closed on unopted capabilities, non-runner contexts, and recursion", async () => {
    registerLifecycleCapability();
    registerHandler("build_prompt_patch", async () => async () => ({
      operations: [],
    }));
    const execution = {
      kind: "lifecycle" as const,
      event: "before_intelligence" as const,
      invocationId: "hydrate",
      idempotencyKey: "stable-key",
      depth: 0,
    };
    await expect(
      invoke(
        "build_prompt_patch",
        { value: "x" },
        { ...runnerContext, surface: "api" },
        { execution },
      ),
    ).rejects.toMatchObject({ code: "lifecycle_context_invalid" });
    await expect(
      invoke("build_prompt_patch", { value: "x" }, runnerContext, {
        execution: { ...execution, depth: 1 },
      }),
    ).rejects.toMatchObject({ code: "lifecycle_recursion_denied" });
  });
});
