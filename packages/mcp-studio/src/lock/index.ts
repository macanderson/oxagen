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
//
// registryLockSource() builds a registry server's lock source from its
// catalog entry: the package, command, and args registryLaunch builds when
// server.toml names machines, and the entry's remote otherwise.
import type { CompiledServer } from "../compile";
import { upstreamHash } from "../contract/hashes";
import { formatJson } from "../contract/json";
import {
  LOCK_BYTES_MAX,
  mcpToolsLockSchema,
  type DefinitionLockSource,
  type McpLockSource,
  type McpToolsLock,
  type PypiLockFile,
} from "../contract/lock";
import type { RegistryEntry } from "../contract/registry-entry";
import { lockedUpstream } from "../model/from-mcp";
import { registryLaunch, type RegistrySource } from "../model/registry-launch";

export interface LockInput {
  compiled: CompiledServer;
  /** Where the upstream came from when the lock is written: the server's version, or the document's hash and commit. */
  source: McpLockSource | DefinitionLockSource;
  /** The lock on the production branch, or undefined for a new server. */
  previous: McpToolsLock | undefined;
}

/** The lock for a compiled server. Pass the result to formatJson to write the file. */
export function lock(input: LockInput): McpToolsLock {
  const { compiled, source, previous } = input;
  if (source.type !== compiled.source.type) {
    throw new Error(`The lock source is ${source.type}, and ${compiled.name}'s source is ${compiled.source.type}.`);
  }
  if (previous !== undefined && previous.server !== compiled.name) {
    throw new Error(`The previous lock is for ${previous.server}, and the compiled server is ${compiled.name}.`);
  }

  const tools: Record<string, unknown> = {};
  for (const [key, tool] of Object.entries(compiled.tools)) {
    const before = previous !== undefined && Object.hasOwn(previous.tools, key) ? previous.tools[key] : undefined;
    const version =
      before === undefined ? 1 : before.definition_hash === tool.definition_hash ? before.version : before.version + 1;
    const upstream = lockedUpstream(tool.upstream);
    tools[key] = { definition_hash: tool.definition_hash, upstream, upstream_hash: upstreamHash(upstream), version };
  }

  const out = mcpToolsLockSchema.parse({ schema: "mcp-tools-lock/v1", server: compiled.name, source, tools });
  const bytes = new TextEncoder().encode(formatJson(out)).length;
  if (bytes > LOCK_BYTES_MAX) {
    throw new Error(
      `The lock for ${compiled.name} is ${bytes} bytes, and a lock file is at most ${LOCK_BYTES_MAX} bytes. Take tools out of tools.toml, or split the server.`,
    );
  }
  return out;
}

// ── Registry sources ─────────────────────────────────────────────────────────

export type RegistryLockSource = Extract<McpLockSource, { type: "registry" }>;

export interface RegistryLockSourceInput {
  /** server.toml's source, parsed. */
  source: RegistrySource;
  /** The catalog entry at source.version. */
  entry: RegistryEntry;
  /** With source.machines: the package's digest, as registryLaunch takes it. */
  digest: string | undefined;
  /** For a pypi package: the one file of the release the digest is of (ADR-233). */
  file?: PypiLockFile;
  /** The version the server reported in initialize, when it reported one. */
  server_version: string | undefined;
}

/**
 * The catalog's remote types, as a lock source's transport names them. The
 * gateway calls streamable-http only, so the lock skips an sse remote the
 * way it skips any other type (ADR-211).
 */
const REMOTE_TRANSPORTS: Readonly<Record<string, "http">> = {
  "streamable-http": "http",
};

/**
 * A registry server's lock source. With source.machines it pins the package
 * and the launch registryLaunch builds, and ${NAME} stays in args as written.
 * Without it, it pins the entry's first streamable-http remote.
 * Throws when the entry is not the one server.toml names, or names nothing
 * the gateway can run.
 */
export function registryLockSource(input: RegistryLockSourceInput): RegistryLockSource {
  const { source, entry, digest, file, server_version } = input;
  if (entry.server.name !== source.server || entry.server.version !== source.version) {
    throw new Error(
      `The catalog entry is ${entry.server.name} ${entry.server.version}, and server.toml names ${source.server} ${source.version}.`,
    );
  }
  const out: RegistryLockSource = {
    type: "registry",
    registry: source.registry,
    server: source.server,
    version: source.version,
  };

  if (source.machines !== undefined) {
    if (digest === undefined) {
      throw new Error(`${source.server} runs on machines, so its lock needs the package's digest.`);
    }
    const launch = registryLaunch({ source, entry, digest, ...(file === undefined ? {} : { file }) });
    if (!launch.ok) {
      throw new Error(launch.problems.map((problem) => `${problem.field}: ${problem.message}`).join("\n"));
    }
    if (launch.package.registry_type === "pypi" && file === undefined) {
      throw new Error(`${source.server} is a pypi package, so its lock names the one file of the release it pins.`);
    }
    out.package = launch.package;
    out.command = launch.command;
    out.args = launch.args;
  } else {
    const remotes = entry.server.remotes ?? [];
    const remote = remotes.find((candidate) => Object.hasOwn(REMOTE_TRANSPORTS, candidate.type));
    if (remote === undefined) {
      const sseOnly = remotes.some((candidate) => candidate.type === "sse");
      throw new Error(
        sseOnly
          ? `${source.server} ${source.version} lists an sse remote and no streamable-http remote, and the gateway calls streamable-http only. Name source.machines to run its package.`
          : `${source.server} ${source.version} lists no streamable-http remote. Name source.machines to run its package.`,
      );
    }
    out.url = remote.url;
    out.transport = REMOTE_TRANSPORTS[remote.type];
  }
  if (server_version !== undefined) out.server_version = server_version;
  return out;
}
