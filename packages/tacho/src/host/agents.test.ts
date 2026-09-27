/**
 * The agents on one machine (ADR-203): every agent's directory has the same
 * layout, which agent holds a harness, which ports and harnesses another
 * agent holds, and the move of a pre-ADR-203 enrollment into `agents/`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Agent,
  agentForHarness,
  agentHolding,
  agentIsLive,
  agentPathsForEnrollment,
  agentServes,
  defaultAgentPaths,
  describeAgent,
  enrollmentIdIn,
  freshAgentPaths,
  harnessesHeldElsewhere,
  LEGACY_AGENT_ID,
  listAgents,
  migrateLegacyLayout,
  newAgentId,
  otherLiveAgents,
  portsInUse,
} from "./agents";
import { HARNESS_BACKUPS, HARNESS_RECEIPTS } from "./harness-file";
import { type HostFile, writeHostFile } from "./host-file";
import {
  AGENT_FILES,
  agentPaths,
  homeOf,
  pathsInDir,
  type TachoPaths,
} from "./paths";
import {
  bundleSigner,
  scratchPaths,
  TEST_AGENT_ID,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "./test-support";

const CODEX_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";
/** Sorts before `TEST_AGENT_ID`, so a test can tell id order from enroll order. */
const CODEX_ID = "0e5f6a7b";
const RETIRED = { revoked_at: "2026-09-20T00:00:00.000Z" };
const FLEET_REVOKED = { host_status: "revoked" } as const;

function host(overrides: Partial<HostFile> = {}): HostFile {
  const signer = bundleSigner();
  return testHostFile(signer, signer.sign(unsignedBundle()), overrides);
}

/**
 * A machine with two agents: Claude Code enrolled first on port 47001, and
 * Codex enrolled a day later on port 47011.
 */
function twoAgents(codexOverrides: Partial<HostFile> = {}): {
  claude: TachoPaths;
  codex: TachoPaths;
} {
  const claude = scratchPaths();
  writeHostFile(claude.hostFile, host());
  const codex = agentPaths(claude, CODEX_ID);
  writeHostFile(
    codex.hostFile,
    host({
      host_enrollment_id: CODEX_ENROLLMENT,
      agent_key: "acme.core.codex-laptop",
      harnesses: ["codex"],
      port: 47011,
      enrolled_at: "2026-09-11T00:00:00.000Z",
      ...codexOverrides,
    }),
  );
  return { claude, codex };
}

/** The agent listed in `dir`. */
function agentIn(home: TachoPaths, dir: string): Agent {
  const agent = listAgents(home).find((each) => each.paths.dir === dir);
  if (agent === undefined) throw new Error(`no agent in ${dir}`);
  return agent;
}

/** The arguments `agentIn` takes for the Codex agent of a `twoAgents` machine. */
function pair(machine: { claude: TachoPaths; codex: TachoPaths }): [
  TachoPaths,
  string,
] {
  return [machine.claude, machine.codex.dir];
}

describe("agentPaths", () => {
  it("gives every agent the same files in its own directory, and the machine's paths unchanged", () => {
    const home = homeOf(scratchPaths());
    const first = agentPaths(home, TEST_AGENT_ID);
    const second = agentPaths(home, CODEX_ID);
    for (const [paths, id] of [
      [first, TEST_AGENT_ID],
      [second, CODEX_ID],
    ] as const) {
      const dir = join(home.tachoDir, "agents", id);
      expect(paths.dir).toBe(dir);
      for (const [key, name] of Object.entries(AGENT_FILES))
        expect(paths[key as keyof typeof AGENT_FILES]).toBe(join(dir, name));
      expect(homeOf(paths)).toEqual(home);
    }
  });
});

describe("listAgents", () => {
  it("lists nothing on a machine that was never enrolled", () => {
    expect(listAgents(scratchPaths())).toEqual([]);
  });

  it("lists every agent oldest enrollment first, and skips a directory with no host.json or a leading dot", () => {
    const { claude, codex } = twoAgents();
    mkdirSync(join(claude.agents, "empty"), { recursive: true });
    mkdirSync(join(claude.agents, ".migrating-feedface"), { recursive: true });
    writeHostFile(
      join(claude.agents, ".migrating-feedface", "host.json"),
      host({ host_enrollment_id: "tch_migrating000000000000" }),
    );
    const agents = listAgents(claude);
    expect(agents.map((agent) => agent.id)).toEqual([TEST_AGENT_ID, CODEX_ID]);
    expect(agents.map((agent) => agent.paths.dir)).toEqual([
      claude.dir,
      codex.dir,
    ]);
    expect(agents.map((agent) => agent.host?.host_enrollment_id)).toEqual([
      TEST_ENROLLMENT,
      CODEX_ENROLLMENT,
    ]);
    expect(agents.every((agent) => !agent.legacy)).toBe(true);
  });

  it("sorts an agent whose host.json does not read last", () => {
    const { claude, codex } = twoAgents();
    writeFileSync(claude.hostFile, "{ not json");
    const agents = listAgents(claude);
    expect(agents.map((agent) => agent.paths.dir)).toEqual([
      codex.dir,
      claude.dir,
    ]);
    expect(agents[1]?.host).toBeUndefined();
  });

  it("reads an enrollment still in the tacho directory as the legacy agent", () => {
    const { claude } = twoAgents();
    const legacy = pathsInDir(claude, claude.tachoDir);
    writeHostFile(
      legacy.hostFile,
      host({
        host_enrollment_id: "tch_legacy0000000000000000",
        enrolled_at: "2026-09-01T00:00:00.000Z",
      }),
    );
    const agents = listAgents(claude);
    expect(agents.map((agent) => agent.id)).toEqual([
      LEGACY_AGENT_ID,
      TEST_AGENT_ID,
      CODEX_ID,
    ]);
    expect(agents[0]?.legacy).toBe(true);
    expect(agents[0]?.paths).toEqual(legacy);
  });
});

describe("live agents", () => {
  it("treats an agent retired here, or revoked on the fleet page, as no longer holding its harness", () => {
    const retired = twoAgents(RETIRED);
    const retiredCodex = agentIn(retired.claude, retired.codex.dir);
    expect(agentIsLive(retiredCodex)).toBe(false);
    expect(agentHolding(retired.claude, "codex")).toBeUndefined();
    expect(describeAgent(retiredCodex)).toBe(
      "codex as acme.core.codex-laptop (retired on this machine)",
    );

    const fleet = twoAgents(FLEET_REVOKED);
    const fleetCodex = agentIn(fleet.claude, fleet.codex.dir);
    expect(agentIsLive(fleetCodex)).toBe(false);
    expect(agentHolding(fleet.claude, "codex")).toBeUndefined();
    expect(describeAgent(fleetCodex)).toBe(
      "codex as acme.core.codex-laptop (revoked on the fleet page)",
    );
  });

  it("serves every agent not retired here, including one revoked on the fleet page and one that does not read", () => {
    expect(agentServes(agentIn(...pair(twoAgents())))).toBe(true);
    expect(agentServes(agentIn(...pair(twoAgents(FLEET_REVOKED))))).toBe(
      true,
    );
    expect(agentServes(agentIn(...pair(twoAgents(RETIRED))))).toBe(false);

    const unreadable = twoAgents();
    writeFileSync(unreadable.codex.hostFile, "{ not json");
    const agent = agentIn(unreadable.claude, unreadable.codex.dir);
    expect(agentServes(agent)).toBe(true);
    expect(agentIsLive(agent)).toBe(false);
    expect(describeAgent(agent)).toBe(
      `an unreadable enrollment in ${unreadable.codex.dir}`,
    );
  });
});

describe("the agent that holds a harness", () => {
  it("finds the live agent that hooks each harness, and none for a harness no agent hooks", () => {
    const { claude, codex } = twoAgents();
    expect(agentHolding(claude, "claude-code")?.paths.dir).toBe(claude.dir);
    expect(agentHolding(claude, "codex")?.paths.dir).toBe(codex.dir);
    expect(agentHolding(claude, "cursor")).toBeUndefined();
    expect(describeAgent(agentIn(claude, codex.dir))).toBe(
      "codex as acme.core.codex-laptop",
    );
  });

  it("falls back to a retired agent that hooked the harness, so an unenroll can still clear it", () => {
    const retired = twoAgents(RETIRED);
    expect(agentForHarness(retired.claude, "codex")?.paths.dir).toBe(
      retired.codex.dir,
    );
    expect(agentForHarness(retired.claude, "cursor")).toBeUndefined();
  });

  it("prefers the live agent over a retired one that hooked the same harness", () => {
    const { claude, codex } = twoAgents(RETIRED);
    const again = agentPaths(claude, "fedcba98");
    writeHostFile(
      again.hostFile,
      host({
        host_enrollment_id: "tch_again0000000000000000",
        harnesses: ["codex"],
        port: 47021,
        enrolled_at: "2026-09-21T00:00:00.000Z",
      }),
    );
    expect(agentForHarness(claude, "codex")?.paths.dir).toBe(again.dir);
    expect(agentHolding(claude, "codex")?.paths.dir).toBe(again.dir);
    expect(codex.dir).not.toBe(again.dir);
  });
});

describe("agentPathsForEnrollment", () => {
  it("routes a hook by the enrollment id it carries, live or retired", () => {
    const { claude, codex } = twoAgents();
    expect(agentPathsForEnrollment(claude, CODEX_ENROLLMENT, "codex")).toEqual(
      codex,
    );
    expect(
      agentPathsForEnrollment(claude, TEST_ENROLLMENT, "claude-code"),
    ).toEqual(claude);

    // A retired agent still answers its own stale hook entries.
    const retired = twoAgents(RETIRED);
    expect(
      agentPathsForEnrollment(retired.claude, CODEX_ENROLLMENT, "codex"),
    ).toEqual(retired.codex);
  });

  it("goes by the id over the harness when the two disagree", () => {
    const { claude } = twoAgents();
    // An entry Claude Code's enroll wrote into Codex's config still reaches
    // the agent that wrote it, whose stale-entry check refuses it.
    expect(agentPathsForEnrollment(claude, TEST_ENROLLMENT, "codex")).toEqual(
      claude,
    );
  });

  it("routes an entry with no id by its harness, and an unknown id to the first directory by name", () => {
    const { claude, codex } = twoAgents();
    expect(agentPathsForEnrollment(claude, undefined, "codex")).toEqual(codex);
    expect(agentPathsForEnrollment(claude, undefined, "claude-code")).toEqual(
      claude,
    );
    // Sorted, so the answer does not depend on the filesystem's readdir order.
    const [first] = [claude, codex].sort((a, b) =>
      basename(a.dir) < basename(b.dir) ? -1 : 1,
    );
    expect(agentPathsForEnrollment(claude, "tch_unknown", "codex").dir).toBe(
      first?.dir,
    );
  });

  it("gives paths with no host.json on a machine with no agent", () => {
    const home = homeOf(scratchPaths());
    const paths = agentPathsForEnrollment(home, TEST_ENROLLMENT, "codex");
    expect(existsSync(paths.hostFile)).toBe(false);
    expect(paths).toEqual(pathsInDir(home, home.tachoDir));
  });

  it("reads the id without validating the rest of host.json", () => {
    const paths = scratchPaths();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.hostFile,
      JSON.stringify({ host_enrollment_id: CODEX_ENROLLMENT }),
    );
    expect(enrollmentIdIn(paths.hostFile)).toBe(CODEX_ENROLLMENT);
    writeFileSync(paths.hostFile, "{ not json");
    expect(enrollmentIdIn(paths.hostFile)).toBeUndefined();
    expect(enrollmentIdIn(join(paths.dir, "missing.json"))).toBeUndefined();
  });
});

describe("what another agent holds", () => {
  it("lists the other live agents and the harnesses they hook", () => {
    const { claude, codex } = twoAgents();
    expect(
      otherLiveAgents(claude, codex.dir).map((agent) => agent.paths.dir),
    ).toEqual([claude.dir]);
    expect(harnessesHeldElsewhere(claude, codex.dir)).toEqual(
      new Set(["claude-code"]),
    );
    expect(harnessesHeldElsewhere(claude, claude.dir)).toEqual(
      new Set(["codex"]),
    );

    const retired = twoAgents(RETIRED);
    expect(otherLiveAgents(retired.claude, retired.claude.dir)).toEqual([]);
    expect(harnessesHeldElsewhere(retired.claude, retired.claude.dir)).toEqual(
      new Set(),
    );
  });

  it("reserves the collector and model proxy port of every agent tachod serves", () => {
    const { claude, codex } = twoAgents();
    expect(portsInUse(claude)).toEqual(new Set([47001, 47002, 47011, 47012]));
    expect(portsInUse(claude, codex.dir)).toEqual(new Set([47001, 47002]));

    const pinned = twoAgents({ model_proxy_port: 47100 });
    expect(portsInUse(pinned.claude)).toEqual(
      new Set([47001, 47002, 47011, 47100]),
    );

    // A retired agent's collector is stopped, so its ports are free again.
    const retired = twoAgents(RETIRED);
    expect(portsInUse(retired.claude)).toEqual(new Set([47001, 47002]));

    // One revoked on the fleet page still runs until a command retires it.
    const fleet = twoAgents(FLEET_REVOKED);
    expect(portsInUse(fleet.claude)).toEqual(
      new Set([47001, 47002, 47011, 47012]),
    );
  });
});

describe("the agent a command acts on by default", () => {
  it("picks the oldest live agent, else the oldest agent, else a new directory", () => {
    const { claude } = twoAgents();
    expect(defaultAgentPaths(claude).dir).toBe(claude.dir);

    const retiredFirst = twoAgents();
    writeHostFile(retiredFirst.claude.hostFile, host(RETIRED));
    expect(defaultAgentPaths(retiredFirst.claude).dir).toBe(
      retiredFirst.codex.dir,
    );

    const allRetired = twoAgents(RETIRED);
    writeHostFile(allRetired.claude.hostFile, host(RETIRED));
    expect(defaultAgentPaths(allRetired.claude).dir).toBe(
      allRetired.claude.dir,
    );

    const bare = homeOf(scratchPaths());
    const fresh = defaultAgentPaths(bare);
    expect(fresh.dir.startsWith(`${bare.agents}/`)).toBe(true);
    expect(existsSync(fresh.dir)).toBe(false);
  });

  it("mints a new id until one names no directory and no move in progress", () => {
    const home = scratchPaths();
    mkdirSync(join(home.agents, "taken000"), { recursive: true });
    mkdirSync(join(home.agents, ".migrating-moving00"), { recursive: true });
    const ids = ["taken000", "moving00", "free0000"];
    const paths = freshAgentPaths(home, () => ids.shift() as string);
    expect(paths.dir).toBe(join(home.agents, "free0000"));
    expect(ids).toEqual([]);
    expect(newAgentId()).toMatch(/^[0-9a-f]{8}$/);
  });
});

/** Writes an enrollment in the layout before ADR-203, with a file in each place. */
function legacyMachine(): { home: TachoPaths; legacy: TachoPaths } {
  const home = scratchPaths();
  const legacy = pathsInDir(home, home.tachoDir);
  writeHostFile(legacy.hostFile, host());
  writeFileSync(legacy.deviceKey, "device key");
  writeFileSync(legacy.runTokenKey, "run-token key");
  mkdirSync(legacy.wal, { recursive: true });
  writeFileSync(join(legacy.wal, "session.jsonl"), "{}\n");
  mkdirSync(legacy.spool, { recursive: true });
  writeFileSync(join(legacy.spool, "early.json"), "{}");
  writeFileSync(join(home.tachoDir, HARNESS_RECEIPTS), "{}");
  mkdirSync(join(home.tachoDir, HARNESS_BACKUPS), { recursive: true });
  writeFileSync(join(home.tachoDir, HARNESS_BACKUPS, "settings.json"), "{}");
  writeFileSync(home.log, "log line\n");
  return { home, legacy };
}

describe("migrateLegacyLayout", () => {
  it("does nothing on a machine already in agents/ or never enrolled", () => {
    const bare = scratchPaths();
    expect(migrateLegacyLayout(bare, () => "unused00")).toBeUndefined();
    expect(existsSync(bare.agents)).toBe(false);

    const { claude } = twoAgents();
    expect(migrateLegacyLayout(claude, () => "unused00")).toBeUndefined();
    expect(readdirSync(claude.agents).sort()).toEqual(
      [CODEX_ID, TEST_AGENT_ID].sort(),
    );
  });

  it("moves the enrollment, its keys, its WAL, spool and receipts into agents/<id>/ and leaves the service's log", () => {
    const { home, legacy } = legacyMachine();
    expect(migrateLegacyLayout(home, () => "m1000000")).toBe("m1000000");
    const moved = agentPaths(home, "m1000000");
    expect(existsSync(legacy.hostFile)).toBe(false);
    expect(readFileSync(moved.deviceKey, "utf8")).toBe("device key");
    expect(readFileSync(moved.runTokenKey, "utf8")).toBe("run-token key");
    expect(existsSync(join(moved.wal, "session.jsonl"))).toBe(true);
    expect(existsSync(join(moved.spool, "early.json"))).toBe(true);
    expect(existsSync(join(moved.dir, HARNESS_RECEIPTS))).toBe(true);
    expect(existsSync(join(moved.dir, HARNESS_BACKUPS, "settings.json"))).toBe(
      true,
    );
    for (const name of [
      ...Object.values(AGENT_FILES),
      HARNESS_RECEIPTS,
      HARNESS_BACKUPS,
    ])
      expect(existsSync(join(home.tachoDir, name))).toBe(false);
    expect(readFileSync(home.log, "utf8")).toBe("log line\n");
    const agents = listAgents(home);
    expect(agents.map((agent) => [agent.id, agent.legacy])).toEqual([
      ["m1000000", false],
    ]);
    expect(agents[0]?.host?.host_enrollment_id).toBe(TEST_ENROLLMENT);
  });

  it("finishes a move a crash left part way, and sweeps in a spool file a hook wrote meanwhile", () => {
    const { home, legacy } = legacyMachine();
    // The crashed start had moved the device key and the first spool file.
    const staging = join(home.agents, ".migrating-m2000000");
    mkdirSync(join(staging, AGENT_FILES.spool), { recursive: true });
    renameSync(legacy.deviceKey, join(staging, AGENT_FILES.deviceKey));
    writeFileSync(join(staging, AGENT_FILES.spool, "moved.json"), "{}");
    writeFileSync(join(legacy.spool, "late.json"), "{}");

    expect(migrateLegacyLayout(home, () => "unused00")).toBe("m2000000");
    const moved = agentPaths(home, "m2000000");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(moved.hostFile)).toBe(true);
    expect(readFileSync(moved.deviceKey, "utf8")).toBe("device key");
    expect(existsSync(legacy.deviceKey)).toBe(false);
    expect(readdirSync(moved.spool).sort()).toEqual([
      "early.json",
      "late.json",
      "moved.json",
    ]);
    expect(existsSync(legacy.spool)).toBe(false);
  });

  it("finishes a move whose host.json had already gone into the staging directory", () => {
    const home = scratchPaths();
    const staging = join(home.agents, ".migrating-m3000000");
    mkdirSync(staging, { recursive: true });
    writeHostFile(join(staging, AGENT_FILES.hostFile), host());
    expect(migrateLegacyLayout(home, () => "unused00")).toBe("m3000000");
    expect(listAgents(home).map((agent) => agent.id)).toEqual(["m3000000"]);
  });
});
