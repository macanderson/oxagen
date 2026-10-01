/**
 * `moveOffTachoNames` (#4879): which machines it moves and how it asks
 * `enroll` to re-apply them. `cli.test.ts` drives the real re-apply and reads
 * the hook files and the service unit it rewrites.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentPaths, type TachoPaths } from "../host/paths";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { CliDeps, RuntimeCommands } from "./deps";
import type { EnrollOptions, EnrollResult } from "./enroll";
import { moveOffTachoNames, namesTachoExecutable } from "./move-commands";

const OXAGEN: RuntimeCommands = {
  hookCommand: "/opt/oxagen/oxagen hook",
  credentialHelperCommand:
    "/opt/oxagen/oxagen credential issue --harness claude-code",
  daemonCommand: ["/opt/oxagen/oxagen", "daemon"],
  mcpStdioCommand: ["/opt/oxagen/oxagen", "mcp-stdio"],
  binDir: "/opt/oxagen",
  program: "oxagen",
};

describe("namesTachoExecutable", () => {
  it.each([
    ["node /opt/tacho/tacho-hook.mjs", ["node", "/opt/tacho/tachod.mjs"]],
    [
      "'/Applications/Oxagen.app/Contents/MacOS/tacho' hook",
      ["/Applications/Oxagen.app/Contents/MacOS/tacho", "daemon"],
    ],
    [
      '"C:\\Program Files\\Oxagen\\tacho.exe" hook',
      ["C:\\Program Files\\Oxagen\\tacho.exe", "daemon"],
    ],
    ["tacho-hook", ["tachod"]],
    // Either half alone is enough: the two move together.
    ["/opt/oxagen/oxagen hook", ["node", "/opt/tacho/tachod.mjs"]],
    ["node /opt/tacho/tacho-hook.mjs", ["/opt/oxagen/oxagen", "daemon"]],
  ])("finds the tacho executable in %s", (hook, daemon) => {
    expect(
      namesTachoExecutable({ hook_command: hook, daemon_command: daemon }),
    ).toBe(true);
  });

  it.each([
    ["/opt/oxagen/oxagen hook", ["/opt/oxagen/oxagen", "daemon"]],
    [
      "/usr/bin/node /usr/lib/node_modules/@oxagen/cli/oxagen.mjs hook",
      ["/usr/bin/node", "/usr/lib/node_modules/@oxagen/cli/oxagen.mjs", "daemon"],
    ],
    // A directory named tacho is not the executable.
    ["/home/dev/tacho/oxagen hook", ["/home/dev/tacho/oxagen", "daemon"]],
  ])("leaves %s alone (negative)", (hook, daemon) => {
    expect(
      namesTachoExecutable({ hook_command: hook, daemon_command: daemon }),
    ).toBe(false);
  });
});

/** A machine with one agent per entry, each enrolled with its own commands. */
function machine(
  agents: Array<{
    id: string;
    hook: string;
    daemon: string[];
    harnesses: string[];
    revoked?: boolean;
  }>,
) {
  const base = scratchPaths();
  const signer = bundleSigner();
  for (const [index, agent] of agents.entries()) {
    const paths: TachoPaths = agentPaths(base, agent.id);
    mkdirSync(dirname(paths.hostFile), { recursive: true });
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        host_enrollment_id: `tch_${String(index).padStart(22, "0")}`,
        agent_key: `acme.core.${agent.id}`,
        hook_command: agent.hook,
        daemon_command: agent.daemon,
        harnesses: agent.harnesses as never,
        enrolled_at: `2026-09-1${index}T00:00:00.000Z`,
        revoked_at: agent.revoked === true ? "2026-09-20T00:00:00.000Z" : null,
      }),
    );
  }
  const runs: EnrollOptions[] = [];
  const run = vi.fn(
    async (options: EnrollOptions): Promise<EnrollResult> => {
      runs.push(options);
      return { ok: true, warnings: [] };
    },
  );
  let installed = true;
  const deps = {
    paths: base,
    home: base.tachoDir,
    runtime: OXAGEN,
    serviceManager: {
      kind: "launchd",
      unitPath: "/fake/sh.oxagen.tachod.plist",
      install: () => undefined,
      uninstall: () => undefined,
      status: () => ({ installed, running: installed }),
    },
    out: () => undefined,
    err: () => undefined,
  } as unknown as CliDeps;
  return {
    deps,
    run,
    runs,
    uninstall: () => {
      installed = false;
    },
  };
}

describe("moveOffTachoNames", () => {
  it("re-applies each live agent on a tacho name, and only those", async () => {
    const m = machine([
      {
        id: "aaaaaaaa",
        hook: "node /opt/tacho/tacho-hook.mjs",
        daemon: ["node", "/opt/tacho/tachod.mjs"],
        harnesses: ["claude-code"],
      },
      {
        id: "bbbbbbbb",
        hook: OXAGEN.hookCommand,
        daemon: OXAGEN.daemonCommand,
        harnesses: ["codex"],
      },
      {
        id: "cccccccc",
        hook: "'/opt/tacho/tacho' hook",
        daemon: ["/opt/tacho/tacho", "daemon"],
        harnesses: ["cursor", "stella"],
      },
      {
        id: "dddddddd",
        hook: "node /opt/tacho/tacho-hook.mjs",
        daemon: ["node", "/opt/tacho/tachod.mjs"],
        harnesses: ["claude-desktop"],
        revoked: true,
      },
    ]);
    const moved = await moveOffTachoNames(m.deps, m.run);
    expect(moved).toEqual([
      {
        agentKey: "acme.core.aaaaaaaa",
        from: "node /opt/tacho/tacho-hook.mjs",
        ok: true,
      },
      {
        agentKey: "acme.core.cccccccc",
        from: "'/opt/tacho/tacho' hook",
        ok: true,
      },
    ]);
    // The harnesses name the agent, so `enroll` re-applies that one.
    expect(m.runs).toEqual([
      { harnesses: ["claude-code"] },
      { harnesses: ["cursor", "stella"] },
    ]);
  });

  it("installs no service a machine never had (negative)", async () => {
    const m = machine([
      {
        id: "aaaaaaaa",
        hook: "node /opt/tacho/tacho-hook.mjs",
        daemon: ["node", "/opt/tacho/tachod.mjs"],
        harnesses: ["claude-code"],
      },
    ]);
    m.uninstall();
    await moveOffTachoNames(m.deps, m.run);
    expect(m.runs).toEqual([{ harnesses: ["claude-code"], service: false }]);
  });

  it("keeps the agent's credential mode", async () => {
    const m = machine([
      {
        id: "aaaaaaaa",
        hook: "node /opt/tacho/tacho-hook.mjs",
        daemon: ["node", "/opt/tacho/tachod.mjs"],
        harnesses: ["claude-code", "codex"],
      },
    ]);
    const read = vi.fn(async () => ({
      harnesses: [
        { harness: "claude-code" as const, file: "/x", brokered: false },
        { harness: "codex" as const, file: "/y", brokered: false },
      ],
      taken: [],
    }));
    const deps = {
      ...m.deps,
      modelCredentials: { read },
    } as unknown as CliDeps;
    await moveOffTachoNames(deps, m.run);
    // Nothing brokered stays that way: a status must not take a key.
    expect(m.runs).toEqual([
      { harnesses: ["claude-code", "codex"], credentials: "passthrough" },
    ]);
    read.mockResolvedValueOnce({
      harnesses: [
        { harness: "claude-code" as const, file: "/x", brokered: true },
        { harness: "codex" as const, file: "/y", brokered: false },
      ],
      taken: [],
    });
    await moveOffTachoNames(deps, m.run);
    expect(m.runs.at(-1)).toEqual({
      harnesses: ["claude-code", "codex"],
      credentials: "brokered",
    });
  });

  it.each([
    ["the recorder's own layout", { ...OXAGEN, program: undefined }],
    ["a transient bin dir", { ...OXAGEN, transient: "a mounted disk image" }],
    [
      "a missing executable",
      { ...OXAGEN, executableProblem: "there is no oxagen in /opt" },
    ],
  ])("moves nothing with %s (negative)", async (_why, runtime) => {
    const m = machine([
      {
        id: "aaaaaaaa",
        hook: "node /opt/tacho/tacho-hook.mjs",
        daemon: ["node", "/opt/tacho/tachod.mjs"],
        harnesses: ["claude-code"],
      },
    ]);
    const deps = { ...m.deps, runtime } as unknown as CliDeps;
    expect(await moveOffTachoNames(deps, m.run)).toEqual([]);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("reports a re-apply that failed", async () => {
    const m = machine([
      {
        id: "aaaaaaaa",
        hook: "node /opt/tacho/tacho-hook.mjs",
        daemon: ["node", "/opt/tacho/tachod.mjs"],
        harnesses: ["claude-code"],
      },
    ]);
    m.run.mockResolvedValueOnce({ ok: false, warnings: [] });
    expect(await moveOffTachoNames(m.deps, m.run)).toEqual([
      {
        agentKey: "acme.core.aaaaaaaa",
        from: "node /opt/tacho/tacho-hook.mjs",
        ok: false,
      },
    ]);
  });
});
