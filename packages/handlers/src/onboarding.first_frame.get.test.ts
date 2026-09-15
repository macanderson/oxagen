import { isHandlerError } from "@oxagen/oxagen";
import { describe, expect, it, vi } from "vitest";
import {
  createFirstFrameGetHandler,
  type FirstFrameHost,
  type FirstFrameQueries,
  type FirstFrameSession,
} from "./onboarding.first_frame.get";
import { POLL_INTERVAL_MS } from "./run.get";
import { makeCTX } from "./test-utils/fixtures";

const AGENT = {
  id: "agent-uuid",
  publicId: "agt_0123456789",
  agentKey: "acme.core.release-manager",
};
const HOST: FirstFrameHost = {
  id: "host-uuid",
  publicId: "tch_0123456789abcdefghjkmn",
  createdAt: new Date("2026-09-15T12:00:00.000Z"),
  lastHeartbeatAt: null,
  hooksOk: null,
};
const SESSION: FirstFrameSession = {
  publicId: "tse_0123456789",
  receivedAt: new Date("2026-09-15T12:00:30.000Z"),
};

/** A fake store whose host and session appear after a number of reads, on a clock the sleeps advance. */
function harness(opts: { hostAfter: number; sessionAfter: number }) {
  let reads = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const queries: FirstFrameQueries = {
    agent: vi.fn(async (_scope, id) => (id === AGENT.publicId ? AGENT : null)),
    host: vi.fn(async () => {
      reads += 1;
      return reads > opts.hostAfter ? HOST : null;
    }),
    firstSession: vi.fn(async () =>
      reads > opts.sessionAfter ? SESSION : null,
    ),
  };
  const handler = createFirstFrameGetHandler({
    queries,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { handler, queries, sleeps, reads: () => reads };
}

describe("get_first_frame", () => {
  it("refuses an agent the workspace does not hold", async () => {
    const { handler } = harness({ hostAfter: 0, sessionAfter: 0 });
    await expect(
      handler({ agentId: "agt_unknown", waitMs: 0 }, makeCTX()),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "not_found" &&
        e.reason === "agent_not_found",
    );
  });

  it("answers no host and no frame at once when the budget is zero", async () => {
    const { handler, sleeps } = harness({ hostAfter: 5, sessionAfter: 5 });
    const out = await handler(
      { agentId: AGENT.publicId, waitMs: 0 },
      makeCTX(),
    );
    expect(out).toEqual({
      agentId: AGENT.publicId,
      agentKey: AGENT.agentKey,
      host: null,
      firstFrame: null,
    });
    expect(sleeps).toEqual([]);
  });

  it("reports the enrolled host while the first frame is still to come", async () => {
    const { handler } = harness({ hostAfter: 0, sessionAfter: 99 });
    const out = await handler(
      { agentId: AGENT.publicId, waitMs: 0 },
      makeCTX(),
    );
    expect(out.host).toEqual({
      hostEnrollmentId: HOST.publicId,
      enrolledAt: "2026-09-15T12:00:00.000Z",
      lastHeartbeatAt: null,
      hooksOk: null,
    });
    expect(out.firstFrame).toBeNull();
  });

  it("long-polls until the first frame lands, then answers without waiting further", async () => {
    const { handler, sleeps, reads } = harness({
      hostAfter: 0,
      sessionAfter: 3,
    });
    const out = await handler(
      { agentId: AGENT.publicId, waitMs: 5_000 },
      makeCTX(),
    );
    expect(out.firstFrame).toEqual({
      runId: SESSION.publicId,
      receivedAt: "2026-09-15T12:00:30.000Z",
    });
    expect(reads()).toBe(4);
    expect(sleeps).toEqual([
      POLL_INTERVAL_MS,
      POLL_INTERVAL_MS,
      POLL_INTERVAL_MS,
    ]);
  });

  it("never completes on a timer: an exhausted budget answers null and stops sleeping", async () => {
    const { handler, sleeps } = harness({ hostAfter: 0, sessionAfter: 99 });
    const out = await handler(
      { agentId: AGENT.publicId, waitMs: 1_200 },
      makeCTX(),
    );
    expect(out.firstFrame).toBeNull();
    expect(sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, 200]);
  });
});
