/**
 * The rejected-key path (#2555).
 *
 * The nightly step logged `FAILED:` and exited 0, so GitHub showed a green
 * step and the only way to learn no ticket had been filed was to open a passing
 * step's log. The key had been rejected for weeks and nothing said so.
 *
 * Exiting 0 stays: the e2e job's conclusion belongs to the tests, and a Linear
 * outage must not turn a green suite red. What changed is that the failure now
 * leaves an annotation on the run summary, and says whether it will happen
 * again tomorrow.
 */
import { describe, expect, it } from "vitest";
import {
  failureReport,
  isPermanentFailure,
} from "./ensure-e2e-failure-ticket.js";

describe("isPermanentFailure (#2555)", () => {
  it("calls a rejected credential permanent", () => {
    // The exact string from run 33411908766, which is what went unnoticed.
    expect(
      isPermanentFailure(
        new Error(
          "Linear GraphQL error: Authentication required, not authenticated",
        ),
      ),
    ).toBe(true);
    expect(isPermanentFailure(new Error("401 Unauthorized"))).toBe(true);
    expect(isPermanentFailure(new Error("Forbidden"))).toBe(true);
  });

  it("calls a blip transient", () => {
    // The control. If everything read as permanent, the distinction the fix
    // exists to draw would be decorative.
    expect(isPermanentFailure(new Error("fetch failed: ETIMEDOUT"))).toBe(
      false,
    );
    expect(isPermanentFailure(new Error("502 Bad Gateway"))).toBe(false);
  });

  it("does not throw on a non-Error", () => {
    expect(isPermanentFailure("something odd")).toBe(false);
  });
});

describe("failureReport (#2555)", () => {
  const rejected = new Error(
    "Linear GraphQL error: Authentication required, not authenticated",
  );

  it("emits a GitHub error annotation, which is what a green step cannot hide", () => {
    const { annotation } = failureReport(rejected);
    expect(annotation.startsWith("::error ")).toBe(true);
    // The reason has to travel with it — an annotation saying only "failed"
    // sends the reader back to the log this exists to replace.
    expect(annotation).toContain("not authenticated");
  });

  it("says a rejected key will keep failing, and a blip will not", () => {
    expect(failureReport(rejected).summary).toContain("until someone fixes");
    expect(failureReport(rejected).summary).toContain("#2555");
    const blip = failureReport(new Error("ETIMEDOUT")).summary;
    expect(blip).toContain("one-off");
    expect(blip).not.toContain("until someone fixes");
  });

  it("writes plain sentences, not jargon", () => {
    // The issue's own last DoD item.
    const { summary } = failureReport(rejected);
    expect(summary).toContain("was NOT filed");
    expect(summary).not.toMatch(/idempotenc|telemetry sink|observability/i);
  });
});
