import { describe, expect, it, vi } from "vitest";
import { createGhTargetPoller, type Exec } from "../default-poller.js";
import type { MonitorDispatchInput } from "../types.js";

/** A never-aborted signal for the happy path. */
const liveSignal = new AbortController().signal;

function target(patch: Partial<MonitorDispatchInput> = {}): MonitorDispatchInput {
  return { targetType: "gh_actions_run", targetId: "123", pollIntervalSeconds: 0, ...patch };
}

describe("createGhTargetPoller", () => {
  it("resolves succeeded when gh reports a successful conclusion", async () => {
    const exec: Exec = vi.fn(async () =>
      JSON.stringify({ status: "completed", conclusion: "success" }),
    );
    const poll = createGhTargetPoller({ exec });
    await expect(poll(target(), liveSignal)).resolves.toEqual({ status: "succeeded" });
    expect(exec).toHaveBeenCalledWith("gh", ["run", "view", "123", "--json", "status,conclusion"], {
      signal: liveSignal,
    });
  });

  it("resolves failed with identifiedProblem when the conclusion is a failure", async () => {
    const exec: Exec = async () => JSON.stringify({ status: "completed", conclusion: "failure" });
    const poll = createGhTargetPoller({ exec });
    const r = await poll(target(), liveSignal);
    expect(r.status).toBe("failed");
    expect(r.identifiedProblem).toBe(true);
    expect(r.note).toContain("failure");
  });

  it("keeps polling while the run is still in flight, then resolves on the terminal check", async () => {
    const exec: Exec = vi
      .fn<Exec>()
      .mockResolvedValueOnce(JSON.stringify({ status: "in_progress" }))
      .mockResolvedValueOnce(JSON.stringify({ status: "completed", conclusion: "success" }));
    const poll = createGhTargetPoller({ exec });
    await expect(poll(target(), liveSignal)).resolves.toEqual({ status: "succeeded" });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("treats a merged pull request as succeeded", async () => {
    const exec: Exec = async () => JSON.stringify({ state: "merged" });
    const poll = createGhTargetPoller({ exec });
    await expect(
      poll(target({ targetType: "pull_request", targetId: "42" }), liveSignal),
    ).resolves.toEqual({ status: "succeeded" });
  });

  it("uses the pr subcommand for a pull_request target", async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(JSON.stringify({ state: "closed" }));
    const poll = createGhTargetPoller({ exec });
    await poll(target({ targetType: "pull_request", targetId: "7" }), liveSignal);
    expect(exec).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "7", "--json", "state,statusCheckRollup"],
      { signal: liveSignal },
    );
  });

  it("reports failed on non-JSON gh output", async () => {
    const exec: Exec = async () => "not json at all";
    const poll = createGhTargetPoller({ exec });
    const r = await poll(target(), liveSignal);
    expect(r.status).toBe("failed");
    expect(r.identifiedProblem).toBe(false);
    expect(r.note).toContain("not valid JSON");
  });

  it("returns an aborted failure when the signal is already aborted", async () => {
    const exec = vi.fn<Exec>();
    const poll = createGhTargetPoller({ exec });
    const r = await poll(target(), AbortSignal.abort());
    expect(r).toEqual({ status: "failed", identifiedProblem: false, note: "monitor poll aborted" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports failed with no conclusion when terminal but not successful", async () => {
    const exec: Exec = async () => JSON.stringify({ status: "completed", conclusion: null });
    const poll = createGhTargetPoller({ exec });
    const r = await poll(target(), liveSignal);
    expect(r.status).toBe("failed");
    expect(r.identifiedProblem).toBe(false);
    expect(r.note).toContain("no success conclusion");
  });
});
