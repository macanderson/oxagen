// lock-digest.ts: the digest a person's lock pins a done record to.
//
// The digest is SHA-256 over the record in RFC 8785 form, with `lock` left
// out, written as sha256:<64 hex>. decide compares it with `lock.digest` and
// calls the record broken (LOCK_MISMATCH) when they differ.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { notBuilt } from "./not-built";
import type { DoneRecord } from "./types";

/** The lock digest of a done record. Pure. */
export function lockDigest(record: DoneRecord): Sha256Digest {
  return notBuilt("lockDigest", record);
}
