/**
 * What `tacho status` says about which Cursor a machine has (#3349, carried
 * by #3367). `tacho detect` already told the `cursor-agent` CLI apart from
 * the editor; status printed only the version enrollment recorded, so an
 * editor-only machine could not tell from status what it was covering.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { AppFacts, CliDeps } from "./deps";
import { CURSOR_COVERAGE_NOTE } from "./detect";
import { status } from "./status";

/**
 * A host enrolled for `harnesses`, with `cursor_execpath` set to what
 * `execpath` returns for the scratch root, and an editor probe that answers
 * `editor`. Only the members `status()` reads.
 */
function cursorHost(
  execpath: (root: string) => string | null,
  editor: AppFacts,
  harnesses: string[] = ["claude-code", "cursor"],
): { deps: CliDeps; lines: string[] } {
  const paths = scratchPaths();
  const signer = bundleSigner();
  const cli = execpath(paths.root);
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle()), {
      harnesses,
      cursor_execpath: cli,
      cursor_version: cli === null ? null : "2026.09.10",
    }),
  );
  const lines: string[] = [];
  const deps = {
    paths,
    home: join(paths.root, ".."),
    platform: "linux",
    env: {},
    now: () => Date.parse("2026-09-23T12:00:00Z"),
    out: (line: string) => lines.push(line),
    serviceManager: {
      kind: "systemd",
      unitPath: join(paths.root, "tachod.service"),
      install: () => undefined,
      uninstall: () => undefined,
      status: () => ({ installed: true, running: true }),
    },
    daemonGet: async () => undefined,
    readSettings: () => undefined,
    readCodexHooks: () => undefined,
    readCursorHooks: () => undefined,
    readStellaHooks: () => undefined,
    readClaudeDesktopConfig: () => undefined,
    cursorEditor: () => editor,
  } as unknown as CliDeps;
  return { deps, lines };
}

/** The Cursor line that is not one of the per-file hook lines. */
function cursorLine(lines: string[]): string | undefined {
  return lines.find(
    (line) => line.startsWith("Cursor      ") && !line.includes(" present, "),
  );
}

/** A `cursor-agent` file under the scratch root, as enrollment found it. */
function installedCli(root: string): string {
  mkdirSync(join(root, "bin"), { recursive: true });
  const cli = join(root, "bin", "cursor-agent");
  writeFileSync(cli, "#!/bin/sh\n");
  return cli;
}

describe("the Cursor install line", () => {
  it("names the cursor-agent CLI when the path enrollment recorded is still there", async () => {
    const { deps, lines } = cursorHost(installedCli, {
      installed: true,
      path: "/Applications/Cursor.app",
    });
    const report = await status({}, deps);
    const cli = join(deps.paths.root, "bin", "cursor-agent");
    expect(report.cursorInstall).toEqual({ foundVia: "cli", path: cli });
    expect(cursorLine(lines)).toBe(
      `Cursor      installed as the cursor-agent CLI at ${cli}`,
    );
  });

  it("names the editor on a machine that never installed the CLI", async () => {
    const { deps, lines } = cursorHost(() => null, {
      installed: true,
      path: "/Applications/Cursor.app",
    });
    const report = await status({ json: true }, deps);
    expect(report.cursorInstall).toEqual({
      foundVia: "app",
      path: "/Applications/Cursor.app",
    });
    expect(JSON.parse(lines.at(-1) ?? "{}").cursorInstall).toEqual({
      foundVia: "app",
      path: "/Applications/Cursor.app",
    });
  });

  it("falls back to the editor when the recorded CLI is gone, and says so in text", async () => {
    const { deps, lines } = cursorHost(() => "/nowhere/cursor-agent", {
      installed: true,
      path: "/Applications/Cursor.app",
    });
    await status({}, deps);
    expect(cursorLine(lines)).toBe(
      "Cursor      installed as the Cursor editor at /Applications/Cursor.app",
    );
  });

  it("says neither was found, and that enrollment covers the machine anyway", async () => {
    const { deps, lines } = cursorHost(() => null, { installed: false });
    const report = await status({}, deps);
    expect(report.cursorInstall).toEqual({ foundVia: null });
    expect(cursorLine(lines)).toBe(
      `Cursor      not found on this machine, and ${CURSOR_COVERAGE_NOTE}`,
    );
  });

  it("is absent for a host that did not enroll Cursor", async () => {
    const { deps, lines } = cursorHost(
      () => null,
      { installed: true, path: "/Applications/Cursor.app" },
      ["claude-code"],
    );
    const report = await status({}, deps);
    expect(report.cursorInstall).toBeUndefined();
    expect(cursorLine(lines)).toBeUndefined();
  });
});
