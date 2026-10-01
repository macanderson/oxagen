/**
 * The Policy line of `oxagen agent status` (#4570). It named permission rules alone,
 * while the mode also decides the contained-tier check and the stale-bundle
 * check. It now prints the sentence `oxagen agent enroll` and the desktop app print.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type HostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { CliDeps } from "./deps";
import { status } from "./status";

/** A Claude Code host whose host.json carries `host`. */
function hostWith(host: (signed: HostFile) => unknown): {
  deps: CliDeps;
  lines: string[];
} {
  const paths = scratchPaths();
  const signer = bundleSigner();
  const signed = testHostFile(signer, signer.sign(unsignedBundle()), {
    harnesses: ["claude-code"],
  });
  writeHostFile(paths.hostFile, host(signed) as HostFile);
  const lines: string[] = [];
  const deps = {
    paths,
    home: join(paths.tachoDir, ".."),
    platform: "linux",
    env: {},
    now: () => Date.parse("2026-09-30T12:00:00Z"),
    out: (line: string) => lines.push(line),
    serviceManager: {
      kind: "systemd",
      unitPath: join(paths.tachoDir, "tachod.service"),
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
  } as unknown as CliDeps;
  return { deps, lines };
}

/** The same host with its bundle in `mode`. */
function inMode(mode: unknown) {
  return hostWith((signed) => ({
    ...signed,
    bundle: { ...signed.bundle, mode },
  }));
}

const policyLine = (lines: string[]) =>
  lines.find((line) => line.startsWith("Policy "));

describe("tacho status's Policy line", () => {
  it("says what enforce decides, beyond permission rules", async () => {
    const { deps, lines } = inMode("enforce");
    await status({}, deps);
    expect(policyLine(lines)).toBe(
      "Policy      enforce: the policy can deny a governed call or ask first. Budget and model limits also apply to model calls routed through Oxagen.",
    );
  });

  it("says observe records the decision, and that budget and model limits still apply", async () => {
    const { deps, lines } = inMode("observe");
    await status({}, deps);
    expect(policyLine(lines)).toBe(
      "Policy      observe: Oxagen records what the policy would decide on a governed call and lets it go ahead. Budget and model limits still apply to model calls routed through Oxagen.",
    );
  });

  it("never prints a mode the bundle schema does not name", async () => {
    // Status reads host.json through the bundle schema, so a mode someone
    // typed in reads as a host.json that does not validate, with the reason,
    // rather than as a Policy line. The desktop app reads the file without
    // the schema, which is why its panel names an unknown mode instead.
    for (const mode of ["shadow", undefined]) {
      const { deps, lines } = inMode(mode);
      const report = await status({}, deps);
      expect(report.enrolled, String(mode)).toBe(false);
      expect(report.problems?.[0], String(mode)).toContain("bundle.mode");
      expect(policyLine(lines), String(mode)).toBeUndefined();
    }
  });
});
