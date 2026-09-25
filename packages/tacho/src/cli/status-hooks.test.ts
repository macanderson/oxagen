/**
 * What `tacho status` says about a Claude Code hook written in an older
 * shape (#3989). An enrollment before #3989 wrote `SessionEnd` as an http
 * hook, which is lost while the daemon is down, and only `tacho enroll`
 * rewrites it. The hook still counts as present, so status has to name it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  mergeTachoSettings,
  type SettingsDocument,
} from "../host/settings-writer";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { CliDeps } from "./deps";
import { status } from "./status";

const CONFIG = {
  enrollmentId: TEST_ENROLLMENT,
  hookCommand: "/usr/local/bin/tacho hook",
  port: 47001,
  localToken: "tok",
};

/** The settings this build writes, with `SessionEnd` as an older build wrote it. */
function withHttpSessionEnd(): SettingsDocument {
  const settings = mergeTachoSettings({}, CONFIG).settings;
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      SessionEnd: [
        {
          hooks: [
            {
              type: "http",
              url: `http://127.0.0.1:47001/hook/${TEST_ENROLLMENT}`,
              headers: { Authorization: "Bearer $TACHO_LOCAL_TOKEN" },
              allowedEnvVars: ["TACHO_LOCAL_TOKEN"],
              timeout: 5,
            },
          ],
        },
      ],
    },
  };
}

/** A Claude Code host whose settings file reads back as `settings`. */
function claudeCodeHost(settings: SettingsDocument): {
  deps: CliDeps;
  lines: string[];
} {
  const paths = scratchPaths();
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle()), {
      harnesses: ["claude-code"],
    }),
  );
  const lines: string[] = [];
  const deps = {
    paths,
    home: join(paths.root, ".."),
    platform: "linux",
    env: {},
    now: () => Date.parse("2026-09-25T12:00:00Z"),
    out: (line: string) => lines.push(line),
    serviceManager: {
      kind: "systemd",
      unitPath: join(paths.root, "tachod.service"),
      install: () => undefined,
      uninstall: () => undefined,
      status: () => ({ installed: true, running: true }),
    },
    daemonGet: async () => undefined,
    readSettings: () => settings,
    readCodexHooks: () => undefined,
    readCursorHooks: () => undefined,
    readStellaHooks: () => undefined,
    readClaudeDesktopConfig: () => undefined,
  } as unknown as CliDeps;
  return { deps, lines };
}

describe("tacho status on an older Claude Code hook", () => {
  it("names the http SessionEnd an earlier enrollment wrote and says how to rewrite it", async () => {
    const { deps, lines } = claudeCodeHost(withHttpSessionEnd());
    const report = await status({}, deps);
    expect(report.hooks).toMatchObject({
      complete: true,
      stale: ["SessionEnd"],
    });
    expect(lines).toContain(
      "            outdated: SessionEnd. Run tacho enroll again to rewrite it.",
    );
  });

  it("prints no outdated line for the hooks this build writes", async () => {
    const { deps, lines } = claudeCodeHost(
      mergeTachoSettings({}, CONFIG).settings,
    );
    const report = await status({}, deps);
    expect(report.hooks?.stale).toEqual([]);
    expect(lines.some((line) => line.includes("outdated:"))).toBe(false);
  });
});
