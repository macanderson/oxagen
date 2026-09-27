// The seam `@oxagen/handlers/register` fills at boot (lane S1, #4450). The
// module holds one runner and offers no way to remove it, so every test loads
// a fresh copy of the module.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SteeringRepoProvisionRunner } from "./steering-repo-provision-runner";

type Seam = typeof import("./steering-repo-provision-runner");

const NO_RUNNER =
  "[steering-repo.provision] no provision runner is installed. Import @oxagen/handlers/register before serving Inngest functions.";

async function freshSeam(): Promise<Seam> {
  return import("./steering-repo-provision-runner");
}

function fakeRunner(first: string): SteeringRepoProvisionRunner {
  return {
    steps: async () => [first],
    runStep: async (_scope, step) => ({
      step,
      status: "provisioning",
      ran: true,
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("steering repo provision runner", () => {
  it("throws on every read in a process that installed no runner", async () => {
    // A worker that booted without @oxagen/handlers/register fails on its
    // first run, and the message names the import that fixes it.
    const seam = await freshSeam();
    expect(() => seam.steeringRepoProvisionRunner()).toThrow(NO_RUNNER);
    expect(() => seam.steeringRepoProvisionRunner()).toThrow(NO_RUNNER);
  });

  it("returns the installed runner on every read", async () => {
    const seam = await freshSeam();
    const installed = fakeRunner("pick_connection");
    seam.setSteeringRepoProvisionRunner(installed);
    expect(seam.steeringRepoProvisionRunner()).toBe(installed);
    expect(seam.steeringRepoProvisionRunner()).toBe(installed);
  });

  it("replaces an earlier runner with the one installed last", async () => {
    const seam = await freshSeam();
    const earlier = fakeRunner("pick_connection");
    const later = fakeRunner("create_repository");
    seam.setSteeringRepoProvisionRunner(earlier);
    seam.setSteeringRepoProvisionRunner(later);
    expect(seam.steeringRepoProvisionRunner()).toBe(later);
    await expect(seam.steeringRepoProvisionRunner().steps()).resolves.toEqual([
      "create_repository",
    ]);
  });
});
