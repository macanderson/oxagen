import {
  hashArtifact,
  hashCanonicalJson,
  type AgentArtifact,
  type LifecycleEvent,
  type LifecycleInvocation,
} from "@oxagen/agent-artifacts";
import type { CapabilityLifecycleMetadata } from "@oxagen/oxagen";

export interface LifecycleCapabilityDescriptor {
  name: string;
  lifecycle?: CapabilityLifecycleMetadata;
}

export interface CompiledLifecycleInvocation extends LifecycleInvocation {
  ordinal: number;
  lifecycle: CapabilityLifecycleMetadata;
}

export interface CompiledLifecyclePlan {
  schemaVersion: 1;
  agentName: string;
  artifactHash: string;
  planHash: string;
  delivery: "buffered";
  invocations: readonly CompiledLifecycleInvocation[];
  byEvent: ReadonlyMap<LifecycleEvent, readonly CompiledLifecycleInvocation[]>;
}

export class LifecycleCompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LifecycleCompileError";
  }
}

export function compileLifecyclePlan(
  agent: AgentArtifact,
  resolveCapability: (
    name: string,
  ) => LifecycleCapabilityDescriptor | undefined,
): CompiledLifecyclePlan {
  if (agent.unresolved_tools.length > 0) {
    throw new LifecycleCompileError(
      "artifact_needs_review",
      `agent has unresolved tools: ${agent.unresolved_tools.join(", ")}`,
    );
  }
  const driver = agent.driver ?? {
    delivery: "buffered" as const,
    invocations: [],
  };
  const invocations = driver.invocations.map((invocation, ordinal) => {
    const capability = resolveCapability(invocation.capability);
    if (!capability) {
      throw new LifecycleCompileError(
        "unknown_lifecycle_capability",
        `unknown capability ${invocation.capability}`,
      );
    }
    const metadata = capability.lifecycle;
    if (!metadata) {
      throw new LifecycleCompileError(
        "lifecycle_capability_not_eligible",
        `${invocation.capability} has not opted in`,
      );
    }
    if (!metadata.allowedEvents.includes(invocation.event)) {
      throw new LifecycleCompileError(
        "lifecycle_event_denied",
        `${invocation.capability} does not allow ${invocation.event}`,
      );
    }
    const outputKind = invocation.apply_as ?? "opaque";
    if (!metadata.outputKinds.includes(outputKind)) {
      throw new LifecycleCompileError(
        "lifecycle_output_kind_denied",
        `${invocation.capability} does not produce ${outputKind}`,
      );
    }
    if (
      invocation.on_error === "retry" &&
      metadata.effect === "mutation" &&
      metadata.idempotency === "none"
    ) {
      throw new LifecycleCompileError(
        "unsafe_lifecycle_retry",
        `${invocation.capability} mutates without idempotency support`,
      );
    }
    return { ...invocation, ordinal, lifecycle: metadata };
  });

  const byEvent = new Map<LifecycleEvent, CompiledLifecycleInvocation[]>();
  for (const invocation of invocations) {
    const list = byEvent.get(invocation.event) ?? [];
    list.push(invocation);
    byEvent.set(invocation.event, list);
  }
  const artifactHash = hashArtifact(agent);
  const planHash = hashCanonicalJson({
    schemaVersion: 1,
    agentName: agent.name,
    artifactHash,
    delivery: driver.delivery,
    invocations,
  });
  return {
    schemaVersion: 1,
    agentName: agent.name,
    artifactHash,
    planHash,
    delivery: driver.delivery,
    invocations,
    byEvent,
  };
}
