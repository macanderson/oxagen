/**
 * dispatch-settings.ts — the REPL's Dispatch-mode preference round-trip.
 *
 * The settings tiers themselves are covered by the settings package's own
 * suite, so both seams are stubbed here. What this file pins is the coercion
 * layer dispatch-settings owns: which persisted shapes are trusted, which fall
 * back to the default cap, and the clamping applied on the way out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DISPATCH_DEFAULT_CAP,
  loadDispatchSettings,
  persistDispatchMode,
  persistDispatchCap,
} from "../dispatch-settings.js";

const stubs = vi.hoisted(() => ({
  loadSettings:
    vi.fn<(opts: { cwd: string }) => { settings: Record<string, unknown> }>(),
  writeSettingsValue:
    vi.fn<
      (opts: {
        scope: string;
        key: string;
        value: string;
        cwd: string;
      }) => string
    >(),
}));

vi.mock("../../settings/resolve.js", () => ({
  loadSettings: stubs.loadSettings,
}));
vi.mock("../../settings/write.js", () => ({
  writeSettingsValue: stubs.writeSettingsValue,
}));

const LOCAL_PATH = "/repo/.oxagen/settings.local.json";

/** Point `loadSettings` at one resolved settings document. */
function given(settings: Record<string, unknown>): void {
  stubs.loadSettings.mockReturnValue({ settings });
}

beforeEach(() => {
  given({});
  stubs.writeSettingsValue.mockReturnValue(LOCAL_PATH);
});

describe("loadDispatchSettings", () => {
  it("applies the defaults when nothing is persisted", () => {
    expect(loadDispatchSettings("/repo")).toEqual({
      mode: false,
      maxConcurrent: DISPATCH_DEFAULT_CAP,
    });
  });

  it("resolves against the caller's cwd, not the process cwd", () => {
    loadDispatchSettings("/repo");
    expect(stubs.loadSettings).toHaveBeenCalledWith({ cwd: "/repo" });
  });

  it("reads a persisted mode + cap through unchanged", () => {
    given({ dispatchMode: true, dispatchMaxConcurrent: 7 });
    expect(loadDispatchSettings("/repo")).toEqual({
      mode: true,
      maxConcurrent: 7,
    });
  });

  it("treats only a literal `true` as mode-on — a truthy string is not a boolean", () => {
    given({ dispatchMode: "true" });
    expect(loadDispatchSettings("/repo").mode).toBe(false);
  });

  it("floors a fractional cap rather than handing the tracker a non-integer", () => {
    given({ dispatchMaxConcurrent: 3.9 });
    expect(loadDispatchSettings("/repo").maxConcurrent).toBe(3);
  });

  it.each<unknown>([0, -2, "4", null])(
    "falls back to the default cap for a hand-edited %s",
    (cap) => {
      given({ dispatchMaxConcurrent: cap });
      expect(loadDispatchSettings("/repo").maxConcurrent).toBe(
        DISPATCH_DEFAULT_CAP,
      );
    },
  );
});

describe("persistDispatchMode", () => {
  it("writes to the LOCAL (per-machine, uncommitted) scope and returns the path", () => {
    expect(persistDispatchMode(true, "/repo")).toBe(LOCAL_PATH);
    expect(stubs.writeSettingsValue).toHaveBeenCalledWith({
      scope: "local",
      key: "dispatchMode",
      value: "true",
      cwd: "/repo",
    });
  });

  it("writes mode-off as an explicit `false`, never by omitting the key", () => {
    persistDispatchMode(false, "/repo");
    expect(stubs.writeSettingsValue).toHaveBeenCalledWith(
      expect.objectContaining({ key: "dispatchMode", value: "false" }),
    );
  });
});

describe("persistDispatchCap", () => {
  it.each<[number, string]>([
    [0, "1"],
    [-5, "1"],
    [6.7, "6"],
    [4, "4"],
  ])(
    "clamps a cap of %s to a whole number of at least 1 (%s)",
    (input, written) => {
      // The settings schema types dispatchMaxConcurrent as a positive integer, so
      // an out-of-range `/dispatch cap` argument has to be clamped here rather
      // than rejected at write time.
      persistDispatchCap(input, "/repo");
      expect(stubs.writeSettingsValue).toHaveBeenLastCalledWith({
        scope: "local",
        key: "dispatchMaxConcurrent",
        value: written,
        cwd: "/repo",
      });
    },
  );
});
