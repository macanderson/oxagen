import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canaryIsVisible,
  CANARY_EVENT_NAME,
  checkKeyPosture,
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
