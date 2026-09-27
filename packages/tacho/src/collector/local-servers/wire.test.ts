import { describe, expect, it } from "vitest";
import { launchSpecSchema } from "./index";
import { npmLaunch } from "./test-support";

/** An npm launch with count arguments. */
function launchWithArgs(count: number) {
  return npmLaunch({ args: Array.from({ length: count }, (_, index) => `--arg-${index}`) });
}

describe("launchSpecSchema", () => {
  it("takes as many args as the lock allows a registry package, and no more", () => {
    expect(launchSpecSchema.safeParse(launchWithArgs(1024)).success).toBe(true);
    expect(launchSpecSchema.safeParse(launchWithArgs(1025)).success).toBe(false);
  });
});
