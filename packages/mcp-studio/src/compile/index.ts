// compile: a server folder's effective tools (lane M4; mcp-studio-spec,
// Tools file, Risk classification, Tool names, and Large servers).
//
// compile() finds each tools.toml entry's upstream by upstream, operation,
// field, or method, and applies description, hide, fixed, defaults, rename,
// and a GraphQL selection. It derives annotations from the classification,
// never from the upstream, and prefixes names with toolName(). In search
// mode it adds <server>__search, __describe, and __call and keeps every
// imported tool behind them. It assigns no version: lock() does, and
// toManifestServer() joins the two.
//
// compile refuses a mutual_tls scheme. Mutual TLS runs through a relay that
// holds the client certificate, and the relay's own credential covers it.
import type { ManifestServer, ManifestTool } from "../contract/manifest";
import type { McpToolsLock } from "../contract/lock";
import type { McpServer } from "../contract/server";
import type { McpTools } from "../contract/tools";
import type { SecurityScheme } from "../model/security-scheme";
import type { UpstreamTool } from "../model/upstream-tool";
import { notBuilt } from "../not-built";

export interface CompileInput {
  /** server.toml, parsed. */
  server: McpServer;
  /** tools.toml, parsed. */
  tools: McpTools;
  /** Every tool the source offers: an importer's result, or tools/list through upstreamFromMcpTool. */
  upstream: readonly UpstreamTool[];
  /**
   * OpenAPI's components.securitySchemes by name, from import or from the
   * lock's source. Empty for every other source, whose auth.scheme is
   * builtinSecurityScheme's.
   */
  security_schemes: Readonly<Record<string, SecurityScheme>>;
  /** gRPC only: the serialized FileDescriptorSet the importer returned. */
  descriptor_set: Uint8Array | undefined;
}

/** One tool as compile returns it: its manifest entry before the lock assigns a version, and the upstream it came from. */
export type CompiledTool = Omit<ManifestTool, "version" | "upstream_hash"> & {
  /** The UpstreamTool the entry was compiled from, which lock() pins. */
  upstream: UpstreamTool;
};

/** A server as compile returns it: the manifest entry without the lock's pins. */
export type CompiledServer = Omit<ManifestServer, "pinned" | "tools"> & {
  tools: Record<string, CompiledTool>;
};

/** One reason a server does not compile. */
export interface CompileIssue {
  /** The tools.toml key, or undefined for the server as a whole. */
  tool: string | undefined;
  /** The field at fault: operation, name, auth.scheme. */
  field: string | undefined;
  message: string;
}

/**
 * A server that does not compile: a tools.toml entry with no upstream, a name
 * collision, a name over 64 characters, or a scheme compile cannot apply.
 * issues lists every problem found, not only the first.
 */
export class CompileError extends Error {
  readonly issues: readonly CompileIssue[];

  constructor(issues: readonly CompileIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "CompileError";
    this.issues = issues;
  }
}

/** The effective tools of one server folder. Throws CompileError. */
export function compile(input: CompileInput): CompiledServer {
  return notBuilt("compile", input);
}

/**
 * The manifest entry for a compiled server and the lock written for it: each
 * tool takes its version and upstream_hash from the lock, and pinned is the
 * lock's source. Throws when the lock does not cover every compiled tool.
 */
export function toManifestServer(compiled: CompiledServer, lock: McpToolsLock): ManifestServer {
  return notBuilt("compile/toManifestServer", compiled, lock);
}
