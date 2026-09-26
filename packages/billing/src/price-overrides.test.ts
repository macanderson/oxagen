import { describe, expect, it } from "vitest";
import {
  loadPriceOverrides,
  parsePriceOverrides,
  PriceOverrideError,
  PRICE_OVERRIDES_ENV,
  PRICE_OVERRIDES_FILE_ENV,
} from "./price-overrides";

const SONNET = {
  provider: "anthropic",
  inputPer1M: 2.4,
  outputPer1M: 12,
  cachedInputPer1M: 0.24,
  cacheWrite5mPer1M: 3,
};

/** A readFile that serves one path and fails on anything else. */
function fileAt(path: string, contents: string) {
  return (p: string) => {
    if (p !== path) throw new Error(`ENOENT: no such file or directory, ${p}`);
    return contents;
  };
}

/** The readFile that must never be reached. */
const unreadableFile = (p: string): string => {
  throw new Error(`EACCES: permission denied, open '${p}'`);
};

/**
 * Both values stated as empty, so the load reads neither the environment this
 * test process happens to carry nor the filesystem.
 */
const NOTHING_SET = { filePath: "", inline: "", readFile: unreadableFile };

describe("loadPriceOverrides", () => {
  it("prices nothing when the deployment states no rates", () => {
    expect(loadPriceOverrides(NOTHING_SET)).toEqual([]);
    // A value that is only whitespace is the same as a value nobody set.
    expect(
      loadPriceOverrides({
        filePath: "   ",
        inline: "  ",
        readFile: unreadableFile,
      }),
    ).toEqual([]);
  });

  it("reads the rates an operator typed into the environment", () => {
    const prices = loadPriceOverrides({
      filePath: "",
      inline: JSON.stringify({ "claude-sonnet-5": SONNET }),
      readFile: unreadableFile,
    });
    expect(prices).toEqual([
      {
        model: "claude-sonnet-5",
        aliases: [],
        provider: "anthropic",
        inputPer1M: 2.4,
        outputPer1M: 12,
        cachedInputPer1M: 0.24,
        cacheWrite5mPer1M: 3,
        cacheWrite1hPer1M: 4.8,
        reasoningPer1M: 12,
        serverToolRequestPer1M: 10_000,
        source: "operator_override",
      },
    ]);
  });

  it("reads a models wrapper exactly as it reads the bare map", () => {
    const map = { "claude-sonnet-5": SONNET };
    expect(parsePriceOverrides({ models: map })).toEqual(
      parsePriceOverrides(map),
    );
    expect(
      loadPriceOverrides({
        filePath: "",
        inline: JSON.stringify({ models: map }),
        readFile: unreadableFile,
      }),
    ).toEqual(parsePriceOverrides(map));
  });

  it("takes the mounted file over the variable it was rolled out with", () => {
    const prices = loadPriceOverrides({
      filePath: "/run/secrets/prices.json",
      inline: JSON.stringify({
        "claude-sonnet-5": { inputPer1M: 999, outputPer1M: 999 },
      }),
      readFile: fileAt(
        "/run/secrets/prices.json",
        JSON.stringify({ "claude-sonnet-5": SONNET }),
      ),
    });
    expect(prices).toHaveLength(1);
    expect(prices[0]!.inputPer1M).toBe(2.4);
  });

  it("marks every row it produces as the operator's own", () => {
    const prices = loadPriceOverrides({
      filePath: "",
      inline: JSON.stringify({
        "claude-sonnet-5": SONNET,
        "openai/gpt-4o": { inputPer1M: 1, outputPer1M: 4 },
      }),
      readFile: unreadableFile,
    });
    expect(prices).toHaveLength(2);
    expect(prices.every((p) => p.source === "operator_override")).toBe(true);
  });
});

describe("loadPriceOverrides refusals", () => {
  const throws = (args: {
    filePath?: string;
    inline?: string;
    readFile?: (p: string) => string;
  }) => {
    let caught: unknown;
    try {
      loadPriceOverrides({
        filePath: "",
        inline: "",
        readFile: unreadableFile,
        ...args,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PriceOverrideError);
    return caught as PriceOverrideError;
  };

  it("refuses to start when the file it was pointed at cannot be read", () => {
    const err = throws({ filePath: "/nope/prices.json" });
    expect(err.message).toContain(PRICE_OVERRIDES_FILE_ENV);
    expect(err.message).toContain("/nope/prices.json");
    expect(err.message).toContain("could not be read");
    expect(err.code).toBe("PRICE_OVERRIDE_INVALID");
  });

  it("refuses to start on JSON that does not parse", () => {
    const err = throws({ inline: "{ not json" });
    expect(err.message).toContain(PRICE_OVERRIDES_ENV);
    expect(err.message).toContain("not valid JSON");
  });

  it("refuses a negative rate rather than pricing a run below zero", () => {
    const err = throws({
      inline: JSON.stringify({
        "claude-sonnet-5": { inputPer1M: -1, outputPer1M: 12 },
      }),
    });
    expect(err.message).toContain(PRICE_OVERRIDES_ENV);
    expect(err.message).toContain("claude-sonnet-5.inputPer1M");
  });

  it("refuses a key it does not recognise instead of ignoring a typo", () => {
    // `.strict()` is what makes `inputPerM` a loud failure rather than a model
    // that quietly loses the rate the operator meant to state.
    const err = throws({
      inline: JSON.stringify({
        "claude-sonnet-5": { inputPer1M: 2.4, outputPer1M: 12, inputPerM: 2.4 },
      }),
    });
    expect(err.message).toContain(PRICE_OVERRIDES_ENV);
    expect(err.message).toContain("inputPerM");
  });

  it("refuses a model that states only half its rates", () => {
    expect(
      throws({
        inline: JSON.stringify({ "claude-sonnet-5": { outputPer1M: 12 } }),
      }).message,
    ).toContain("claude-sonnet-5.inputPer1M");
    expect(
      throws({
        inline: JSON.stringify({ "claude-sonnet-5": { inputPer1M: 2.4 } }),
      }).message,
    ).toContain("claude-sonnet-5.outputPer1M");
  });

  it("names the file, not the inline variable, when the file is the bad one", () => {
    const err = throws({
      filePath: "/run/secrets/prices.json",
      inline: JSON.stringify({ "m-1": SONNET }),
      readFile: fileAt("/run/secrets/prices.json", "{ not json"),
    });
    expect(err.message).toContain(PRICE_OVERRIDES_FILE_ENV);
    expect(err.message).toContain("/run/secrets/prices.json");
  });
});

describe("parsePriceOverrides defaults", () => {
  it("reads the provider off a vendor-prefixed id and aliases the bare form", () => {
    const price = parsePriceOverrides({
      "anthropic/claude-sonnet-5": { inputPer1M: 2.4, outputPer1M: 12 },
    })[0]!;
    expect(price.provider).toBe("anthropic");
    expect(price.aliases).toEqual(["claude-sonnet-5"]);
  });

  it("leaves a bare id's provider unknown rather than guessing one", () => {
    const price = parsePriceOverrides({
      "claude-sonnet-5": { inputPer1M: 2.4, outputPer1M: 12 },
    })[0]!;
    expect(price.provider).toBe("unknown");
    expect(price.aliases).toEqual([]);
  });

  it("takes the aliases the operator states over the derived one", () => {
    const price = parsePriceOverrides({
      "anthropic/claude-sonnet-5": {
        inputPer1M: 2.4,
        outputPer1M: 12,
        aliases: ["sonnet"],
      },
    })[0]!;
    expect(price.aliases).toEqual(["sonnet"]);
  });

  it("bills reasoning at the output rate unless the operator priced it", () => {
    const derived = parsePriceOverrides({
      "m-1": { inputPer1M: 1, outputPer1M: 12 },
    })[0]!;
    expect(derived.reasoningPer1M).toBe(12);
    const stated = parsePriceOverrides({
      "m-1": { inputPer1M: 1, outputPer1M: 12, reasoningPer1M: 20 },
    })[0]!;
    expect(stated.reasoningPer1M).toBe(20);
  });

  it("prices Anthropic web searches at the published rate unless the operator priced them", () => {
    const derived = parsePriceOverrides({
      "anthropic/m-1": { inputPer1M: 1, outputPer1M: 12 },
      "openai/m-2": { inputPer1M: 1, outputPer1M: 12 },
    });
    expect(derived.map((p) => p.serverToolRequestPer1M)).toEqual([
      10_000,
      null,
    ]);
    const stated = parsePriceOverrides({
      "anthropic/m-1": {
        inputPer1M: 1,
        outputPer1M: 12,
        serverToolRequestPer1M: 8_000,
      },
    })[0]!;
    expect(stated.serverToolRequestPer1M).toBe(8_000);
  });

  it("uses Anthropic one-hour policy and honors an explicitly stated rate", () => {
    const derived = parsePriceOverrides({
      "anthropic/m-1": {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheWrite5mPer1M: 3.75,
      },
    })[0]!;
    expect(derived.cacheWrite1hPer1M).toBeCloseTo(6, 10);
    const stated = parsePriceOverrides({
      "m-1": {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheWrite5mPer1M: 3.75,
        cacheWrite1hPer1M: 5.5,
      },
    })[0]!;
    expect(stated.cacheWrite1hPer1M).toBe(5.5);
  });

  it("does not infer an unknown provider's one-hour policy from its write premium", () => {
    const price = parsePriceOverrides({
      "other/m-1": { inputPer1M: 3, outputPer1M: 15, cacheWrite5mPer1M: 3.75 },
    })[0]!;
    expect(price.cacheWrite1hPer1M).toBeNull();
  });

  it("leaves a cache class the operator omitted unpriced rather than free", () => {
    const price = parsePriceOverrides({
      "m-1": { inputPer1M: 3, outputPer1M: 15 },
    })[0]!;
    expect(price.cachedInputPer1M).toBe(null);
    expect(price.cacheWrite5mPer1M).toBe(null);
    expect(price.cacheWrite1hPer1M).toBe(null);
  });

  it("accepts a zero rate, which is a price, and refuses an empty model id", () => {
    const free = parsePriceOverrides({
      "m-free": { inputPer1M: 0, outputPer1M: 0 },
    })[0]!;
    expect(free.inputPer1M).toBe(0);
    expect(() =>
      parsePriceOverrides({ "   ": { inputPer1M: 1, outputPer1M: 2 } }),
    ).toThrow(PriceOverrideError);
  });

  it("refuses a document that is not a map of models at all", () => {
    expect(() => parsePriceOverrides([SONNET])).toThrow(PriceOverrideError);
    expect(() => parsePriceOverrides("claude-sonnet-5=2.40")).toThrow(
      PriceOverrideError,
    );
    expect(parsePriceOverrides({})).toEqual([]);
  });
});
