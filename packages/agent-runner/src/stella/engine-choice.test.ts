/**
 * Engine selection: precedence, the default, and the two refusals.
 *
 * The refusal tests are the point. A selector that silently falls back on a
 * value it does not understand produces a deployment that believes it cut over
 * and did not — and every signal downstream (green turns, normal costs, a
 * healthy event log) confirms the belief.
 *
 * With Stella the only engine, the refusals carry more of the module than the
 * selection does: `ts` names something that existed until this cutover, so it
 * gets an error saying the engine was removed rather than one saying it was
 * never real.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_ENGINE,
  ENGINE_ENV_VAR,
  isEngineChoice,
  resolveEngineChoice,
  RETIRED_ENGINES,
  RetiredEngineError,
  UnknownEngineError,
} from "./engine-choice";

describe("resolveEngineChoice", () => {
  test("defaults to Stella when nothing asks for another", () => {
    expect(resolveEngineChoice({ env: {} })).toBe("stella");
    expect(DEFAULT_ENGINE).toBe("stella");
  });

  test("an empty flag is the same as an unset one", () => {
    expect(resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "" } })).toBe(
      "stella",
    );
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
        env: { [ENGINE_ENV_VAR]: "stella" },
      }),
    ).toBe("stella");
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

  test("a misspelled flag throws instead of silently running something else", () => {
    expect(() =>
      resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "stela" } }),
    ).toThrow(UnknownEngineError);
    expect(() =>
      resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "stela" } }),
    ).toThrow(/OXAGEN_ENGINE.*unknown engine "stela".*stella/s);
  });

  test("an unknown per-run request throws and names the run as the source", () => {
    expect(() => resolveEngineChoice({ requested: "rust" })).toThrow(
      /requested_engine.*"rust"/s,
    );
  });

  test("the retired TS engine is refused by name, from either input", () => {
    // The distinction that matters to whoever is reading the crash: `ts` was
    // real until this cutover, so the message says it was removed rather than
    // listing valid values and leaving them to infer why theirs stopped
    // working.
    for (const options of [
      { env: { [ENGINE_ENV_VAR]: "ts" } },
      { requested: "ts", env: {} },
    ]) {
      expect(() => resolveEngineChoice(options)).toThrow(RetiredEngineError);
      expect(() => resolveEngineChoice(options)).toThrow(
        /"ts" engine, which was removed.*TypeScript step loop/s,
      );
    }
  });

  test("a retired engine is never silently resolved to the survivor", () => {
    // The failure this whole module exists to prevent: an operator whose flag
    // still says `ts` must not get a green turn on Stella and conclude their
    // configuration is doing something.
    expect(() =>
      resolveEngineChoice({ env: { [ENGINE_ENV_VAR]: "ts" } }),
    ).toThrow();
  });
});

describe("isEngineChoice", () => {
  test("admits exactly the one engine that exists", () => {
    expect(isEngineChoice("stella")).toBe(true);
    expect(isEngineChoice("ts")).toBe(false);
    expect(isEngineChoice("STELLA")).toBe(false);
    expect(isEngineChoice(undefined)).toBe(false);
    expect(isEngineChoice(1)).toBe(false);
  });
});

describe("RETIRED_ENGINES", () => {
  test("never overlaps the engines that still exist", () => {
    // A name in both tables would be admitted by `isEngineChoice` and refused
    // by `admit`, or vice versa depending on check order — either way the
    // vocabulary would be lying. Fail instead if an engine is ever both.
    for (const retired of Object.keys(RETIRED_ENGINES)) {
      expect(isEngineChoice(retired)).toBe(false);
    }
  });

  test("every retired engine carries a reason, not just a name", () => {
    // The entry IS the error message's explanation; an empty one would produce
    // "which was removed, ." and tell the reader nothing.
    for (const [name, reason] of Object.entries(RETIRED_ENGINES)) {
      expect(reason.trim().length, `${name} has no reason`).toBeGreaterThan(10);
    }
  });
});
