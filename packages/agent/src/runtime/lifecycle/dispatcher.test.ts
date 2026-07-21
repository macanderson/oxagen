import { describe, expect, it, vi } from "vitest";
import type {
  AgentArtifact,
  LifecycleEventEnvelope,
} from "@oxagen/agent-artifacts";
import type { CapabilityContext } from "@oxagen/oxagen";
import { compileLifecyclePlan } from "./compile";
import { dispatchLifecycleEvent } from "./dispatcher";

const agent: AgentArtifact = {
  schema_version: 1,
  kind: "agent",
  name: "support-agent",
  description: "Support",
  developer_instructions: "Help.",
  tools: [],
  skills: [],
  unresolved_tools: [],
  driver: {
    delivery: "buffered",
    invocations: [
      {
        id: "first",
        event: "before_intelligence",
        capability: "build_first_patch",
        required: true,
        apply_as: "prompt_patch",
        timeout_ms: 1000,
        on_error: "block",
        input: { query: { from: "/turn/input/query", required: true } },
      },
      {
        id: "second",
        event: "before_intelligence",
        capability: "build_second_patch",
        required: true,
        apply_as: "prompt_patch",
        timeout_ms: 1000,
        on_error: "retry",
        max_attempts: 2,
      },
    ],
  },
};

const registry = (name: string) => ({
  name,
  lifecycle: {
    allowedEvents: ["before_intelligence"] as const,
    effect: "read" as const,
    idempotency: "supported" as const,
    outputKinds: ["prompt_patch"] as const,
  },
});

const envelope: LifecycleEventEnvelope = {
  schemaVersion: 1,
  event: "before_intelligence",
  invocationId: "event",
  idempotencyKey: "event-key",
  turn: {
    id: "turn-1",
    input: { query: "hello" },
    metadata: {},
    status: "running",
  },
  agent: { name: "support-agent", artifactHash: "artifact-hash" },
  principal: {
    orgId: "00000000-0000-0000-0000-000000000001",
    workspaceId: "00000000-0000-0000-0000-000000000002",
    kind: "user",
    principalId: "00000000-0000-0000-0000-000000000003",
  },
};

const context: CapabilityContext = {
  orgId: envelope.principal.orgId,
  workspaceId: envelope.principal.workspaceId,
  userId: envelope.principal.principalId,
  apiKeyId: null,
  requestId: "turn-1",
  surface: "runner",
  messageId: null,
};

describe("deterministic lifecycle dispatcher", () => {
  it("compiles opt-in metadata and executes declaration order through kernel invoke", async () => {
    const plan = compileLifecyclePlan(agent, registry);
    const calls: string[] = [];
    let secondAttempts = 0;
    const invoke = vi.fn(
      async (
        name: string,
        input: unknown,
        _context: CapabilityContext,
        _options: { execution?: unknown },
      ) => {
        calls.push(name);
        if (name === "build_second_patch" && secondAttempts++ === 0)
          throw new Error("transient");
        return {
          operations: [{ op: "append_system_context", content: name }],
        };
      },
    );
    const result = await dispatchLifecycleEvent({
      plan,
      event: "before_intelligence",
      envelope,
      context,
      prompt: {
        system: "base",
        user: "question",
        input: envelope.turn.input,
        metadata: {},
      },
      invoke,
    });
    expect(calls).toEqual([
      "build_first_patch",
      "build_second_patch",
      "build_second_patch",
    ]);
    expect(result.prompt?.system).toContain("build_first_patch");
    expect(result.prompt?.system).toContain("build_second_patch");
    expect(result.receipts.map((receipt) => receipt.attempts)).toEqual([1, 2]);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ query: "hello" });
    expect(invoke.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        execution: expect.objectContaining({ kind: "lifecycle", depth: 0 }),
      }),
    );
  });

  it("fails compilation for unsafe lifecycle contracts", () => {
    expect(() =>
      compileLifecyclePlan({ ...agent, unresolved_tools: ["Task"] }, registry),
    ).toThrow(/artifact_needs_review/);
    expect(() => compileLifecyclePlan(agent, () => undefined)).toThrow(
      /unknown_lifecycle_capability/,
    );
  });
});
