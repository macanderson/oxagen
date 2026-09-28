// The seam `@oxagen/handlers/register` fills at boot (lane S2, #4560). The
// module holds one runner and offers no way to remove it, so every test loads
// a fresh copy of the module.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SteeringRepoHealthRunner } from "./steering-repo-health-runner";

type Seam = typeof import("./steering-repo-health-runner");

const NO_RUNNER =
  "[steering-repo.health] no health runner is installed. Import @oxagen/handlers/register before serving Inngest functions.";

async function freshSeam(): Promise<Seam> {
  return import("./steering-repo-health-runner");
}

function fakeRunner(health: string): SteeringRepoHealthRunner {
  return {
    sweepRequests: async () => [],
    check: async () => ({ health }),
  };
}

const SCOPE = { orgId: "org-1", workspaceId: null };
const TRIGGER = {
  reason: "sweep",
  actor: null,
  at: null,
  settings: [],
  pull_request: null,
};

beforeEach(() => {
  vi.resetModules();
});

describe("steering repo health runner", () => {
  it("throws on every read in a process that installed no runner", async () => {
    // A worker that booted without @oxagen/handlers/register fails on its
    // first run, and the message names the import that fixes it.
    const seam = await freshSeam();
    expect(() => seam.steeringRepoHealthRunner()).toThrow(NO_RUNNER);
    expect(() => seam.steeringRepoHealthRunner()).toThrow(NO_RUNNER);
  });

  it("returns the installed runner on every read", async () => {
    const seam = await freshSeam();
    const installed = fakeRunner("healthy");
    seam.setSteeringRepoHealthRunner(installed);
    expect(seam.steeringRepoHealthRunner()).toBe(installed);
    expect(seam.steeringRepoHealthRunner()).toBe(installed);
  });

  it("replaces an earlier runner with the one installed last", async () => {
    const seam = await freshSeam();
    const earlier = fakeRunner("healthy");
    const later = fakeRunner("drifted");
    seam.setSteeringRepoHealthRunner(earlier);
    seam.setSteeringRepoHealthRunner(later);
    expect(seam.steeringRepoHealthRunner()).toBe(later);
    await expect(
      seam.steeringRepoHealthRunner().check(SCOPE, TRIGGER),
    ).resolves.toEqual({ health: "drifted" });
  });
});
