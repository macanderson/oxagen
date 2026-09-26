/**
 * Deps for a command acting on one enrollment slot (`host/slots.ts`,
 * ADR-202). Everything that reads or writes an enrollment moves to the
 * slot: its `host.json`, the daemon ports behind it, its credential store
 * and its install receipts. The service and the terminal stay the root's,
 * since one `tachod` serves every slot and one person is reading.
 */
import { withRecordedHarnessFiles } from "../host/host-file";
import type { TachoPaths } from "../host/paths";
import { type Slot, slotHolding } from "../host/slots";
import type { CliDeps } from "./deps";

export function slotDeps<D extends CliDeps>(deps: D, paths: TachoPaths): D {
  const root = deps.rootPaths ?? deps.paths;
  if (paths.root === deps.paths.root) return deps;
  const rebound = deps.atSlot?.(paths) ?? { ...deps, paths };
  return {
    ...deps,
    ...rebound,
    paths,
    rootPaths: paths.root === root.root ? undefined : root,
    serviceManager: deps.serviceManager,
    out: deps.out,
    err: deps.err,
  };
}

/**
 * `deps` bound to the live slot that hooks `harness`, with the harness files
 * its enroll recorded. A command a harness runs (its credential helper, its
 * Git credential helper) names only the harness, and this is how it reaches
 * the enrollment that owns it. `deps` unchanged when no slot hooks it, so
 * the root answers as it always has.
 */
export function depsForHarness<D extends CliDeps>(deps: D, harness: string): D {
  const slot = slotHolding(rootPathsOf(deps), harness);
  return slot === undefined ? deps : depsForSlot(deps, slot);
}

/**
 * `deps` bound to `slot`, with the harness files its enroll recorded. The
 * root slot is `deps` itself, whose harness files the CLI already overlaid.
 */
export function depsForSlot<D extends CliDeps>(deps: D, slot: Slot): D {
  return slot.harness === undefined
    ? deps
    : slotDeps(deps, withRecordedHarnessFiles(slot.paths, slot.host));
}

/** The root's paths, whichever slot `deps` acts on. */
export function rootPathsOf(
  deps: Pick<CliDeps, "paths" | "rootPaths">,
): TachoPaths {
  return deps.rootPaths ?? deps.paths;
}
