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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failureReport,
  isPermanentFailure,
} from "./ensure-e2e-failure-ticket.js";

/**
 * `main()` reads its config into top-level consts when the module is
 * imported, so each scenario needs its own fresh module instance with
 * `process.env` set before import — otherwise every test would share
 * whichever env was live when the file was first imported.
 */
const ORIGINAL_ENV = { ...process.env };

async function freshMain(env: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("./ensure-e2e-failure-ticket.js");
  return mod.main;
}

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

describe("main() (#2555)", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("no LINEAR_API_KEY: silent no-op, never calls Linear (a fork's default)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const main = await freshMain({
      LINEAR_API_KEY: undefined,
      LINEAR_PROJECT_ID: "proj-1",
    });

    await expect(main()).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no LINEAR_PROJECT_ID: also a silent no-op", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const main = await freshMain({
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_PROJECT_ID: undefined,
    });

    await expect(main()).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("key present, no existing tracker: creates a new ticket and succeeds", async () => {
    const responses = [
      // findTracker — nothing open yet.
      { data: { issues: { nodes: [] } } },
      // resolveContext — project + team + labels.
      {
        data: {
          project: { id: "proj-uuid", teams: { nodes: [{ id: "team-1" }] } },
          issueLabels: { nodes: [] },
        },
      },
      // createTracker — the mutation succeeds.
      {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-1",
              identifier: "OX-9",
              url: "https://linear.app/issue/OX-9",
            },
          },
        },
      },
    ];
    let call = 0;
    const fetchSpy = vi.fn(async () => ({
      json: async () => responses[call++],
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const main = await freshMain({
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_PROJECT_ID: "proj-1",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "abcdef1234567890",
    });

    await expect(main()).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("key present, tracker already open: appends a comment instead of duplicating", async () => {
    const responses = [
      // findTracker — an existing open tracker carrying the hidden marker.
      {
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "OX-9",
                url: "https://linear.app/issue/OX-9",
                description: "<!-- oxagen:e2e-failure-tracker v1 -->\nbody",
                state: { type: "unstarted" },
              },
            ],
          },
        },
      },
      // appendComment — the mutation succeeds.
      { data: { commentCreate: { success: true } } },
    ];
    let call = 0;
    const fetchSpy = vi.fn(async () => ({
      json: async () => responses[call++],
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const main = await freshMain({
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_PROJECT_ID: "proj-1",
    });

    await expect(main()).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
