/**
 * Unit tests for lib/pin-env.ts (computeEnvPins).
 *
 * Guards the dev-launcher invariant that .env.local is authoritative over
 * inherited shell env — the failure mode being a stale truncated
 * `export DATABASE_URL=postgres:` in the launching terminal silently
 * breaking (or retargeting) every migrate/seed/dev child.
 */

import { describe, it, expect } from "vitest";
import { computeEnvPins } from "./lib/pin-env";

describe("computeEnvPins", () => {
  it("assigns every key the file defines", () => {
    const { assignments } = computeEnvPins(
      "DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen\nLOG_LEVEL=debug\n",
      {},
    );
    expect(assignments).toEqual({
      DATABASE_URL: "postgres://oxagen:oxagen@localhost:5433/oxagen",
      LOG_LEVEL: "debug",
    });
  });

  it("reports keys whose inherited value differs (the stale-export case)", () => {
    const { assignments, overridden } = computeEnvPins(
      "DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen\n",
      { DATABASE_URL: "postgres:" },
    );
    expect(overridden).toEqual(["DATABASE_URL"]);
    expect(assignments.DATABASE_URL).toBe(
      "postgres://oxagen:oxagen@localhost:5433/oxagen",
    );
  });

  it("does not report keys whose inherited value already matches", () => {
    const { overridden } = computeEnvPins("FOO=bar\n", { FOO: "bar" });
    expect(overridden).toEqual([]);
  });

  it("does not report keys absent from the environment", () => {
    const { overridden } = computeEnvPins("FOO=bar\n", {});
    expect(overridden).toEqual([]);
  });

  it("strips surrounding double quotes per dotenv rules", () => {
    const { assignments } = computeEnvPins(
      'MODAL_RUNNER_URL="https://example.modal.run"\n',
      {},
    );
    expect(assignments.MODAL_RUNNER_URL).toBe("https://example.modal.run");
  });

  it("ignores comment and blank lines", () => {
    const { assignments } = computeEnvPins(
      "# a comment\n\nFOO=bar\n# DATABASE_URL=ignored\n",
      {},
    );
    expect(assignments).toEqual({ FOO: "bar" });
  });

  it("leaves unrelated inherited env out of the assignments", () => {
    const { assignments } = computeEnvPins("FOO=bar\n", { PATH: "/usr/bin" });
    expect(assignments).not.toHaveProperty("PATH");
  });
});
