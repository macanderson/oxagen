// This test runs the restart-alarm check over the Terraform files under infra/
// in the live tree. vitest.config.ts leaves `*.tree.test.ts` files out of
// turbo's cached tasks, so `pnpm check:tree-guards` runs them uncached in the
// checks job (#4664 item 2).
import { describe, expect, it } from "vitest";

import { run } from "./check-restart-alarm.mjs";

describe("the repository's own infrastructure", () => {
  // Would still pass on: nothing. This is the assertion the check exists for.
  // The tests in check-restart-alarm.test.ts prove the checker can tell good
  // from bad, and this one asks it about the files that are actually deployed.
  it("has an intact collector -> log group -> metric filter -> alarm chain", () => {
    expect(run()).toEqual([]);
  });
});
