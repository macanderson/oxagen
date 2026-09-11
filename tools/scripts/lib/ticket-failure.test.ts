import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isPermanentTicketFailure,
  reportTicketFailure,
  ticketFailureReport,
  type TicketContext,
} from "./ticket-failure";

const CONTEXT: TicketContext = {
  what: "manifest parity tickets",
  consequence: "every capability-parity gap found from here on goes untracked",
  issue: "#2556",
};

describe("isPermanentTicketFailure", () => {
  it("treats a rejected credential as permanent", () => {
    // Permanent means every future run fails identically until somebody acts.
    // That wants louder wording than a blip, which is the whole distinction.
    for (const message of [
      "Authentication required",
      "not authenticated",
      "Unauthorized",
      "invalid api key",
      "Forbidden",
      "Request failed with status 401",
      "Request failed with status 403",
    ]) {
      expect(
        isPermanentTicketFailure(new Error(message)),
        `${message} should read as permanent`,
      ).toBe(true);
    }
  });

  it("treats a network blip or a server error as transient", () => {
    for (const message of [
      "fetch failed",
      "socket hang up",
      "Request failed with status 502",
      "ETIMEDOUT",
    ]) {
      expect(
        isPermanentTicketFailure(new Error(message)),
        `${message} should read as transient`,
      ).toBe(false);
    }
  });

  it("handles a thrown non-Error without crashing", () => {
    // A reporter that throws while reporting a failure is the failure mode this
    // module exists to prevent, one level up.
    expect(() => isPermanentTicketFailure("unauthorized")).not.toThrow();
    expect(isPermanentTicketFailure("unauthorized")).toBe(true);
    expect(isPermanentTicketFailure(undefined)).toBe(false);
  });
});

describe("ticketFailureReport", () => {
  it("names what was not filed, and why it matters, for a permanent failure", () => {
    const { annotation, summary } = ticketFailureReport(
      CONTEXT,
      new Error("Unauthorized"),
    );
    expect(annotation).toContain("::error");
    expect(annotation).toContain("manifest parity tickets");
    expect(annotation).toContain("Unauthorized");
    expect(summary).toContain("rejected credential, not a blip");
    expect(summary).toContain("goes untracked");
    expect(summary).toContain("#2556");
  });

  it("words a transient failure differently", () => {
    const { summary } = ticketFailureReport(CONTEXT, new Error("fetch failed"));
    expect(summary).toContain("one-off");
    expect(summary).not.toContain("rejected credential, not a blip");
  });
});

describe("reportTicketFailure", () => {
  const originalSummary = process.env["GITHUB_STEP_SUMMARY"];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalSummary === undefined)
      delete process.env["GITHUB_STEP_SUMMARY"];
    else process.env["GITHUB_STEP_SUMMARY"] = originalSummary;
  });

  it("prints the annotation to stdout, where Actions reads it", () => {
    // stdout, not stderr: GitHub parses annotations from stdout. Printing to
    // stderr would look right in a log and reach nobody on the run page.
    delete process.env["GITHUB_STEP_SUMMARY"];
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    reportTicketFailure(CONTEXT, new Error("Unauthorized"));

    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]?.[0]).toContain("::error title=");
  });

  it("does not throw when the summary file cannot be written", () => {
    // A summary that cannot be written must not become a second failure — that
    // would reintroduce the silence this module removes.
    process.env["GITHUB_STEP_SUMMARY"] =
      "/proc/nonexistent/definitely-not-here";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      reportTicketFailure(CONTEXT, new Error("Unauthorized")),
    ).not.toThrow();
  });

  it("skips the summary when Actions did not provide one", () => {
    delete process.env["GITHUB_STEP_SUMMARY"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      reportTicketFailure(CONTEXT, new Error("fetch failed")),
    ).not.toThrow();
  });
});
