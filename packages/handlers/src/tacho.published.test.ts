// tacho.published.test.ts: the Tacho published port reads for a host, never
// for a run.
//
// The port reads the version published now, and a run has to read the
// versions its request manifest names (#4447). The fence is the port's scope
// type, whose run id is `null`. Binding the port where search_steering or
// read_steering expects `ReadPublished` fails to compile. CI's typecheck
// reads the `@ts-expect-error` lines below, so an unused directive fails it
// the day that fence opens.
import { describe, expect, it } from "vitest";
import type { SteeringReadDeps } from "./steering.read";
import type { SteeringSearchDeps } from "./steering.search";
import {
  type HostScope,
  NOTHING_PUBLISHED,
  VERSION_STORE_PUBLISHED,
} from "./tacho.published";

describe("TachoPublished", () => {
  it("cannot bind as a run-scoped reader", () => {
    // @ts-expect-error search_steering needs a run's pins, which the port ignores.
    const search: SteeringSearchDeps["published"] =
      VERSION_STORE_PUBLISHED.published;
    // @ts-expect-error read_steering needs a run's pins, which the port ignores.
    const read: SteeringReadDeps["published"] =
      VERSION_STORE_PUBLISHED.published;
    expect([search, read]).toHaveLength(2);
  });

  it("answers a host scope", async () => {
    const scope: HostScope = {
      orgId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      runId: null,
    };
    await expect(NOTHING_PUBLISHED.published(scope)).resolves.toEqual({
      workspace: null,
      organization: null,
    });
  });
});
