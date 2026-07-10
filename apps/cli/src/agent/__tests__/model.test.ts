/**
 * Model resolution — the explicit-choice chain that drives worker auto-routing.
 *
 * `resolveModelId` always lands on a concrete slug (default included);
 * `explicitModelId` is the same chain MINUS the default — undefined means the
 * user chose nothing, which the REPL forwards as model:undefined so the
 * engine's per-turn tier router runs instead of a silent pin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const readConfigMock = vi.fn<() => { model?: string }>(() => ({}));
vi.mock("../../lib/config.js", () => ({
  readConfig: () => readConfigMock(),
}));

const { resolveModelId, explicitModelId, DEFAULT_MODEL } = await import(
  "../model.js"
);

const ORIGINAL_ENV = process.env["OXAGEN_MODEL"];

beforeEach(() => {
  delete process.env["OXAGEN_MODEL"];
  readConfigMock.mockReturnValue({});
});

afterEach(() => {
  if (ORIGINAL_ENV !== undefined) process.env["OXAGEN_MODEL"] = ORIGINAL_ENV;
  else delete process.env["OXAGEN_MODEL"];
});

describe("explicitModelId", () => {
  it("returns undefined when the user chose nothing anywhere", () => {
    expect(explicitModelId()).toBeUndefined();
    expect(explicitModelId(undefined)).toBeUndefined();
  });

  it("returns the override first", () => {
    process.env["OXAGEN_MODEL"] = "env/model";
    expect(explicitModelId("flag/model")).toBe("flag/model");
  });

  it("falls back to OXAGEN_MODEL, then the persisted config model", () => {
    process.env["OXAGEN_MODEL"] = "env/model";
    expect(explicitModelId()).toBe("env/model");

    delete process.env["OXAGEN_MODEL"];
    readConfigMock.mockReturnValue({ model: "config/model" });
    expect(explicitModelId()).toBe("config/model");
  });

  it("never falls through to the default (that is resolveModelId's job)", () => {
    expect(explicitModelId()).not.toBe(DEFAULT_MODEL);
    expect(resolveModelId()).toBe(DEFAULT_MODEL);
  });
});
