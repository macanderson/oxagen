import { describe, expect, it } from "vitest";
import { onboardingFirstFrameGet } from "./onboarding.first_frame.get";
import { WAIT_MS_MAX } from "./run.get";

const WAITING = {
  agentId: "agt_0123456789",
  agentKey: "acme.core.release-manager",
  host: {
    hostEnrollmentId: "tch_0123456789abcdefghjkmn",
    enrolledAt: "2026-09-15T12:00:00.000Z",
    lastHeartbeatAt: null,
    hooksOk: null,
  },
  firstFrame: null,
};

describe("get_first_frame contract", () => {
  it("is a scoped console read with the long-poll budget get_run takes", () => {
    expect(onboardingFirstFrameGet.scoped).toBe(true);
    expect(onboardingFirstFrameGet.mutates).toBe(false);
    expect(onboardingFirstFrameGet.noBillingGate).toBe(true);
    expect(
      onboardingFirstFrameGet.input.parse({ agentId: "agt_0123456789" }),
    ).toEqual({ agentId: "agt_0123456789", waitMs: 0 });
    expect(
      onboardingFirstFrameGet.input.safeParse({
        agentId: "agt_0123456789",
        waitMs: WAIT_MS_MAX + 1,
      }).success,
    ).toBe(false);
    expect(
      onboardingFirstFrameGet.input.safeParse({ agentId: "release-manager" })
        .success,
    ).toBe(false);
  });

  it("answers no host, a host with nothing reported yet, and the first frame as a tse_ run", () => {
    expect(
      onboardingFirstFrameGet.output.parse({
        ...WAITING,
        host: null,
        agentKey: null,
      }).host,
    ).toBeNull();
    expect(onboardingFirstFrameGet.output.parse(WAITING)).toEqual(WAITING);
    const arrived = {
      ...WAITING,
      host: {
        ...WAITING.host,
        lastHeartbeatAt: "2026-09-15T12:00:20.000Z",
        hooksOk: true,
      },
      firstFrame: {
        runId: "tse_0123456789",
        receivedAt: "2026-09-15T12:00:30.000Z",
      },
    };
    expect(onboardingFirstFrameGet.output.parse(arrived)).toEqual(arrived);
    expect(
      onboardingFirstFrameGet.output.safeParse({
        ...WAITING,
        firstFrame: {
          runId: "arun_0123456789",
          receivedAt: "2026-09-15T12:00:30.000Z",
        },
      }).success,
    ).toBe(false);
  });
});
