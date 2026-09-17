// The onboarding mappers over the shapes their contracts answer with: every
// field the gate and the first-frame read carry, and a null wherever the
// contract recorded nothing.
import { describe, expect, it } from "vitest";
import { FirstFrame, OnboardingGate } from "@/data/contracts/onboarding";
import { toFirstFrame, toOnboardingGate } from "./onboarding";

describe("toOnboardingGate", () => {
  it("carries the step, the workspace, the first frame and the provisional window", () => {
    const view = toOnboardingGate({
      step: "run",
      workspace: { id: "wrk_core", slug: "core-platform" },
      firstFrameAt: "2026-09-15T14:02:11.000Z",
      firstRunId: "tse_first",
      provisional: {
        until: "2026-09-29T00:00:00.000Z",
        mainRepoBoundAt: null,
        detectedRepository: {
          provider: "github",
          owner: "acme",
          name: "platform",
        },
      },
    });
    expect(OnboardingGate.parse(view)).toEqual({
      step: "run",
      workspace: { id: "wrk_core", slug: "core-platform" },
      firstFrameAt: "2026-09-15T14:02:11.000Z",
      firstRunId: "tse_first",
      provisional: {
        until: "2026-09-29T00:00:00.000Z",
        mainRepoBoundAt: null,
        detectedRepository: {
          provider: "github",
          owner: "acme",
          name: "platform",
        },
      },
    });
  });

  it("keeps an organization that predates the gate empty rather than inventing a window", () => {
    const view = toOnboardingGate({
      step: "unlocked",
      workspace: null,
      firstFrameAt: null,
      firstRunId: null,
      provisional: null,
    });
    expect(OnboardingGate.parse(view)).toEqual({
      step: "unlocked",
      workspace: null,
      firstFrameAt: null,
      firstRunId: null,
      provisional: null,
    });
  });

  it("keeps a window with no reported remote as a null repository", () => {
    const view = toOnboardingGate({
      step: "wrap",
      workspace: { id: "wrk_core", slug: "core-platform" },
      firstFrameAt: null,
      firstRunId: null,
      provisional: {
        until: "2026-09-29T00:00:00.000Z",
        mainRepoBoundAt: "2026-09-16T00:00:00.000Z",
        detectedRepository: null,
      },
    });
    const gate = OnboardingGate.parse(view);
    expect(gate.provisional?.detectedRepository).toBeNull();
    expect(gate.provisional?.mainRepoBoundAt).toBe("2026-09-16T00:00:00.000Z");
  });
});

describe("toFirstFrame", () => {
  it("carries the host and the frame the ingest stored", () => {
    const view = toFirstFrame({
      agentId: "agt_releasebot",
      agentKey: "acme.core.release-bot",
      host: {
        hostEnrollmentId: "tch_mbp",
        enrolledAt: "2026-09-15T14:01:48.000Z",
        lastHeartbeatAt: "2026-09-15T14:02:00.000Z",
        hooksOk: true,
      },
      firstFrame: {
        runId: "tse_first",
        receivedAt: "2026-09-15T14:02:11.000Z",
      },
    });
    expect(FirstFrame.parse(view)).toEqual({
      agentId: "agt_releasebot",
      agentKey: "acme.core.release-bot",
      host: {
        hostEnrollmentId: "tch_mbp",
        enrolledAt: "2026-09-15T14:01:48.000Z",
        lastHeartbeatAt: "2026-09-15T14:02:00.000Z",
        hooksOk: true,
      },
      firstFrame: {
        runId: "tse_first",
        receivedAt: "2026-09-15T14:02:11.000Z",
      },
    });
  });

  it("keeps a host that has not reported and a wait with no frame as nulls", () => {
    const view = toFirstFrame({
      agentId: "agt_releasebot",
      agentKey: null,
      host: {
        hostEnrollmentId: "tch_mbp",
        enrolledAt: "2026-09-15T14:01:48.000Z",
        lastHeartbeatAt: null,
        hooksOk: null,
      },
      firstFrame: null,
    });
    const frame = FirstFrame.parse(view);
    expect(frame.agentKey).toBeNull();
    expect(frame.host?.hooksOk).toBeNull();
    expect(frame.host?.lastHeartbeatAt).toBeNull();
    expect(frame.firstFrame).toBeNull();
  });

  it("keeps an agent with no host enrolled as a null host", () => {
    const view = toFirstFrame({
      agentId: "agt_releasebot",
      agentKey: "acme.core.release-bot",
      host: null,
      firstFrame: null,
    });
    expect(FirstFrame.parse(view).host).toBeNull();
  });
});
