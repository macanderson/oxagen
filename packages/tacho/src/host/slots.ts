/**
 * Enrollment slots: one directory per enrollment on this machine (ADR-202).
 *
 * An agent is an operator, a runtime and a harness (ADR-198), so a machine
 * that runs Claude Code and Codex for the same person is two agents, each
 * with its own enrollment. A host once kept one enrollment in `host.json`,
 * and enrolling the second agent revoked the first (#4371).
 *
 * The first enrollment keeps the layout it always had, directly under the
 * tacho root. Every later one gets a slot of its own at
 * `<root>/agents/<harness>/`, holding the same files the root does: its own
 * `host.json`, device key, local token, credential store, WAL and spool. One
 * `tachod` process serves every slot, each on its own ports. A harness
 * belongs to at most one live slot, so a hook, a run token or a model call
 * for a harness has exactly one enrollment to go to.
 *
 * The harness config files (Claude Code's settings, Codex's hooks and the
 * rest) are the user's, not a slot's, so a slot's paths keep them as the
 * root resolved them.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { TachoHarness } from "../wire";
import { tachoHarnessSchema } from "../wire";
import { readJsonFileIfExists } from "./fs";
import {
  type HostFile,
  modelProxyPortFor,
  readHostFileLenient,
} from "./host-file";
import type { TachoPaths } from "./paths";

/** The directory under the tacho root that holds every slot after the first. */
export const SLOTS_DIR = "agents";

/**
 * The paths that belong to one enrollment and move with its slot. Listing
 * them here, rather than excluding the harness paths, makes a new
 * `TachoPaths` field a type error until someone decides which kind it is.
 */
const SLOT_STATE: Record<
  Exclude<
    keyof TachoPaths,
    | "root"
    | "claudeSettings"
    | "claudeProjects"
    | "codexHooks"
    | "cursorHooks"
    | "stellaToml"
    | "stellaSettingsJson"
    | "claudeDesktopConfig"
  >,
  true
> = {
  hostFile: true,
  deviceKey: true,
  runTokenKey: true,
  credentials: true,
  credentialsKey: true,
  socket: true,
  wal: true,
  spool: true,
  quarantine: true,
  daemonState: true,
  daemonSealedState: true,
  pendingEnds: true,
  hookIdJournal: true,
  transcriptTailState: true,
  preSessionCopies: true,
  stellaIdentity: true,
  pid: true,
  log: true,
  daemonLauncher: true,
};

/** One enrollment's directory and what its `host.json` says. */
export interface Slot {
  /** The harness the slot was made for; undefined for the root slot. */
  harness: TachoHarness | undefined;
  paths: TachoPaths;
  /** The enrollment, when its `host.json` is there and valid. */
  host: HostFile | undefined;
}

/** `root`'s paths moved into the slot for `harness`. */
export function slotPaths(root: TachoPaths, harness: TachoHarness): TachoPaths {
  const dir = join(root.root, SLOTS_DIR, harness);
  const paths: TachoPaths = { ...root, root: dir };
  for (const key of Object.keys(SLOT_STATE) as (keyof typeof SLOT_STATE)[])
    paths[key] = join(dir, basename(root[key]));
  return paths;
}

/** The harness names that have a slot directory with a `host.json` in it. */
function subSlotHarnesses(root: TachoPaths): TachoHarness[] {
  let names: string[];
  try {
    names = readdirSync(join(root.root, SLOTS_DIR));
  } catch {
    return [];
  }
  return names
    .map((name) => tachoHarnessSchema.safeParse(name))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .filter((harness) => existsSync(slotPaths(root, harness).hostFile))
    .sort();
}

/**
 * Every slot on this machine: the root first, whether or not it holds an
 * enrollment, then each slot under `agents/` that has a `host.json`.
 */
export function listSlots(root: TachoPaths): Slot[] {
  const read = (paths: TachoPaths) => readHostFileLenient(paths.hostFile).host;
  return [
    { harness: undefined, paths: root, host: read(root) },
    ...subSlotHarnesses(root).map((harness) => {
      const paths = slotPaths(root, harness);
      return { harness, paths, host: read(paths) };
    }),
  ];
}

/** A slot whose enrollment is in force: not retired here and not revoked on the fleet page. */
export function slotIsLive(slot: Slot): slot is Slot & { host: HostFile } {
  return (
    slot.host !== undefined &&
    slot.host.revoked_at === null &&
    slot.host.host_status !== "revoked"
  );
}

/** The slots after the root that hold a live enrollment. */
export function liveSubSlots(root: TachoPaths): Slot[] {
  return listSlots(root)
    .slice(1)
    .filter((slot) => slotIsLive(slot));
}

/** The live slot that hooks `harness`, if one does. */
export function slotHolding(
  root: TachoPaths,
  harness: string,
): (Slot & { host: HostFile }) | undefined {
  for (const slot of listSlots(root))
    if (slotIsLive(slot) && slot.host.harnesses.includes(harness)) return slot;
  return undefined;
}

/**
 * The slot a command that names `harness` acts on: the live slot that hooks
 * it, else a retired slot that did (its revoke still pending), else the slot
 * made for it whose `host.json` cannot be read.
 */
export function slotForHarness(
  root: TachoPaths,
  harness: TachoHarness,
): Slot | undefined {
  const slots = listSlots(root);
  return (
    slots.find(
      (slot) => slotIsLive(slot) && slot.host.harnesses.includes(harness),
    ) ??
    slots.find((slot) => slot.host?.harnesses.includes(harness) === true) ??
    slots.find((slot) => slot.harness === harness)
  );
}

/**
 * The slots that hold an enrollment, live or not: the root when it has a
 * `host.json`, and every slot after it.
 */
export function enrolledSlots(root: TachoPaths): Slot[] {
  return listSlots(root).filter(
    (slot) => slot.harness !== undefined || existsSync(root.hostFile),
  );
}

/** The live slots other than the one at `self`. */
export function otherLiveSlots(root: TachoPaths, self: string): Slot[] {
  return listSlots(root).filter(
    (slot) => slotIsLive(slot) && slot.paths.root !== self,
  );
}

/** A slot as a message names it: its harnesses and its agent. */
export function describeSlot(slot: Slot): string {
  if (slot.host === undefined)
    return `an unreadable enrollment in ${slot.paths.root}`;
  const what = `${slot.host.harnesses.join(", ")} as ${slot.host.agent_key}`;
  if (slot.host.revoked_at !== null) return `${what} (retired on this machine)`;
  if (slot.host.host_status === "revoked")
    return `${what} (revoked on the fleet page)`;
  return what;
}

/**
 * The paths of the slot whose enrollment is `enrollmentId`, live or retired,
 * so a hook entry left behind by a retired slot is still answered by that
 * slot's stale-entry check. The root's paths when no slot after the root has
 * that id: either the root has it, or the id is stale and the root's check
 * says so. Every hook calls this, so it reads only the enrollment id of each
 * slot after the root, and nothing at all on a machine with one enrollment.
 */
export function slotPathsForEnrollment(
  root: TachoPaths,
  enrollmentId: string | undefined,
): TachoPaths {
  if (enrollmentId === undefined) return root;
  for (const harness of subSlotHarnesses(root)) {
    const paths = slotPaths(root, harness);
    if (enrollmentIdIn(paths.hostFile) === enrollmentId) return paths;
  }
  return root;
}

/** The `host_enrollment_id` in a `host.json`, without parsing the rest. */
function enrollmentIdIn(hostFile: string): unknown {
  try {
    const value = readJsonFileIfExists(hostFile);
    return typeof value === "object" && value !== null
      ? (value as { host_enrollment_id?: unknown }).host_enrollment_id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ports every live slot other than `except` listens on: its collector
 * and its model proxy. A new slot's ports must avoid all of them.
 */
export function portsInUse(root: TachoPaths, except?: string): Set<number> {
  const ports = new Set<number>();
  for (const slot of listSlots(root)) {
    if (!slotIsLive(slot) || slot.paths.root === except) continue;
    ports.add(slot.host.port);
    ports.add(modelProxyPortFor(slot.host));
  }
  return ports;
}

/**
 * The harnesses a live slot other than `self` hooks. A slot's unenroll, and
 * its re-enroll, must leave these harnesses' config alone: restoring a
 * harness's key or model URL, or stripping its env, would unhook the agent
 * that still holds it.
 */
export function harnessesHeldElsewhere(
  root: TachoPaths,
  self: string,
): Set<string> {
  const held = new Set<string>();
  for (const slot of listSlots(root))
    if (slotIsLive(slot) && slot.paths.root !== self)
      for (const harness of slot.host.harnesses) held.add(harness);
  return held;
}
