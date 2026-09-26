/**
 * The agents enrolled on this machine, one directory each (ADR-202).
 *
 * An agent is an operator, a runtime and a harness (ADR-198), so a machine
 * that runs Claude Code and Codex for the same person holds two agents, each
 * with its own enrollment. A host once kept one enrollment in `host.json`,
 * and enrolling the second agent revoked the first (#4371).
 *
 * Every agent now has the same layout at `<tachoDir>/agents/<id>/`: its own
 * `host.json`, device key, run-token key, credential store, WAL, spool and
 * install receipts. The id is opaque and random, and it never changes, so a
 * harness can move between agents without moving a directory. One `tachod`
 * service serves every agent, each on its own ports. A harness belongs to at
 * most one live agent, so a hook, a run token or a model call for a harness
 * has exactly one enrollment to go to.
 *
 * A machine enrolled before ADR-202 kept its one enrollment in the tacho
 * directory itself. `listAgents` still reads it there, and `tachod` moves it
 * into `agents/` when it starts (`migrateLegacyLayout`).
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { readJsonFileIfExists } from "./fs";
import { HARNESS_BACKUPS, HARNESS_RECEIPTS } from "./harness-file";
import {
  type HostFile,
  modelProxyPortFor,
  readHostFileLenient,
} from "./host-file";
import {
  AGENT_FILES,
  agentPaths,
  pathsInDir,
  type TachoHome,
  type TachoPaths,
} from "./paths";

/** The id `listAgents` gives an enrollment still in the pre-ADR-202 layout. */
export const LEGACY_AGENT_ID = "legacy";

/** The prefix of the directory `migrateLegacyLayout` fills before it renames it into place. */
const MIGRATING_PREFIX = ".migrating-";

/** One agent's directory and what its `host.json` says. */
export interface Agent {
  /** The directory's name under `agents/`, or `LEGACY_AGENT_ID`. */
  id: string;
  paths: TachoPaths;
  /** The enrollment, when its `host.json` reads and is valid. */
  host: HostFile | undefined;
  /** True for an enrollment still in the tacho directory itself. */
  legacy: boolean;
}

/**
 * The directory of every agent that has a `host.json`: each one under
 * `agents/` by name, then the legacy one while it is there. A directory whose
 * name starts with a dot is a migration in progress and is left out. The
 * names are sorted because `readdir` order differs between filesystems, and a
 * hook that falls back to the first directory must pick the same one each
 * time.
 */
function agentDirs(home: TachoHome): { id: string; paths: TachoPaths }[] {
  let names: string[];
  try {
    names = readdirSync(home.agents);
  } catch {
    names = [];
  }
  const dirs = names
    .sort()
    .filter((name) => !name.startsWith("."))
    .map((id) => ({ id, paths: agentPaths(home, id) }))
    .filter(({ paths }) => existsSync(paths.hostFile));
  const legacy = pathsInDir(home, home.tachoDir);
  if (existsSync(legacy.hostFile))
    dirs.push({ id: LEGACY_AGENT_ID, paths: legacy });
  return dirs;
}

/**
 * Every agent on this machine, oldest enrollment first, then by id. An agent
 * whose `host.json` does not read sorts last, so a command that picks the
 * first agent picks one it can act on.
 */
export function listAgents(home: TachoHome): Agent[] {
  return agentDirs(home)
    .map(({ id, paths }) => ({
      id,
      paths,
      host: readHostFileLenient(paths.hostFile).host,
      legacy: id === LEGACY_AGENT_ID,
    }))
    .sort((a, b) => {
      if (a.host !== undefined && b.host !== undefined)
        return (
          a.host.enrolled_at.localeCompare(b.host.enrolled_at) ||
          a.id.localeCompare(b.id)
        );
      if (a.host !== undefined) return -1;
      if (b.host !== undefined) return 1;
      return a.id.localeCompare(b.id);
    });
}

/** An agent whose enrollment is in force: not retired here and not revoked on the fleet page. */
export function agentIsLive(agent: Agent): agent is Agent & { host: HostFile } {
  return (
    agent.host !== undefined &&
    agent.host.revoked_at === null &&
    agent.host.host_status !== "revoked"
  );
}

/**
 * An agent `tachod` runs a collector for: one not retired on this machine.
 * An agent revoked on the fleet page still runs until a command retires it
 * here, so its ports stay taken. An agent whose `host.json` does not read
 * runs too, so its collector fails and the log says why.
 */
export function agentServes(agent: Agent): boolean {
  return agent.host === undefined || agent.host.revoked_at === null;
}

/** The live agent that hooks `harness`, if one does. */
export function agentHolding(
  home: TachoHome,
  harness: string,
): (Agent & { host: HostFile }) | undefined {
  for (const agent of listAgents(home))
    if (agentIsLive(agent) && agent.host.harnesses.includes(harness))
      return agent;
  return undefined;
}

/**
 * The agent a command that names `harness` acts on: the live agent that
 * hooks it, else a retired one that did, whose revoke is still pending.
 */
export function agentForHarness(
  home: TachoHome,
  harness: string,
): Agent | undefined {
  const agents = listAgents(home);
  return (
    agents.find(
      (agent) => agentIsLive(agent) && agent.host.harnesses.includes(harness),
    ) ?? agents.find((agent) => agent.host?.harnesses.includes(harness))
  );
}

/** The live agents other than the one in `selfDir`. */
export function otherLiveAgents(home: TachoHome, selfDir: string): Agent[] {
  return listAgents(home).filter(
    (agent) => agentIsLive(agent) && agent.paths.dir !== selfDir,
  );
}

/** An agent as a message names it: its harnesses and its agent key. */
export function describeAgent(agent: Agent): string {
  if (agent.host === undefined)
    return `an unreadable enrollment in ${agent.paths.dir}`;
  const what = `${agent.host.harnesses.join(", ")} as ${agent.host.agent_key}`;
  if (agent.host.revoked_at !== null)
    return `${what} (retired on this machine)`;
  if (agent.host.host_status === "revoked")
    return `${what} (revoked on the fleet page)`;
  return what;
}

/**
 * The ports every agent `tachod` serves, other than the one in `exceptDir`,
 * listens on: its collector and its model proxy (`agentServes`). A new
 * agent's ports must avoid them.
 */
export function portsInUse(home: TachoHome, exceptDir?: string): Set<number> {
  const ports = new Set<number>();
  for (const agent of listAgents(home)) {
    if (
      agent.host === undefined ||
      !agentServes(agent) ||
      agent.paths.dir === exceptDir
    )
      continue;
    ports.add(agent.host.port);
    ports.add(modelProxyPortFor(agent.host));
  }
  return ports;
}

/**
 * The harnesses a live agent other than the one in `selfDir` hooks. An
 * agent's unenroll, and its re-enroll, must leave these harnesses' config
 * alone: restoring a harness's key or model URL, or stripping its env, would
 * unhook the agent that still holds it.
 */
export function harnessesHeldElsewhere(
  home: TachoHome,
  selfDir: string,
): Set<string> {
  const held = new Set<string>();
  for (const agent of otherLiveAgents(home, selfDir))
    for (const harness of agent.host?.harnesses ?? []) held.add(harness);
  return held;
}

/**
 * A new agent id: 8 hex characters. Short, because the agent's socket path
 * has to fit the 104 bytes macOS allows a Unix socket path.
 */
export function newAgentId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * The agent a command acts on when nothing names one: the oldest live agent,
 * else the oldest agent, else a new agent whose directory does not exist
 * yet, which is where a first `tacho enroll` writes.
 */
export function defaultAgentPaths(home: TachoHome): TachoPaths {
  const agents = listAgents(home);
  return (
    (agents.find(agentIsLive) ?? agents[0])?.paths ?? freshAgentPaths(home)
  );
}

/** The paths of a new agent whose directory does not exist yet. */
export function freshAgentPaths(
  home: TachoHome,
  mint: () => string = newAgentId,
): TachoPaths {
  for (;;) {
    const id = mint();
    const paths = agentPaths(home, id);
    if (!existsSync(paths.dir) && !existsSync(migratingDir(home, id)))
      return paths;
  }
}

/**
 * The paths a hook or `tacho mcp` uses. The entry names the enrollment it
 * was written for, and the agent with that id answers it, live or retired,
 * so a retired agent's stale-entry check refuses an entry it left behind.
 * An id no agent has gets some agent's paths, whose stale-entry check
 * refuses it. An entry written before entries named their enrollment gets
 * the agent that hooks its harness.
 *
 * Every hook calls this, so it reads only the id and harness list of each
 * agent and parses nothing else. With no agent on the machine it returns
 * paths with no `host.json`, and the hook answers that the machine is not
 * enrolled.
 */
export function agentPathsForEnrollment(
  home: TachoHome,
  enrollmentId: string | undefined,
  harness: string | undefined,
): TachoPaths {
  const dirs = agentDirs(home);
  if (enrollmentId !== undefined) {
    const match = dirs.find(
      ({ paths }) => enrollmentIdIn(paths.hostFile) === enrollmentId,
    );
    if (match !== undefined) return match.paths;
  } else if (harness !== undefined) {
    const match = dirs.find(({ paths }) =>
      harnessesIn(paths.hostFile).includes(harness),
    );
    if (match !== undefined) return match.paths;
  }
  return dirs[0]?.paths ?? pathsInDir(home, home.tachoDir);
}

/** A field of a `host.json`, read without parsing the rest. */
function hostField(hostFile: string, field: string): unknown {
  try {
    const value = readJsonFileIfExists(hostFile);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

/** The `host_enrollment_id` in a `host.json`. */
export function enrollmentIdIn(hostFile: string): unknown {
  return hostField(hostFile, "host_enrollment_id");
}

/** The harnesses a `host.json` hooks, or none when they do not read. */
function harnessesIn(hostFile: string): string[] {
  const value = hostField(hostFile, "harnesses");
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function migratingDir(home: TachoHome, id: string): string {
  return join(home.agents, `${MIGRATING_PREFIX}${id}`);
}

/** Every name the legacy layout kept in the tacho directory for its enrollment. */
function legacyNames(): string[] {
  return [
    ...Object.values(AGENT_FILES).filter(
      (name) => name !== AGENT_FILES.hostFile,
    ),
    HARNESS_RECEIPTS,
    HARNESS_BACKUPS,
  ];
}

/**
 * Moves `from` to `to`. A directory that already exists at `to` takes
 * `from`'s entries one by one, so a spool file a hook wrote into the old
 * place while the move ran lands beside the ones moved before it. A file
 * that exists at both stays where it is.
 */
function moveInto(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (!existsSync(to)) {
    renameSync(from, to);
    return;
  }
  if (!statSync(from).isDirectory() || !statSync(to).isDirectory()) return;
  for (const name of readdirSync(from))
    moveInto(join(from, name), join(to, name));
  try {
    rmdirSync(from);
  } catch {
    // Something is still in it, or a hook wrote into it again. The next
    // start sweeps it.
  }
}

/**
 * Moves an enrollment kept in the tacho directory itself (the layout before
 * ADR-202) into `agents/<id>/`, and returns the id, or undefined when there
 * was nothing to move.
 *
 * Only `tachod` calls this, at startup and before any collector runs. It
 * fills `agents/.migrating-<id>/` first and moves `host.json` last, so until
 * the rename that ends it, every reader still finds the enrollment where it
 * was. A start that finds a `.migrating-` directory finishes that move
 * instead of starting another. A hook can write to the spool or the
 * quarantine while the move runs, so the entries that reappear in the tacho
 * directory are swept into the agent's directory afterwards.
 */
export function migrateLegacyLayout(
  home: TachoHome,
  mint: () => string = newAgentId,
): string | undefined {
  const legacy = pathsInDir(home, home.tachoDir);
  let pending: string | undefined;
  try {
    pending = readdirSync(home.agents).find((name) =>
      name.startsWith(MIGRATING_PREFIX),
    );
  } catch {
    pending = undefined;
  }
  if (pending === undefined && !existsSync(legacy.hostFile)) return undefined;

  let id: string;
  if (pending === undefined) {
    id = freshAgentPaths(home, mint).dir.slice(home.agents.length + 1);
    mkdirSync(migratingDir(home, id), { recursive: true, mode: 0o700 });
  } else {
    id = pending.slice(MIGRATING_PREFIX.length);
  }
  const staging = migratingDir(home, id);
  for (const name of legacyNames())
    moveInto(join(home.tachoDir, name), join(staging, name));
  moveInto(legacy.hostFile, join(staging, AGENT_FILES.hostFile));

  const target = agentPaths(home, id).dir;
  renameSync(staging, target);
  for (const name of legacyNames())
    moveInto(join(home.tachoDir, name), join(target, name));
  return id;
}
