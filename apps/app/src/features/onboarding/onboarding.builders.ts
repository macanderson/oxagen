// Typed onboarding values for the gate and register component tests
// (ARCHITECTURE.md §5): a gate row, a first-frame read, and a DataSource that
// answers the onboarding and agents reads with what a test hands it.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import { refusingSource } from "@/test/refusing-source";
import type { AgentDetail } from "@/data/contracts/agents";
import type { FirstFrame, OnboardingGate } from "@/data/contracts/onboarding";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";

export function onboardingGate(
  overrides: Partial<OnboardingGate> = {},
): OnboardingGate {
  return {
    step: "wrap",
    workspace: { id: "wrk_core", slug: "core-platform" },
    firstFrameAt: null,
    firstRunId: null,
    provisional: {
      until: "2026-09-29T00:00:00.000Z",
      mainRepoBoundAt: null,
      detectedRepository: {
        provider: "github",
        owner: "acme",
        name: "platform",
      },
    },
    ...overrides,
  };
}

export function firstFrame(overrides: Partial<FirstFrame> = {}): FirstFrame {
  return {
    agentId: "agt_releasebot",
    agentKey: "acme.core.release-bot",
    host: {
      hostEnrollmentId: "tch_mbp",
      enrolledAt: "2026-09-15T14:01:48.000Z",
      lastHeartbeatAt: "2026-09-15T14:02:00.000Z",
      hooksOk: true,
    },
    firstFrame: null,
    ...overrides,
  };
}

type Reads = {
  state?: Read<OnboardingGate>;
  firstFrame?: Read<FirstFrame>;
  agent?: Read<AgentDetail>;
};

type Calls = {
  state: Parameters<DataSource["onboarding"]["state"]>[];
  firstFrame: Parameters<DataSource["onboarding"]["firstFrame"]>[];
  agent: Parameters<DataSource["agents"]["get"]>[];
};

/** A DataSource that answers the reads a test hands it and refuses every other port. */
export function onboardingSource(reads: Reads): {
  source: DataSource;
  calls: Calls;
} {
  const calls: Calls = { state: [], firstFrame: [], agent: [] };

  const answer = <T>(read: Read<T> | undefined, port: string): Read<T> => {
    if (read === undefined) throw new Error(`${port} has no answer`);
    return read;
  };
  const source: DataSource = refusingSource("Onboarding", {
    onboarding: {
      state: (...args: Parameters<DataSource["onboarding"]["state"]>) => {
        calls.state.push(args);
        return Promise.resolve(answer(reads.state, "onboarding.state"));
      },
      firstFrame: (
        ...args: Parameters<DataSource["onboarding"]["firstFrame"]>
      ) => {
        calls.firstFrame.push(args);
        return Promise.resolve(
          answer(reads.firstFrame, "onboarding.firstFrame"),
        );
      },
    },
    agents: {
      get: (...args: Parameters<DataSource["agents"]["get"]>) => {
        calls.agent.push(args);
        return Promise.resolve(answer(reads.agent, "agents.get"));
      },
    },
  });
  return { source, calls };
}
