// get_onboarding_state and get_first_frame outputs to the onboarding view
// models (ARCHITECTURE.md §3.4). Typed from each contract's `_output`, so a
// field the contract may omit cannot land in a required view field;
// mappers.type-test.ts holds the reverse direction.
import type { onboardingFirstFrameGet } from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import type { onboardingStateGet } from "@oxagen/oxagen/contracts/onboarding.state.get";
import type { z } from "zod";
import type { FirstFrame, OnboardingGate } from "@/data/contracts/onboarding";
import type { ContractOutput } from "@/server/kernel";

export function toOnboardingGate(
  out: ContractOutput<typeof onboardingStateGet>,
): z.input<typeof OnboardingGate> {
  return {
    step: out.step,
    workspace:
      out.workspace === null
        ? null
        : { id: out.workspace.id, slug: out.workspace.slug },
    firstFrameAt: out.firstFrameAt,
    firstRunId: out.firstRunId,
    provisional:
      out.provisional === null
        ? null
        : {
            until: out.provisional.until,
            mainRepoBoundAt: out.provisional.mainRepoBoundAt,
            detectedRepository:
              out.provisional.detectedRepository === null
                ? null
                : {
                    provider: out.provisional.detectedRepository.provider,
                    owner: out.provisional.detectedRepository.owner,
                    name: out.provisional.detectedRepository.name,
                  },
          },
  };
}

export function toFirstFrame(
  out: ContractOutput<typeof onboardingFirstFrameGet>,
): z.input<typeof FirstFrame> {
  return {
    agentId: out.agentId,
    agentKey: out.agentKey,
    host:
      out.host === null
        ? null
        : {
            hostEnrollmentId: out.host.hostEnrollmentId,
            enrolledAt: out.host.enrolledAt,
            lastHeartbeatAt: out.host.lastHeartbeatAt,
            hooksOk: out.host.hooksOk,
          },
    firstFrame:
      out.firstFrame === null
        ? null
        : {
            runId: out.firstFrame.runId,
            receivedAt: out.firstFrame.receivedAt,
          },
  };
}
