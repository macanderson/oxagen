// Behaviour of the knip baseline (INV-16): `knip --production --strict` runs
// against a throwaway package with two findings (an unused file and an unused
// export) and knip.preprocessor.ts wired in exactly as apps/app/knip.json wires
// it, so the exit code and the printed report are knip's own.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BASELINE_FILE } from "../../knip.preprocessor";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const knipCli = path.join(appDir, "node_modules", "knip", "bin", "knip.js");
const preprocessor = path.join(appDir, "knip.preprocessor.ts");

const UNUSED_FILE = "files orphan.ts";
const UNUSED_EXPORT = "exports lib.ts unused";

let fixture: string | undefined;

function knipRun(baseline: unknown): { status: number | null; out: string } {
  fixture = mkdtempSync(path.join(tmpdir(), "knip-baseline-"));
  const write = (name: string, content: string) => {
    writeFileSync(path.join(fixture ?? "", name), content);
  };
  write("package.json", JSON.stringify({ name: "fixture", private: true }));
  write(
    "knip.json",
    JSON.stringify({
      entry: ["index.ts!"],
      project: ["**/*.ts!"],
      preprocessor,
    }),
  );
  write("index.ts", 'import { used } from "./lib";\nexport default used;\n');
  write("lib.ts", "export const used = 1;\nexport const unused = 2;\n");
  write("orphan.ts", "export const orphan = 3;\n");
  write(BASELINE_FILE, JSON.stringify(baseline));
  const result = spawnSync(
    process.execPath,
    [knipCli, "--production", "--strict", "--no-progress"],
    { cwd: fixture, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  return { status: result.status, out: result.stdout + result.stderr };
}

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe("knip baseline", () => {
  it("passes when every finding is in the baseline", () => {
    const run = knipRun([UNUSED_FILE, UNUSED_EXPORT]);
    expect(run.status).toBe(0);
    expect(run.out).not.toMatch(/Unused|Stale/);
  });

  it("fails on a finding the baseline does not list", () => {
    const run = knipRun([UNUSED_FILE]);
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/Unused exports \(1\)/);
    expect(run.out).toContain("unused");
    expect(run.out).not.toContain("orphan.ts");
  });

  it("fails on a baseline entry knip no longer reports", () => {
    const run = knipRun([UNUSED_FILE, UNUSED_EXPORT, "exports lib.ts gone"]);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`Stale ${BASELINE_FILE} entries (1)`);
    expect(run.out).toContain("exports lib.ts gone");
    expect(run.out).not.toMatch(/Unused/);
  });

  it("refuses a baseline that is not an array", () => {
    const run = knipRun({ files: [UNUSED_FILE] });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain("expected a JSON array of strings");
    expect(run.out).not.toMatch(/Unused|Stale/);
  });

  it("refuses a baseline array with a non-string entry", () => {
    const run = knipRun([UNUSED_FILE, UNUSED_EXPORT, 1]);
    expect(run.status).not.toBe(0);
    expect(run.out).toContain("expected a JSON array of strings");
    expect(run.out).not.toMatch(/Unused|Stale/);
  });

  it("refuses duplicate baseline entries", () => {
    const run = knipRun([UNUSED_FILE, UNUSED_FILE, UNUSED_EXPORT]);
    expect(run.status).not.toBe(0);
    expect(run.out).toContain("duplicate entries");
  });
});
