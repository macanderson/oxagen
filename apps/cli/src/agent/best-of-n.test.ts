import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveBestOfNMode } from "./best-of-n.js";

describe("resolveBestOfNMode", () => {
  const originalEnv = process.env.OXAGEN_BEST_OF_N_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OXAGEN_BEST_OF_N_MODE = originalEnv;
    } else {
      delete process.env.OXAGEN_BEST_OF_N_MODE;
    }
  });

  it("returns explicit mode when provided", () => {
    delete process.env.OXAGEN_BEST_OF_N_MODE;
    expect(resolveBestOfNMode("fork")).toBe("fork");
    expect(resolveBestOfNMode("independent")).toBe("independent");
  });

  it("resolves from OXAGEN_BEST_OF_N_MODE env when set", () => {
    process.env.OXAGEN_BEST_OF_N_MODE = "fork";
    expect(resolveBestOfNMode()).toBe("fork");

    process.env.OXAGEN_BEST_OF_N_MODE = "independent";
    expect(resolveBestOfNMode()).toBe("independent");
  });

  it("defaults to 'independent' when env is unset", () => {
    delete process.env.OXAGEN_BEST_OF_N_MODE;
    expect(resolveBestOfNMode()).toBe("independent");
  });

  it("defaults to 'independent' when env has invalid value", () => {
    process.env.OXAGEN_BEST_OF_N_MODE = "invalid";
    expect(resolveBestOfNMode()).toBe("independent");

    process.env.OXAGEN_BEST_OF_N_MODE = "";
    expect(resolveBestOfNMode()).toBe("independent");
  });

  it("prefers explicit mode over env", () => {
    process.env.OXAGEN_BEST_OF_N_MODE = "independent";
    expect(resolveBestOfNMode("fork")).toBe("fork");
  });
});
