/**
 * `retired.ts` — the single notice every command removed by the ADR-043 runtime
 * excision prints. It must name what was retired, point at the ADR and at
 * Stella, and set a NON-ZERO exit code so a script that still calls the old
 * command fails loudly instead of silently succeeding.
 */
import { afterEach, describe, expect, it } from "vitest";
import { printRetiredNotice } from "../retired.js";

const originalWrite = process.stderr.write.bind(process.stderr);
const originalExitCode = process.exitCode;

afterEach(() => {
  process.stderr.write = originalWrite;
  process.exitCode = originalExitCode;
});

function capture(fn: () => void): string {
  const chunks: string[] = [];
  process.stderr.write = ((s: string) => {
    chunks.push(s);
    return true;
  }) as typeof process.stderr.write;
  fn();
  process.stderr.write = originalWrite;
  return chunks.join("");
}

describe("printRetiredNotice", () => {
  it("names the retired command, the ADR, and the Stella replacement", () => {
    const out = capture(() => printRetiredNotice("`oxagen run`"));

    expect(out).toContain("`oxagen run`");
    expect(out).toContain("docs/adr/ADR-043-runtime-excision.md");
    expect(out).toContain("stella");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("fails the process so scripts calling a retired command break loudly", () => {
    process.exitCode = 0;
    capture(() => printRetiredNotice("`oxagen sandbox`"));
    expect(process.exitCode).toBe(1);
  });
});
