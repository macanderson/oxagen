// lock: tools.lock.json for a compiled server (lane M4; mcp-studio-spec,
// Lock file).
//
// lock() pins each compiled tool's upstream with upstream_hash, and its
// effective definition with definition_hash. A tool's version is 1 when the
// previous lock has no entry for it, the previous version when
// definition_hash is unchanged, and one more when it changed. The
// classification is outside both hashes, so a reclassification never makes a
// new version. formatJson writes the result: sorted keys, two-space indent,
// and a final newline.
import type { CompiledServer } from "../compile";
import type { DefinitionLockSource, McpLockSource, McpToolsLock } from "../contract/lock";
import { notBuilt } from "../not-built";

export interface LockInput {
  compiled: CompiledServer;
  /** Where the upstream came from when the lock is written: the server's version, or the document's hash and commit. */
  source: McpLockSource | DefinitionLockSource;
  /** The lock on the production branch, or undefined for a new server. */
  previous: McpToolsLock | undefined;
}

/** The lock for a compiled server. Pass the result to formatJson to write the file. */
export function lock(input: LockInput): McpToolsLock {
  return notBuilt("lock", input);
}
