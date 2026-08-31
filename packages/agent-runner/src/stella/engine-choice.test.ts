/**
 * Engine selection: precedence, the default, and the refusal.
 *
 * The refusal tests are the point. A selector that silently falls back on a
 * value it does not understand produces a deployment that believes it cut over
 * and did not — and every signal downstream (green turns, normal costs, a
 * healthy event log) confirms the belief.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_ENGINE,
  ENGINE_ENV_VAR,
  isEngineChoice,
  resolveEngineChoice,
  UnknownEngineError,
} from "./engine-choice";

describe("resolveEngineChoice", () => {
  test("defaults to the TS engine when nothing asks for another", () => {
    expect(resolveEngineChoice({ env: {} })).toBe("ts");
    expect(DEFAULT_ENGINE).toBe("ts");
  });

  test("an empty flag is the same as an unset one", () => {
    expect(resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "" } })).toBe("ts");
  });

  test("the process flag selects the engine", () => {
    expect(resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "stella" } })).toBe(
      "stella",
    );
  });

  test("a run's own request wins over the process flag", () => {
    expect(
      resolveEngineChoice({
        requested: "stella",
        env: { [ENGINE_ENV_VAR]: "ts" },
      }),
    ).toBe("stella");
    expect(
      resolveEngineChoice({
        requested: "ts",
        env: { [ENGINE_ENV_VAR]: "stella" },
      }),
    ).toBe("ts");
  });

  test("an absent per-run request falls through to the flag", () => {
    for (const requested of [undefined, null, ""]) {
      expect(
        resolveEngineChoice({
          requested,
          env: { [ENGINE_ENV_VAR]: "stella" },
        }),
      ).toBe("stella");
    }
  });

  test("a misspelled flag throws instead of silently running the TS engine", () => {
    expect(() =>
      resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "stela" } }),
    ).toThrow(UnknownEngineError);
    expect(() =>
      resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "stela" } }),
    ).toThrow(/OXAGEN_ENGINE.*unknown engine "stela".*ts, stella/s);
  });

  test("an unknown per-run request throws and names the run as the source", () => {
    expect(() => resolveEngineChoice({ requested: "rust" })).toThrow(
      /requested_engine.*"rust"/s,
    );
  });
});

describe("isEngineChoice", () => {
  test("admits exactly the two engines", () => {
    expect(isEngineChoice("ts")).toBe(true);
    expect(isEngineChoice("stella")).toBe(true);
    expect(isEngineChoice("TS")).toBe(false);
    expect(isEngineChoice(undefined)).toBe(false);
    expect(isEngineChoice(1)).toBe(false);
  });
});
