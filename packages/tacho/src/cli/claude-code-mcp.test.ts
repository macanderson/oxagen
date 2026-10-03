/**
 * Adding Oxagen's MCP server to an enrolled Claude Code (#5287), through the
 * real file ports over a scratch home: the entry goes into Claude Code's
 * user config beside everything else in it, `host.json` records where and
 * what was moved aside, unenroll takes it back out, and `status` adds it
 * once to an enrollment made before enroll wrote it.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeConfigLockPath } from "../host/claude-config-lock";
import { HarnessFileError } from "../host/harness-file";
import {
  type HostFile,
  readHostFile,
  writeHostFile,
} from "../host/host-file";
import { acquireInstallLock } from "../host/install-lock";
import { agentPaths, tachoHome } from "../host/paths";
import {
  bundleSigner,
  TEST_AGENT_ID,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import {
  addMissingClaudeCodeMcp,
  needsClaudeCodeMcp,
  registerClaudeCodeMcp,
} from "./claude-code-mcp";
import { defaultCliDeps, type RuntimeCommands } from "./deps";
import { stripEnrollmentHooks } from "./unenroll";

const signer = bundleSigner();
const bundle = signer.sign(unsignedBundle());

const RUNTIME: RuntimeCommands = {
  hookCommand: "/opt/oxagen/oxagen hook",
  credentialHelperCommand:
    "/opt/oxagen/oxagen credential issue --harness claude-code",
  daemonCommand: ["/opt/oxagen/oxagen", "daemon"],
  mcpStdioCommand: ["/opt/oxagen/oxagen", "mcp-stdio"],
  binDir: "/opt/oxagen",
  program: "oxagen",
};

/** One enrolled agent on a scratch home, with the real file ports. */
function machine(overrides: Partial<HostFile> = {}) {
  const home = mkdtempSync(join(tmpdir(), "tacho-claude-mcp-"));
  const env = {
    HOME: home,
    TACHO_HOME: join(home, ".config", "oxagen", "tacho"),
  };
  const paths = agentPaths(tachoHome(env, home, "darwin"), TEST_AGENT_ID);
  const deps = defaultCliDeps({
    paths,
    env,
    home,
    platform: "darwin",
    runtime: RUNTIME,
    out: () => undefined,
    err: () => undefined,
  });
  const host = testHostFile(signer, bundle, {
    mcp_stdio_command: RUNTIME.mcpStdioCommand,
    ...overrides,
  });
  writeHostFile(paths.hostFile, host);
  return { home, env, paths, deps, host };
}

function seedConfig(path: string, document: unknown): void {
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
  });
}

function readConfig(path: string): Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const GITHUB = { type: "http", url: "https://api.githubcopilot.com/mcp/" };

describe("registerClaudeCodeMcp", () => {
  it("writes the server beside Claude Code's own state and records it in host.json", () => {
    const m = machine();
    const file = m.paths.claudeUserConfig;
    expect(file).toBe(join(m.home, ".claude.json"));
    seedConfig(file, {
      numStartups: 3,
      hasCompletedOnboarding: true,
      mcpServers: { github: GITHUB },
    });

    const outcome = registerClaudeCodeMcp(m.host, m.deps);
    expect(outcome.result).toBe("written");
    expect(outcome.displaced).toBe(false);
    const config = readConfig(file);
    expect(config["numStartups"]).toBe(3);
    expect(config["hasCompletedOnboarding"]).toBe(true);
    expect(config.mcpServers?.["github"]).toEqual(GITHUB);
    expect(config.mcpServers?.["oxagen"]).toEqual({
      command: "/opt/oxagen/oxagen",
      args: ["mcp-stdio", "--enrollment", TEST_ENROLLMENT, "--port", "47001"],
      env: {
        TACHO_LOCAL_TOKEN: "local-token-0123456789abcdef",
        TACHO_HOME: m.env.TACHO_HOME,
      },
    });
    // The bearer is in the file, so it stays readable by its owner alone.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Claude Code's lock was taken for the edit and let go.
    expect(existsSync(claudeConfigLockPath(file))).toBe(false);

    const recorded = readHostFile(m.paths.hostFile);
    const writtenAt = recorded?.mcp_registered_at?.["claude-code"];
    expect(Number.isFinite(Date.parse(writtenAt ?? ""))).toBe(true);
    expect(recorded?.harness_files?.claude_user_config).toBe(file);
    expect(outcome.host.mcp_registered_at).toEqual({
      "claude-code": writtenAt,
    });

    // A second run finds it in place and changes no byte.
    const bytes = readFileSync(file, "utf8");
    const again = registerClaudeCodeMcp(outcome.host, m.deps);
    expect(again.result).toBe("present");
    expect(readFileSync(file, "utf8")).toBe(bytes);
    // The entry did not change, so the time it took its form stands.
    expect(
      readHostFile(m.paths.hostFile)?.mcp_registered_at?.["claude-code"],
    ).toBe(writtenAt);
  });

  it("creates the file when Claude Code has never run", () => {
    const m = machine();
    expect(registerClaudeCodeMcp(m.host, m.deps).result).toBe("written");
    expect(Object.keys(readConfig(m.paths.claudeUserConfig))).toEqual([
      "mcpServers",
    ]);
  });

  it("moves a server of the user's aside, and the unenroll strip puts it back", async () => {
    const m = machine();
    const file = m.paths.claudeUserConfig;
    const theirs = { type: "http", url: "https://mcp.oxagen.sh/mcp" };
    const before = { numStartups: 9, mcpServers: { github: GITHUB, oxagen: theirs } };
    seedConfig(file, before);

    const outcome = registerClaudeCodeMcp(m.host, m.deps);
    expect(outcome.displaced).toBe(true);
    const recorded = readHostFile(m.paths.hostFile);
    expect(recorded?.displaced_mcp_servers["claude-code"]).toEqual({
      oxagen: theirs,
    });
    expect(readConfig(file).mcpServers?.["oxagen"]).not.toEqual(theirs);

    const stripped = await stripEnrollmentHooks(recorded, m.deps);
    expect(stripped.failed).toEqual([]);
    expect(stripped.claudeCodeMcpChanged).toBe(file);
    expect(readConfig(file)).toEqual(before);
  });

  it("keeps the server the person put under the name most recently", async () => {
    const m = machine();
    const file = m.paths.claudeUserConfig;
    const first = { type: "http", url: "https://first.example/mcp" };
    seedConfig(file, { mcpServers: { oxagen: first } });
    const outcome = registerClaudeCodeMcp(m.host, m.deps);
    expect(outcome.displaced).toBe(true);
    // The person puts a server of their own under the name again.
    const second = { command: "their-second-server" };
    seedConfig(file, { mcpServers: { oxagen: second } });
    const again = registerClaudeCodeMcp(outcome.host, m.deps);
    expect(again.displaced).toBe(true);
    const recorded = readHostFile(m.paths.hostFile);
    expect(recorded?.displaced_mcp_servers["claude-code"]).toEqual({
      oxagen: second,
    });
    await stripEnrollmentHooks(recorded, m.deps);
    expect(readConfig(file).mcpServers?.["oxagen"]).toEqual(second);
  });

  it("writes nothing for an enrollment without a gateway key", () => {
    const m = machine();
    const keyless: HostFile = { ...m.host };
    delete keyless.gateway_api_key;
    writeHostFile(m.paths.hostFile, keyless);
    const outcome = registerClaudeCodeMcp(keyless, m.deps);
    expect(outcome.result).toBe("skipped");
    expect(outcome.reason).toContain("no gateway key");
    expect(existsSync(m.paths.claudeUserConfig)).toBe(false);
    expect(readHostFile(m.paths.hostFile)?.mcp_registered_at).toBeUndefined();
  });

  it("refuses a config of the wrong shape and leaves it exactly as it is", () => {
    const m = machine();
    const file = m.paths.claudeUserConfig;
    seedConfig(file, { mcpServers: [] });
    const bytes = readFileSync(file, "utf8");
    expect(() => registerClaudeCodeMcp(m.host, m.deps)).toThrow(
      HarnessFileError,
    );
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(readHostFile(m.paths.hostFile)?.mcp_registered_at).toBeUndefined();
  });
});

describe("addMissingClaudeCodeMcp", () => {
  it("adds the server once to an enrollment made before #5287, and not again after the person removes it", () => {
    const m = machine();
    const file = m.paths.claudeUserConfig;
    seedConfig(file, { mcpServers: { github: GITHUB } });
    expect(needsClaudeCodeMcp(m.host)).toBe(true);

    expect(addMissingClaudeCodeMcp(m.deps)).toEqual([
      { agentKey: m.host.agent_key, path: file, ok: true },
    ]);
    expect(readConfig(file).mcpServers?.["oxagen"]).toBeDefined();
    expect(
      readHostFile(m.paths.hostFile)?.mcp_registered_at?.["claude-code"],
    ).toBeDefined();
    expect(addMissingClaudeCodeMcp(m.deps)).toEqual([]);

    // The person takes the server out with `claude mcp remove oxagen`.
    seedConfig(file, { mcpServers: { github: GITHUB } });
    expect(addMissingClaudeCodeMcp(m.deps)).toEqual([]);
    expect(readConfig(file).mcpServers?.["oxagen"]).toBeUndefined();
  });

  it("writes nothing when the enrolling shell had another CLAUDE_CONFIG_DIR", () => {
    const m = machine({
      harness_files: { claude_settings: "/Users/dev/claude-work/settings.json" },
    });
    const [skipped] = addMissingClaudeCodeMcp(m.deps);
    expect(skipped).toMatchObject({ agentKey: m.host.agent_key, ok: false });
    expect(skipped?.problem).toContain("CLAUDE_CONFIG_DIR");
    expect(existsSync(m.paths.claudeUserConfig)).toBe(false);
    expect(readHostFile(m.paths.hostFile)?.mcp_registered_at).toBeUndefined();
  });

  it("waits while another enroll, unenroll, or reassign holds the install lock", () => {
    const m = machine();
    const lock = acquireInstallLock(m.paths.tachoDir);
    if ("heldBy" in lock) throw new Error("the scratch lock was held");
    try {
      expect(addMissingClaudeCodeMcp(m.deps)).toEqual([]);
      expect(existsSync(m.paths.claudeUserConfig)).toBe(false);
    } finally {
      lock.release();
    }
    expect(addMissingClaudeCodeMcp(m.deps)).toHaveLength(1);
  });

  it("reports a failure and tries again on the next call", () => {
    const m = machine();
    const file = m.paths.claudeUserConfig;
    seedConfig(file, { mcpServers: "not a map" });
    const [failed] = addMissingClaudeCodeMcp(m.deps);
    expect(failed).toMatchObject({ ok: false, path: file });
    expect(failed?.problem).toContain("mcpServers");
    seedConfig(file, {});
    expect(addMissingClaudeCodeMcp(m.deps)).toEqual([
      { agentKey: m.host.agent_key, path: file, ok: true },
    ]);
  });

  it("leaves an agent that does not hook Claude Code, or has been retired, alone", () => {
    expect(addMissingClaudeCodeMcp(machine({ harnesses: ["codex"] }).deps)).toEqual(
      [],
    );
    expect(
      addMissingClaudeCodeMcp(
        machine({ revoked_at: "2026-10-01T00:00:00.000Z" }).deps,
      ),
    ).toEqual([]);
  });
});
