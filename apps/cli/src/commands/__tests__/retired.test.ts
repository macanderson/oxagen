/**
 * `retired.ts` — the single notice every command removed by the ADR-043 runtime
 * excision prints. It must name what was retired, point at the ADR and at
 * Stella, and set a NON-ZERO exit code so a script that still calls the old
 * command fails loudly instead of silently succeeding.
 */
import { afterEach, describe, expect, it } from "vitest";
import { printDeprecatedNotice, printRetiredNotice } from "../retired.js";

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

/**
 * `printDeprecatedNotice` is the other half: a command that was renamed and
 * still runs. Both properties below are the ones that drifted once already.
 * The first version of this line said only that removal was coming, while the
 * code comment beside it, ADR-111 decision 2, and the commit message all
 * claimed it named the replacement.
 */
describe("printDeprecatedNotice", () => {
  it("names both the old spelling and its replacement", () => {
    const out = capture(() =>
      printDeprecatedNotice("`oxagen tacho`", "`oxagen agent`"),
    );
    expect(out).toContain("`oxagen tacho`");
    // The whole point: hiding the group from --help leaves this line as the
    // only migration guidance, so a notice without the successor is a dead end.
    expect(out).toContain("`oxagen agent`");
    expect(out).toContain("deprecated");
  });

  it("leaves the exit code alone, unlike a retirement", () => {
    process.exitCode = 0;
    capture(() => printDeprecatedNotice("`oxagen tacho`", "`oxagen agent`"));
    // A deprecated command still does its work, so a script that calls it keeps
    // passing. `printRetiredNotice` sets 1 here on purpose; this must not.
    expect(process.exitCode).toBe(0);
  });
});
