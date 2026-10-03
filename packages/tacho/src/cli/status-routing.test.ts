/**
 * What `oxagen agent status` says when the daemon's model proxy is listening
 * and a harness's model calls do not go through it (#5421). Before this, the
 * only sign was an indented detail line under Gateway, worded and weighted
 * like the happy path, so a re-apply that took the base URL out left a host
 * that recorded no model call and looked fine.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import type {
  ModelBaseUrlHarnessState,
  ModelBaseUrlState,
} from "../host/model-base-url";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { defaultCliDeps, type CliDeps } from "./deps";
import { status } from "./status";

const PROXY_PORT = 47124;
const CLAUDE_FILE = "/home/dev/.claude/settings.json";
const STELLA_FILE = "/home/dev/.stella/stella.toml";

/** Claude Code's base URL state, pointed at the listening proxy unless overridden. */
function claudeBaseUrl(
  overrides: Partial<ModelBaseUrlHarnessState> = {},
): ModelBaseUrlHarnessState {
  return {
    harness: "claude-code",
    file: CLAUDE_FILE,
    key: "env.ANTHROPIC_BASE_URL",
    expected: `http://127.0.0.1:${PROXY_PORT}/anthropic`,
    current: `http://127.0.0.1:${PROXY_PORT}/anthropic`,
    previous: null,
    ours: true,
    backup: "/home/dev/.claude/.settings.json.oxagen-model-base-url.json",
    changed: false,
    toolSearch: { current: "true", enabled: true },
    ...overrides,
  };
}

/**
 * A host enrolled for `harnesses` whose daemon reports a proxy that is or is
 * not listening, and whose base URL read answers `entries`.
 */
function routedHost(
  listening: boolean,
  entries: ModelBaseUrlHarnessState[],
  harnesses: string[] = ["claude-code"],
): { deps: CliDeps; lines: string[] } {
  const paths = scratchPaths("linux");
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle()), { harnesses }),
  );
  const lines: string[] = [];
  const read = async (): Promise<ModelBaseUrlState> => ({
    harnesses: entries,
  });
  const deps = defaultCliDeps({
    paths,
    home: join(paths.tachoDir, ".."),
    platform: "linux",
    env: {},
    now: () => Date.parse("2026-10-03T20:00:00Z"),
    out: (line) => lines.push(line),
    err: () => undefined,
    serviceManager: {
      kind: "systemd",
      unitPath: join(paths.tachoDir, "tachod.service"),
      install: () => undefined,
      uninstall: () => undefined,
      status: () => ({ installed: true, running: true }),
    },
    daemonGet: async (path) =>
      path === "/status"
        ? {
            uptime_s: 60,
            spool_depth: 0,
            last_ingest_at: null,
            sessions: [],
            gateway: {
              listening,
              port: PROXY_PORT,
              routes: ["/anthropic"],
              calls_observed: 0,
            },
          }
        : undefined,
    readSettings: () => undefined,
    readCodexHooks: () => undefined,
    readCursorHooks: () => undefined,
    readClaudeDesktopConfig: () => undefined,
    modelBaseUrls: { apply: read, restore: read, read },
    modelCredentials: undefined,
    credentialStore: undefined,
  });
  return { deps, lines };
}

function warnings(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith("Warning     "));
}

describe("the routing warning in oxagen agent status", () => {
  it("is printed when the proxy is listening and Claude Code's base URL is not ours", async () => {
    const { deps, lines } = routedHost(true, [
      claudeBaseUrl({ ours: false, current: null }),
    ]);
    await status({}, deps);
    expect(warnings(lines)).toEqual([
      "Warning     claude-code model calls bypass the proxy, so Oxagen does not record them or enforce budget and model limits on them. Run `oxagen agent enroll` to route them through the proxy.",
    ]);
  });

  it("is not printed when the base URL points at the listening proxy", async () => {
    const { deps, lines } = routedHost(true, [claudeBaseUrl()]);
    await status({}, deps);
    expect(lines).toContain(
      "            claude-code: model calls are pointed at the proxy",
    );
    expect(warnings(lines)).toEqual([]);
  });

  it("is not printed when the proxy is not listening, which the Gateway line already says", async () => {
    const { deps, lines } = routedHost(false, [
      claudeBaseUrl({ ours: false, current: null }),
    ]);
    await status({}, deps);
    expect(
      lines.some((line) =>
        line.startsWith("Gateway     model proxy NOT LISTENING"),
      ),
    ).toBe(true);
    expect(warnings(lines)).toEqual([]);
  });

  it("names the managed settings file that overrides a base URL that is ours", async () => {
    const managed = "/etc/claude-code/managed-settings.json";
    const { deps, lines } = routedHost(true, [
      claudeBaseUrl({
        shadowedBy: { file: managed, value: "https://llm.example.com" },
      }),
    ]);
    await status({}, deps);
    expect(warnings(lines)).toEqual([
      `Warning     claude-code model calls bypass the proxy, so Oxagen does not record them or enforce budget and model limits on them. ${managed} sets env.ANTHROPIC_BASE_URL and overrides the enrolled value. Remove env.ANTHROPIC_BASE_URL from that file, then run \`oxagen agent enroll\`.`,
    ]);
  });

  it("keeps the reason enroll left Stella's own base URL in place", async () => {
    const reason = `${STELLA_FILE} already sets providers.anthropic.base_url, so it was left in place and Stella's Anthropic calls are not routed through Oxagen`;
    const { deps, lines } = routedHost(
      true,
      [
        {
          harness: "stella",
          file: STELLA_FILE,
          key: "providers.anthropic.base_url",
          expected: `http://127.0.0.1:${PROXY_PORT}/stella/anthropic`,
          current: "https://llm.example.com",
          previous: null,
          ours: false,
          backup: "/home/dev/.stella/.stella.toml.oxagen-model-base-url.json",
          changed: false,
          leftAlone: reason,
        },
      ],
      ["stella"],
    );
    await status({}, deps);
    expect(warnings(lines)).toEqual([
      `Warning     stella model calls bypass the proxy, so Oxagen does not record them or enforce budget and model limits on them. ${reason}. Change that file, then run \`oxagen agent enroll\`.`,
    ]);
  });
});
