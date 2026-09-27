// tools.ts: the tool manifest a published version carries, from each folder
// under tools/servers/ (steering-repo-spec, Finding tools; mcp-studio-spec,
// Compile).
//
// Publish reads each server's server.toml, tools.toml, and tools.lock.json,
// and MCP Studio's compile() turns them into the server's manifest entry. A
// server that does not compile is left out with a warning, and the version
// still publishes: the steering PR's compile check is the gate, and a server
// that fails here must not hold back every record. Until lane M4 builds
// compile(), every server is left out this way and the manifest is null.
import {
  compile,
  NotBuiltError,
  parseLock,
  parseServerToml,
  parseToolsToml,
  toManifestServer,
  upstreamFromMcpTool,
  type FileIssue,
  type LockedTool,
  type ManifestServer,
  type McpToolsLock,
  type SecurityScheme,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import { toolName } from "@oxagen/oxagen/steering-repo/names";
import {
  classifySteeringRepoPath,
  serverTomlPath,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo/paths";
import type { ExposureMode } from "./mentions";
import type { TreeReader } from "./tree";

/** One server folder's files, as publish reads them. */
export interface ServerFolder {
  /** The folder's name under tools/servers/, which is the server's name. */
  name: string;
  server: string;
  tools: string;
  /** tools.lock.json, or undefined when the folder has none. */
  lock: string | undefined;
}

/** Compiles one server folder to its manifest entry. Throws when it cannot. */
export type ToolCompiler = (folder: ServerFolder) => ManifestServer;

/** A server file that does not parse. */
export class ServerFileError extends Error {
  constructor(
    readonly path: string,
    readonly issues: readonly FileIssue[],
  ) {
    super(`${path} does not parse: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "ServerFileError";
  }
}

function parsed<T>(path: string, result: { ok: true; value: T } | { ok: false; issues: FileIssue[] }): T {
  if (!result.ok) throw new ServerFileError(path, result.issues);
  return result.value;
}

/** The upstream tools a lock pins: a definition's tools as written, and an MCP tool through upstreamFromMcpTool. */
export function lockedUpstreamTools(lock: McpToolsLock): UpstreamTool[] {
  const entries: LockedTool[] = Object.values(lock.tools);
  return entries.map((entry) =>
    "request" in entry.upstream ? entry.upstream : upstreamFromMcpTool(entry.upstream),
  );
}

/** OpenAPI's security schemes as the lock's source recorded them, or none. */
export function lockedSecuritySchemes(lock: McpToolsLock): Record<string, SecurityScheme> {
  return "security_schemes" in lock.source ? (lock.source.security_schemes ?? {}) : {};
}

/** Compile with MCP Studio: parse the three files, compile, and join the lock's pins. */
export const compileServerFolder: ToolCompiler = (folder) => {
  const server = parsed(serverTomlPath(folder.name), parseServerToml(folder.server));
  const tools = parsed(toolsTomlPath(folder.name), parseToolsToml(folder.tools));
  if (folder.lock === undefined) {
    throw new ServerFileError(toolsLockPath(folder.name), [
      { line: null, field: null, message: "the folder has no tools.lock.json" },
    ]);
  }
  const lock = parsed(toolsLockPath(folder.name), parseLock(folder.lock));
  const compiled = compile({
    server,
    tools,
    upstream: lockedUpstreamTools(lock),
    security_schemes: lockedSecuritySchemes(lock),
    // gRPC's descriptor set comes from the proto files, which only an
    // importer reads. compile() refuses a gRPC server without one.
    descriptor_set: undefined,
  });
  return toManifestServer(compiled, lock);
};

/** What the tools under tools/servers/ give a version. */
export interface ToolsResult {
  /** The compiled servers, ordered by name. */
  servers: ManifestServer[];
  /** Each server's exposure mode, from its server.toml. */
  modes: Map<string, ExposureMode>;
  /** Every imported tool's name, from each tools.toml. */
  imported: string[];
  warnings: string[];
}

/** The server folders a tree holds, by name, in order. */
export function serverNames(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const kind = classifySteeringRepoPath(path);
    if (kind === "server" || kind === "server-tools" || kind === "server-lock") {
      names.add(path.split("/")[2] as string);
    }
  }
  return [...names].sort();
}

/** Read and compile every server folder. A server that does not compile is left out with a warning. */
export async function buildTools(
  reader: TreeReader,
  compiler: ToolCompiler,
): Promise<ToolsResult> {
  const result: ToolsResult = { servers: [], modes: new Map(), imported: [], warnings: [] };
  for (const name of serverNames(reader.paths)) {
    const serverPath = serverTomlPath(name);
    const toolsPath = toolsTomlPath(name);
    if (!reader.has(serverPath) || !reader.has(toolsPath)) {
      result.warnings.push(
        `tools/servers/${name} has no server.toml or no tools.toml, so the version has no tools from it.`,
      );
      continue;
    }
    const folder: ServerFolder = {
      name,
      server: await reader.read(serverPath),
      tools: await reader.read(toolsPath),
      lock: reader.has(toolsLockPath(name)) ? await reader.read(toolsLockPath(name)) : undefined,
    };
    const server = parseServerToml(folder.server);
    if (server.ok) result.modes.set(name, server.value.exposure.mode);
    const tools = parseToolsToml(folder.tools);
    if (tools.ok) {
      for (const key of Object.keys(tools.value.tools)) {
        try {
          result.imported.push(toolName(name, key));
        } catch (error) {
          result.warnings.push(`${toolsPath}: ${(error as Error).message}`);
        }
      }
    }
    try {
      result.servers.push(compiler(folder));
    } catch (error) {
      result.warnings.push(
        error instanceof NotBuiltError
          ? `tools/servers/${name} is left out: MCP Studio's ${error.module} is not built yet.`
          : `tools/servers/${name} is left out: ${(error as Error).message}`,
      );
    }
  }
  result.servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return result;
}
