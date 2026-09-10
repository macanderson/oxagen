import { describe, expect, it } from "vitest";
import { canaryIsVisible, CANARY_EVENT_NAME } from "./inngest-verify";

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
