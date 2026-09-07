/**
 * `oxagen cost` — proves the rate-card dump, cross-model comparison and
 * single-model projection render correctly and that --json is machine-readable.
 *
 * The `--session` rollup this command used to offer read the local coding
 * agent's turn store, which was retired with the runtime (ADR-043); observed
 * spend now comes from the platform via `budget show` and `trace`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCost } from "../cost.js";

let out = "";
let write: typeof process.stdout.write;

beforeEach(() => {
  out = "";
  write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
});

afterEach(() => {
  process.stdout.write = write;
  process.exitCode = 0;
});

describe("cost --rates", () => {
  it("prints the baked-in rate card with vendors and prices", () => {
    handleCost({ rates: true });
    expect(out).toContain("Claude Opus");
    expect(out).toContain("anthropic");
    expect(out).toContain("$15");
  });

  it("emits JSON with --json", () => {
    handleCost({ rates: true, json: true });
    const parsed = JSON.parse(out) as Array<{ family: string }>;
    expect(parsed.some((e) => e.family === "claude-opus")).toBe(true);
  });
});

describe("cost projection", () => {
  it("compares every model cheapest-first and reports the spread", () => {
    handleCost({ in: 1_000_000, out: 1_000_000 });
    expect(out).toContain("cheapest:");
    expect(out).toContain("GPT-4o mini");
    expect(out).toContain("× cheaper");
  });

  it("projects a single model with --model and --json", () => {
    handleCost({
      in: 1_000_000,
      out: 0,
      model: "anthropic/claude-opus-4.8",
      json: true,
    });
    const p = JSON.parse(out) as { totalUsd: number; vendor: string };
    expect(p.vendor).toBe("anthropic");
    expect(p.totalUsd).toBeCloseTo(15);
  });

  it("errors when no token counts are given", () => {
    handleCost({});
    expect(process.exitCode).toBe(1);
    expect(out).toContain("Provide token counts");
  });

  it("points at the rate-card dump in the no-input hint", () => {
    handleCost({});
    expect(out).toContain("oxagen cost --rates");
    expect(out).not.toContain("--session");
  });
});
