import { createHash } from "node:crypto";
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

/**
 * The separator is a NUL byte, and it used to be written into the source as a
 * raw NUL rather than as the escape `\0` (#1416). Raw control bytes make git
 * call the file binary, so its diffs render as `Bin` and ripgrep skips it —
 * the escape is the same byte with none of that. These pin the byte, so a
 * later edit that "tidies" the escape into a visible character (a space, a
 * colon, an empty string) re-keys every id already stored in ClickHouse and
 * fails here instead.
 */
describe("deterministicEventId separator", () => {
  it("joins on U+0000, not on a printable stand-in", () => {
    const rawNul = String.fromCharCode(0);
    const viaRawByte = createHash("sha256")
      .update(["run-1", "emit-telemetry"].join(rawNul))
      .digest("hex");
    const expected = [
      viaRawByte.slice(0, 8),
      viaRawByte.slice(8, 12),
      viaRawByte.slice(12, 16),
      viaRawByte.slice(16, 20),
      viaRawByte.slice(20, 32),
    ].join("-");

    expect(deterministicEventId("run-1", "emit-telemetry")).toBe(expected);
  });

  it("pins the derived id, so the key cannot move unnoticed", () => {
    expect(deterministicEventId("run-1", "emit-telemetry")).toBe(
      "2e441f7c-e886-c1f8-48e1-c0de1a411c7b",
    );
  });
});
