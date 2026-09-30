// patterns.ts: the shapes a done record's handles, digests, ids, and times
// must match, and the kind of each check. schemas/done-record.v1.json holds
// the same patterns. Change both together.
import type { Check, CheckKind } from "./types";

/** A person's or an agent's handle in the workspace. */
export const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** The longest handle the schema allows. */
export const ACTOR_MAX_LENGTH = 128;

/** A criterion id: lowercase letters, digits, and hyphens, at most 40 characters. */
export const CRITERION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** sha256: and 64 lowercase hex characters. */
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A work item's public id. */
export const WORK_ITEM_ID_PATTERN = /^wi_[0-9A-Za-z]+$/;

/** A triage decision's public id. */
export const TRIAGE_ID_PATTERN = /^tri_[0-9A-Za-z]+$/;

/** A dotted lineage, such as aintel.core.bug-fixer. */
export const LINEAGE_PATTERN = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/** The longest lineage the schema allows. */
export const LINEAGE_MAX_LENGTH = 200;

const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when the value is a handle the schema accepts. */
export function isActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ACTOR_MAX_LENGTH &&
    ACTOR_PATTERN.test(value)
  );
}

/** True when the value is sha256: and 64 lowercase hex characters. */
export function isSha256(value: unknown): boolean {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/** True when the value is an RFC 3339 date-time that names a real instant. */
export function isRfc3339(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** The kind of a check, read from the one key each kind carries. */
export function checkKind(check: Check): CheckKind {
  if ("run" in check) return "run";
  if ("file" in check) return "file";
  if ("diff" in check) return "diff";
  if ("tools" in check) return "tools";
  if ("budget" in check) return "budget";
  return "human";
}
