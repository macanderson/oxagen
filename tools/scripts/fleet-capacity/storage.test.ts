import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import example from "./profile.example.json";
import { main } from "./run";
import { persistentOutputRoot } from "./storage";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fleet-storage-"));
  directories.push(directory);
  const persistent = join(directory, "persistent");
  const temporary = join(directory, "temporary");
  mkdirSync(persistent, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  return { directory, persistent, temporary };
}

it("requires a private directory outside temporary storage and resolves symlink aliases", () => {
  const { directory, persistent, temporary } = fixture();
  expect(persistentOutputRoot(persistent, [temporary])).toBe(realpathSync(persistent));
  expect(() => persistentOutputRoot("relative", [])).toThrow(/absolute/);
  expect(() => persistentOutputRoot(temporary, [temporary])).toThrow(/outside/);
  const nested = join(temporary, "nested");
  mkdirSync(nested, { mode: 0o700 });
  const alias = join(directory, "alias");
  symlinkSync(nested, alias);
  expect(() => persistentOutputRoot(alias, [temporary])).toThrow(/outside/);
  chmodSync(persistent, 0o755);
  expect(() => persistentOutputRoot(persistent, [])).toThrow(/0700/);
});

it("rejects an unset live output root before sending enrollment requests", async () => {
  const { directory } = fixture();
  const profilePath = join(directory, "profile.json");
  writeFileSync(profilePath, JSON.stringify({ ...example, baseline: { ...example.baseline, measured: true } }));
  vi.stubEnv("FLEET_STAGING_ORIGIN", example.target);
  vi.stubEnv("FLEET_OUTPUT_ROOT", "");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(main(["run", profilePath])).rejects.toThrow(/FLEET_OUTPUT_ROOT/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("uploads only numeric copies from persistent run-specific directories", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/fleet-capacity.yml", import.meta.url), "utf8");
  expect(workflow).toContain("FLEET_OUTPUT_ROOT: ${{ vars.FLEET_OUTPUT_ROOT }}");
  expect(workflow).toContain("path: ${{ env.FLEET_OUTPUT_ROOT }}/${{ github.run_id }}-*/report.json");
  expect(workflow).not.toContain("$RUNNER_TEMP/fleet-capacity");
  expect(workflow).toContain("continue-on-error: true");
});
