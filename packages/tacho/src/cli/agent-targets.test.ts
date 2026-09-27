/**
 * Which agent `enroll`, `unenroll` and `reassign` act on when a machine
 * holds more than one (ADR-203), and the deps a command gets once it is
 * bound to one agent.
 */
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Agent, listAgents } from "../host/agents";
import { type HostFile, writeHostFile } from "../host/host-file";
import { agentPaths, type TachoPaths } from "../host/paths";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import { agentDeps, depsForAgent, depsForHarness } from "./agent-deps";
import type { CliDeps } from "./deps";
import { enrollTarget } from "./enroll";
import { reassignTarget } from "./reassign";
import { unenrollTarget } from "./unenroll";

const CODEX_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";
const CODEX_ID = "0e5f6a7b";
const RETIRED = { revoked_at: "2026-09-20T00:00:00.000Z" };
const BOTH =
  "claude-code as acme.core.cc-laptop; codex as acme.core.codex-laptop";

function host(overrides: Partial<HostFile> = {}): HostFile {
  const signer = bundleSigner();
  return testHostFile(signer, signer.sign(unsignedBundle()), overrides);
}

/** Claude Code enrolled on a fresh machine. */
function oneAgent(overrides: Partial<HostFile> = {}): TachoPaths {
  const claude = scratchPaths();
  writeHostFile(claude.hostFile, host(overrides));
  return claude;
}

/** Codex enrolled a day after whatever `home` holds, in its own directory. */
function addCodex(
  home: TachoPaths,
  overrides: Partial<HostFile> = {},
): TachoPaths {
  const codex = agentPaths(home, CODEX_ID);
  writeHostFile(
    codex.hostFile,
    host({
      host_enrollment_id: CODEX_ENROLLMENT,
      agent_key: "acme.core.codex-laptop",
      harnesses: ["codex"],
      port: 47011,
      enrolled_at: "2026-09-11T00:00:00.000Z",
      ...overrides,
    }),
  );
  return codex;
}

/** The directories of the agents a target names. */
function dirsOf(target: Agent[] | { refused: string }): string[] | string {
  return "refused" in target
    ? target.refused
    : target.map((agent) => agent.paths.dir);
}

describe("enrollTarget", () => {
  it("enrolls the first agent on a machine in the directory the command started with", () => {
    const paths = scratchPaths();
    expect(enrollTarget({ harnesses: ["codex"] }, paths)).toEqual({
      paths,
      fresh: true,
    });
  });

  it("gives a harness no live agent hooks a new agent, and revokes nothing", () => {
    const claude = oneAgent();
    expect(
      enrollTarget({ harnesses: ["codex"] }, claude, () => CODEX_ID),
    ).toEqual({ paths: agentPaths(claude, CODEX_ID), fresh: true });

    // A third agent, beside a machine that already holds two.
    addCodex(claude);
    expect(
      enrollTarget({ harnesses: ["cursor"] }, claude, () => "c0c0c0c0"),
    ).toEqual({ paths: agentPaths(claude, "c0c0c0c0"), fresh: true });

    // One enroll for two harnesses no agent hooks is one new agent.
    const pair: TachoHarness[] = ["cursor", "stella"];
    const mint = () => "d0d0d0d0";
    expect(enrollTarget({ harnesses: pair }, claude, mint)).toEqual({
      paths: agentPaths(claude, "d0d0d0d0"),
      fresh: true,
    });
  });

  it("keeps a harness with the agent that already holds it", () => {
    const claude = oneAgent();
    const codex = addCodex(claude);
    expect(enrollTarget({ harnesses: ["claude-code"] }, claude)).toEqual({
      paths: claude,
      fresh: false,
    });
    expect(enrollTarget({}, claude)).toEqual({ paths: claude, fresh: false });
    expect(enrollTarget({ harnesses: ["codex"] }, claude)).toEqual({
      paths: codex,
      fresh: false,
    });
    // Adding a harness to an agent names one it already holds.
    expect(enrollTarget({ harnesses: ["codex", "cursor"] }, claude)).toEqual({
      paths: codex,
      fresh: false,
    });
  });

  it("re-applies a machine's one agent when the enroll names no harness, whatever it hooks", () => {
    const stella = oneAgent({ harnesses: ["stella"] });
    expect(enrollTarget({}, stella, () => "unused00")).toEqual({
      paths: stella,
      fresh: false,
    });
    const retired = oneAgent({ harnesses: ["codex"], ...RETIRED });
    expect(enrollTarget({}, retired, () => "unused00")).toEqual({
      paths: retired,
      fresh: false,
    });
    // With two, the harness defaults to claude-code: a new agent for it.
    addCodex(stella);
    expect(enrollTarget({}, stella, () => "c1c1c1c1")).toEqual({
      paths: agentPaths(stella, "c1c1c1c1"),
      fresh: true,
    });
  });

  it("reuses the directory of a retired agent that hooked the harness, with its device key and ports", () => {
    const claude = oneAgent();
    const codex = addCodex(claude, RETIRED);
    expect(
      enrollTarget({ harnesses: ["codex"] }, claude, () => "unused00"),
    ).toEqual({ paths: codex, fresh: false });

    // A retired agent that hooked something else is left alone.
    const retired = oneAgent(RETIRED);
    expect(
      enrollTarget({ harnesses: ["codex"] }, retired, () => CODEX_ID),
    ).toEqual({ paths: agentPaths(retired, CODEX_ID), fresh: true });
  });

  it("refuses one enroll across two agents", () => {
    const claude = oneAgent();
    addCodex(claude);
    const across = enrollTarget(
      { harnesses: ["claude-code", "codex"] },
      claude,
    );
    expect("refusal" in across && across.refusal).toBe(
      `Those harnesses belong to different agents on this machine (${BOTH}), so one enroll cannot cover them. Enroll one agent at a time.`,
    );
  });

  it("does not mark a directory an enroll lost part way as fresh, so a failed retry leaves it", () => {
    const paths = scratchPaths();
    mkdirSync(paths.dir, { recursive: true });
    expect(enrollTarget({ harnesses: ["codex"] }, paths)).toEqual({
      paths,
      fresh: false,
    });
  });
});

describe("unenrollTarget", () => {
  it("takes the one agent, or none on a machine with none", () => {
    const empty = scratchPaths();
    expect(unenrollTarget(empty, undefined)).toEqual([]);
    expect(unenrollTarget(empty, "codex")).toEqual([]);

    const claude = oneAgent();
    expect(dirsOf(unenrollTarget(claude, undefined))).toEqual([claude.dir]);

    // One agent, enrolled after another was removed.
    const moved = scratchPaths();
    const codex = addCodex(moved);
    expect(dirsOf(unenrollTarget(moved, undefined))).toEqual([codex.dir]);
  });

  it("refuses to pick one of two agents for a command that named neither", () => {
    const claude = oneAgent();
    addCodex(claude);
    expect(unenrollTarget(claude, undefined)).toEqual({
      refused: `this machine holds 2 enrollments: ${BOTH}. Pass --harness to name the one to remove, or --all to remove them all`,
    });
  });

  it("takes the agent that hooks the named harness, retired or not", () => {
    const claude = oneAgent();
    const codex = addCodex(claude);
    expect(dirsOf(unenrollTarget(claude, "codex"))).toEqual([codex.dir]);
    expect(dirsOf(unenrollTarget(claude, "claude-code"))).toEqual([
      claude.dir,
    ]);
    expect(unenrollTarget(claude, "cursor")).toEqual({
      refused: `no enrollment on this machine hooks cursor. It holds ${BOTH}`,
    });

    const retired = oneAgent();
    const retiredCodex = addCodex(retired, RETIRED);
    expect(dirsOf(unenrollTarget(retired, "codex"))).toEqual([
      retiredCodex.dir,
    ]);
  });
});

describe("reassignTarget", () => {
  it("takes the one agent without --harness, and none on a machine with none", () => {
    const claude = oneAgent();
    const only = reassignTarget(claude, undefined);
    expect(only !== undefined && "paths" in only && only.paths.dir).toBe(
      claude.dir,
    );
    expect(reassignTarget(scratchPaths(), undefined)).toBeUndefined();
  });

  it("needs --harness to name one of two agents", () => {
    const claude = oneAgent();
    const codex = addCodex(claude);
    expect(reassignTarget(claude, undefined)).toEqual({
      refused: `This machine holds 2 enrollments: ${BOTH}. Pass --harness with the harnesses of the one to reassign.`,
    });
    const byCodex = reassignTarget(claude, ["codex", "cursor"]);
    expect(byCodex).toMatchObject({ paths: codex });
    expect(reassignTarget(claude, ["claude-code", "codex"])).toEqual({
      refused: `--harness names the harnesses of more than one agent: ${BOTH}. Reassign one agent at a time.`,
    });
    expect(reassignTarget(claude, ["cursor"])).toEqual({
      refused: `No enrollment on this machine hooks cursor. It holds ${BOTH}. Pass --harness with a harness one of them hooks. To enroll another agent, register it on the Agents page and run the command the page shows.`,
    });
  });
});

describe("agent deps", () => {
  function depsAt(paths: TachoPaths): CliDeps {
    return {
      paths,
      env: { AGENT: "first" },
      serviceManager: { kind: "launchd" },
      out: () => undefined,
      err: () => undefined,
    } as unknown as CliDeps;
  }

  it("rebinds everything but the service and the terminal to the agent", () => {
    const claude = oneAgent();
    const codex = addCodex(claude);
    const deps = depsAt(claude);
    expect(agentDeps(deps, claude)).toBe(deps);

    const bound = agentDeps(deps, codex);
    expect(bound.paths).toBe(codex);
    expect(bound.serviceManager).toBe(deps.serviceManager);
    expect(bound.out).toBe(deps.out);
    expect(bound.err).toBe(deps.err);

    // Every agent is a peer: back from Codex to Claude Code is one more rebind.
    expect(agentDeps(bound, claude).paths).toBe(claude);
  });

  it("builds the agent's deps with atAgent when the CLI provides it", () => {
    const claude = oneAgent();
    const codex = addCodex(claude);
    const deps = depsAt(claude);
    deps.atAgent = (paths) =>
      ({
        ...depsAt(paths),
        env: { AGENT: "codex" },
        serviceManager: { kind: "other" },
      }) as unknown as CliDeps;
    const bound = agentDeps(deps, codex);
    expect(bound.env).toEqual({ AGENT: "codex" });
    expect(bound.paths).toBe(codex);
    expect(bound.serviceManager).toBe(deps.serviceManager);
    expect(bound.out).toBe(deps.out);
  });

  it("routes a harness to the agent that hooks it, from any agent's deps", () => {
    const claude = oneAgent();
    const codex = addCodex(claude);
    const deps = depsAt(claude);
    expect(depsForHarness(deps, "codex").paths).toEqual(codex);
    expect(depsForHarness(deps, "claude-code")).toBe(deps);
    expect(depsForHarness(deps, "cursor")).toBe(deps);

    const fromCodex = depsForHarness(deps, "codex");
    expect(depsForHarness(fromCodex, "claude-code").paths).toEqual(claude);

    const [first, second] = listAgents(claude);
    expect(first && depsForAgent(deps, first)).toBe(deps);
    expect(second && depsForAgent(deps, second).paths).toEqual(codex);
  });

  it("points a command at the harness files the agent's enroll recorded", () => {
    const claude = oneAgent();
    const codex = addCodex(claude, {
      harness_files: { codex_hooks: "/elsewhere/codex/hooks.json" },
    });
    const bound = depsForHarness(depsAt(claude), "codex");
    expect(bound.paths.dir).toBe(codex.dir);
    expect(bound.paths.codexHooks).toBe("/elsewhere/codex/hooks.json");
    expect(bound.paths.claudeSettings).toBe(codex.claudeSettings);
  });
});
