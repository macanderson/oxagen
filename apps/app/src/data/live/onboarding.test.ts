// The onboarding port: each method is one kernelRead of its contract with the
// agent and the wait it was asked for, mapped into its view, with a refusal
// passed through and an unmappable record reported once.
import { onboardingFirstFrameGet } from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import { onboardingStateGet } from "@oxagen/oxagen/contracts/onboarding.state.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { onboarding } = await import("./onboarding");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "agent.register",
} as const;

const stateOut = {
  step: "wrap",
  workspace: { id: "wrk_core", slug: "core-platform" },
  firstFrameAt: null,
  firstRunId: null,
  provisional: {
    until: "2026-09-29T00:00:00.000Z",
    mainRepoBoundAt: null,
    detectedRepository: { provider: "github", owner: "acme", name: "platform" },
  },
};

const frameOut = {
  agentId: "agt_releasebot",
  agentKey: "acme.core.release-bot",
  host: {
    hostEnrollmentId: "tch_mbp",
    enrolledAt: "2026-09-15T14:01:48.000Z",
    lastHeartbeatAt: null,
    hooksOk: null,
  },
  firstFrame: {
    runId: "tse_first",
    receivedAt: "2026-09-15T14:02:11.000Z",
  },
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("onboarding.state", () => {
  it("reads get_onboarding_state for the viewer's organization and maps the gate", async () => {
    kernelRead.mockResolvedValue(readOk(stateOut));
    expect(await onboarding.state(ctx)).toEqual(readOk(stateOut));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: onboardingStateGet,
      input: {},
      page: "onboarding",
    });
  });

  it("passes a refusal through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await onboarding.state(ctx)).toEqual(DENIED);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once when the gate does not parse (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...stateOut, workspace: { id: "not-a-public-id", slug: "x" } }),
    );
    expect(await onboarding.state(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("onboarding.firstFrame", () => {
  it("reads get_first_frame for the agent with the wait it was given", async () => {
    kernelRead.mockResolvedValue(readOk(frameOut));
    expect(
      await onboarding.firstFrame(ctx, "agt_releasebot", { waitMs: 20_000 }),
    ).toEqual(readOk(frameOut));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: onboardingFirstFrameGet,
      input: { agentId: "agt_releasebot", waitMs: 20_000 },
      page: "onboarding",
    });
  });

  it("keeps a wait that ended with no frame as a value, not a failure", async () => {
    kernelRead.mockResolvedValue(readOk({ ...frameOut, firstFrame: null }));
    const read = await onboarding.firstFrame(ctx, "agt_releasebot", {
      waitMs: 0,
    });
    expect(read.ok && read.value.firstFrame).toBeNull();
  });

  it("passes a refusal through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(
      await onboarding.firstFrame(ctx, "agt_releasebot", { waitMs: 0 }),
    ).toEqual(DENIED);
  });

  it("answers record_unmappable and reports once when the frame does not parse (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...frameOut, firstFrame: { runId: "", receivedAt: "nope" } }),
    );
    expect(
      await onboarding.firstFrame(ctx, "agt_releasebot", { waitMs: 0 }),
    ).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
