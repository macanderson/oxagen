// lock-digest.ts: the digest a lock pins a done record to, and the lock itself.
//
// The digest is SHA-256 over the record in RFC 8785 form, with `lock` left
// out, written as sha256:<64 hex>. decide compares it with `lock.digest` and
// calls the record broken (LOCK_MISMATCH) when they differ.
//
// A person locks a record. Oxagen locks one only at autonomy level 3, where it
// signs as OXAGEN_LOCK_ACTOR. The caller checks the Cedar action work.lock
// before it asks for a lock. lockRecord checks lint, the handle, and the time.
import { digestJcs, type Sha256Digest } from "@oxagen/run-evidence";
import { DoneRecordError } from "./errors";
import { lint, type EvaluatorRegistry } from "./lint";
import { isActor, isRfc3339 } from "./patterns";
import type { DoneRecord, DoneRecordLock } from "./types";

/** The handle Oxagen signs a lock with at autonomy level 3. */
export const OXAGEN_LOCK_ACTOR = "oxagen" as const;

/** The autonomy level at which Oxagen may lock a record itself. */
export const OXAGEN_LOCK_LEVEL = 3;

// A key whose value is undefined is absent in JSON, so it is absent from the
// digest too. RFC 8785 has no undefined, and digestJcs throws on one.
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) out[key] = withoutUndefined(entry);
    }
    return out;
  }
  return value;
}

/** The lock digest of a done record. Pure. */
export function lockDigest(record: DoneRecord): Sha256Digest {
  const { lock: _lock, ...rest } = record;
  return digestJcs(withoutUndefined(rest));
}

/** True when the record carries a lock and the lock's digest matches the record. */
export function lockMatches(record: DoneRecord): boolean {
  return record.lock !== undefined && record.lock.digest === lockDigest(record);
}

/** Who locks the record, and when. */
export interface LockRequest {
  /** The handle of the person who locks, or OXAGEN_LOCK_ACTOR. */
  by: string;
  /** An RFC 3339 date-time. */
  at: string;
  /** The scope's autonomy level. Oxagen locks only at OXAGEN_LOCK_LEVEL. */
  level?: number;
}

/**
 * Lock a done record. The record must pass lint. Returns a copy with `lock`
 * written, and replaces any lock the record already had. Pure.
 */
export function lockRecord(
  record: DoneRecord,
  request: LockRequest,
  registry: EvaluatorRegistry,
): DoneRecord {
  if (!isActor(request.by)) {
    throw new DoneRecordError(
      "invalid_input",
      `The lock's handle "${request.by}" is not a workspace handle. Use lowercase letters, digits, dots, underscores, and hyphens.`,
    );
  }
  if (request.by === OXAGEN_LOCK_ACTOR && (request.level ?? 0) < OXAGEN_LOCK_LEVEL) {
    throw new DoneRecordError(
      "invalid_input",
      `Oxagen locks a done record only at autonomy level ${OXAGEN_LOCK_LEVEL}. A person must lock this one.`,
    );
  }
  if (!isRfc3339(request.at)) {
    throw new DoneRecordError(
      "invalid_input",
      `The lock's time "${request.at}" is not an RFC 3339 date-time.`,
    );
  }
  const result = lint(record, registry);
  if (!result.ok) {
    const rules = result.issues.map((issue) =>
      issue.criterion ? `${issue.rule} (${issue.criterion})` : issue.rule,
    );
    throw new DoneRecordError(
      "lint_failed",
      `The done record does not pass lint: ${rules.join(", ")}. Fix it, then lock it.`,
    );
  }
  const { lock: _lock, ...unlocked } = record;
  const lock: DoneRecordLock = {
    digest: lockDigest(unlocked),
    by: request.by,
    at: request.at,
  };
  return { ...unlocked, lock };
}
