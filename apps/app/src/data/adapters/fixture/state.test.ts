import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_STATE_SWITCH,
  isStateSwitchHonoured,
  parseStateSwitch,
  readStateCookie,
  stateFor,
} from "./state";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

describe("parseStateSwitch", () => {
  it("reads a global state", () => {
    expect(parseStateSwitch("error")).toEqual({
      all: "error",
      pages: {},
      assistantDown: false,
    });
  });

  it("reads per-page states, the assistant engine and a URL-encoded list", () => {
    expect(
      parseStateSwitch("fleet%3Adenied%2Crun%3Anot_backed%2Cassistant%3Adown"),
    ).toEqual({
      all: null,
      pages: { fleet: "denied", run: "not_backed" },
      assistantDown: true,
    });
  });

  it.each([
    undefined,
    "",
    "exploded",
    "fleet:exploded",
    "nowhere:error",
    "assistant:sleepy",
  ])("ignores what it does not know: %j", (value) => {
    const parsed = parseStateSwitch(value);
    expect(parsed.all).toBeNull();
    expect(parsed.pages).toEqual({});
    expect(parsed.assistantDown).toBe(false);
  });
});

describe("stateFor", () => {
  it("prefers a page entry over the global state", () => {
    const state = parseStateSwitch("error,fleet:empty");
    expect(stateFor(state, "fleet")).toBe("empty");
    expect(stateFor(state, "spend")).toBe("error");
  });

  it("never applies the global state to the shell, only a shell entry", () => {
    expect(stateFor(parseStateSwitch("error"), "shell")).toBe("loaded");
    expect(stateFor(parseStateSwitch("shell:denied"), "shell")).toBe("denied");
  });

  it("is loaded with no switch", () => {
    expect(stateFor(NO_STATE_SWITCH, "audit")).toBe("loaded");
  });
});

describe("isStateSwitchHonoured", () => {
  it("is honoured in dev and test with fixture data", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_DATA", "fixture");
    expect(isStateSwitchHonoured()).toBe(true);
  });

  it("is never honoured in a production build (negative)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    expect(isStateSwitchHonoured()).toBe(false);
  });

  it("is not honoured against live data (negative)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "live");
    expect(isStateSwitchHonoured()).toBe(false);
  });
});

describe("readStateCookie", () => {
  it("reads mc_state from the request's cookies", async () => {
    vi.doMock("next/headers", () => ({
      cookies: () =>
        Promise.resolve({
          get: (name: string) =>
            name === "mc_state" ? { value: "run:error" } : undefined,
        }),
    }));
    const { readStateCookie: read } = await import("./state");
    await expect(read()).resolves.toBe("run:error");
  });

  it("is undefined outside a request", async () => {
    await expect(readStateCookie()).resolves.toBeUndefined();
  });
});
