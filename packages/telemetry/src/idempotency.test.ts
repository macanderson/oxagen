import { describe, expect, it } from "vitest";
import { deterministicEventId } from "./idempotency";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("deterministicEventId", () => {
  it("returns a UUID-formatted string", () => {
    const id = deterministicEventId("run-1", "emit-step-telemetry-step-1");
    expect(id).toMatch(UUID_RE);
  });

  it("is stable across repeated calls with the same inputs", () => {
    const a = deterministicEventId("run-1", "emit-step-telemetry-step-1");
    const b = deterministicEventId("run-1", "emit-step-telemetry-step-1");
    expect(a).toBe(b);
  });

  it("differs when any input part changes", () => {
    const base = deterministicEventId("run-1", "emit-step-telemetry-step-1");
    const differentRun = deterministicEventId(
      "run-2",
      "emit-step-telemetry-step-1",
    );
    const differentStep = deterministicEventId(
      "run-1",
      "emit-step-telemetry-step-2",
    );
    expect(differentRun).not.toBe(base);
    expect(differentStep).not.toBe(base);
    expect(differentRun).not.toBe(differentStep);
  });

  it("never collides between adjacent-looking part boundaries", () => {
    // "a" + "bc" vs "ab" + "c" — a naive plain-concat join would collide.
    const first = deterministicEventId("a", "bc");
    const second = deterministicEventId("ab", "c");
    expect(first).not.toBe(second);
  });
});
