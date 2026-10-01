// record-force.ts: a steering record's force, and the forces each kind may
// carry. It imports only zod, so a capability contract can enforce the rule
// without pulling the YAML reader in record.ts into the eager contracts graph
// (skill-frontmatter.test.ts). record.ts re-exports the schema and its type.
//
// The record wizard (apps/app/src/features/create/record-file.ts) and the
// Markdown import (parse_markdown_import, commit_markdown_import) read the
// rule from here, so a kind can never carry a force on one surface that it
// cannot carry on another.
import { z } from "zod";
import type { RecordKind } from "./record-kind";

/** `must` and `should` reach every request. `may` and `info` reach one they fit. */
export const recordForceSchema = z.enum(["must", "should", "may", "info"]);
export type RecordForce = z.output<typeof recordForceSchema>;

/**
 * A kind the force rule reads: one of the eight steering-record/v1 kinds, or
 * `rule`, the context-record/v0.1 kind a steering repo writes as a business
 * rule or a code rule.
 */
export type ForceKind = RecordKind | "rule";

const EVERY_FORCE: readonly RecordForce[] = ["must", "should", "may", "info"];
const SOFT_FORCES: readonly RecordForce[] = ["may", "info"];
const INFO_FORCE: readonly RecordForce[] = ["info"];

/**
 * The forces a kind may carry. A preference is soft, so it is never `must`
 * or `should`. A fact and a memory inform, so they are `info`. Every other
 * kind may carry any force.
 */
export function forcesFor(kind: ForceKind): readonly RecordForce[] {
  if (kind === "preference") return SOFT_FORCES;
  if (kind === "fact" || kind === "memory") return INFO_FORCE;
  return EVERY_FORCE;
}

/** True when a record of `kind` may carry `force`. */
export function forceAllowed(kind: ForceKind, force: RecordForce): boolean {
  return forcesFor(kind).includes(force);
}

/**
 * The force a kind takes when its text gives no signal: `should` for the
 * rule kinds, `may` for a preference, and `info` for a fact and a memory.
 */
export function defaultForceFor(kind: ForceKind): RecordForce {
  if (kind === "preference") return "may";
  if (kind === "fact" || kind === "memory") return "info";
  return "should";
}

/** `force` when the kind allows it, else the kind's default. */
export function clampForce(
  kind: ForceKind,
  force: RecordForce | null | undefined,
): RecordForce {
  if (force != null && forceAllowed(kind, force)) return force;
  return defaultForceFor(kind);
}
