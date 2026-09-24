import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canaryIsVisible,
  CANARY_EVENT_NAME,
  canaryQueryUrl,
  checkKeyPosture,
  unseenCanaryComplaint,
} from "./inngest-verify";

describe("canaryIsVisible", () => {
  it("finds the canary by its public id", () => {
    expect(
      canaryIsVisible(
        [
          { id: "01OTHER", name: "x" },
          { id: "01CANARY", name: CANARY_EVENT_NAME },
        ],
        "01CANARY",
      ),
    ).toBe(true);
  });

  it("finds the canary by its internal id", () => {
    expect(canaryIsVisible([{ internal_id: "01CANARY" }], "01CANARY")).toBe(
      true,
    );
  });

  // The witness for the failure this whole script exists to catch: events sent
  // with an event key from another environment never show up here, and the
  // environment is full of unrelated traffic that must not be mistaken for them.
  it("does not report visible when the environment holds only other events", () => {
    expect(
      canaryIsVisible(
        [
          { id: "01SCHEDULED", name: "inngest/scheduled.timer" },
          { id: "01FINISHED", name: "inngest/function.finished" },
        ],
        "01CANARY",
      ),
    ).toBe(false);
  });

  // A canary from an earlier run carries the same name. Matching on the name
  // would let a mismatched key pair pass forever.
  it("does not accept a previous run's canary", () => {
    expect(
      canaryIsVisible(
        [{ id: "01EARLIER", name: CANARY_EVENT_NAME }],
        "01CANARY",
      ),
    ).toBe(false);
  });

  it("is false for an empty environment", () => {
    expect(canaryIsVisible([], "01CANARY")).toBe(false);
  });
});

describe("canaryQueryUrl", () => {
  // Unfiltered, the endpoint returns the newest events of every name, and a
  // busy production environment pushes the canary out of that page between
  // polls. The deploy of 08ed1170e failed that way with keys that had passed
  // 23 minutes earlier.
  it("asks only for canaries, received since shortly before this one was sent", () => {
    const url = new URL(canaryQueryUrl(new Date("2026-09-24T15:35:05.000Z")));
    expect(url.origin + url.pathname).toBe("https://api.inngest.com/v1/events");
    expect(url.searchParams.get("name")).toBe(CANARY_EVENT_NAME);
    expect(url.searchParams.get("received_after")).toBe(
      "2026-09-24T15:30:05.000Z",
    );
    expect(url.searchParams.get("limit")).toBe("100");
  });
});

describe("unseenCanaryComplaint", () => {
  it("reports a key mismatch when the API answered and the canary never appeared", () => {
    const message = unseenCanaryComplaint("01CANARY", null, true);
    expect(message).toContain("01CANARY");
    expect(message).toContain("belong to different Inngest environments");
  });

  // Every query failing says nothing about the keys. Calling it a mismatch
  // would send someone to rotate a pair that works.
  it("does not blame the keys when no query was answered", () => {
    const message = unseenCanaryComplaint("01CANARY", 503, false);
    expect(message).toContain("last status 503");
    expect(message).toContain("whether the keys agree is unknown");
    expect(message).not.toContain("different Inngest environments");
  });
});

describe("production signing key posture", () => {
  it("sets production mode on the deploy verification step", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/pipeline.yml", import.meta.url),
      "utf8",
    );
    const step = workflow
      .split("- name: Sync Inngest functions and verify the key pair")[1]
      ?.split(/\n      - /)[0];
    expect(step).toMatch(/env:\s*\n\s*NODE_ENV: production/);
    expect(step).toContain("pnpm inngest:verify");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses a test signing key in the deploy environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("verification refused");
    });
    expect(() => checkKeyPosture("signkey-test-example")).toThrow(
      "verification refused",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
