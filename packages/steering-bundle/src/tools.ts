// tools.ts: the tool manifest a published version carries, from each folder
// under tools/servers/ (steering-repo-spec, Finding tools; mcp-studio-spec,
// Compile).
//
// Publish reads each server's server.toml, tools.toml, and tools.lock.json.
// MCP Studio's compile() turns them into the server's effective tools, and
// toManifestServer() pins each tool to its lock entry. A server that does not
// compile, or whose lock no longer matches what compiles, is left out with a
// warning, and the version still publishes. The steering PR's compile check is
// the gate, and a server that fails here must not hold back every record.
//
// A gRPC server also needs its descriptor set, the compiled form of its
// .proto files that the gateway encodes and decodes each call with. Publish
// builds it from the folder's proto/ files with MCP Studio's gRPC importer,
// as discovery's sync does. Without it, compile() refuses the server, and the
// gateway serves none of its tools (#5344).
import {
  compile,
  importGrpc,
  NotBuiltError,
  parseLock,
  parseServerToml,
  parseToolsToml,
  toManifestServer,
  upstreamFromMcpTool,
  type FileIssue,
  type ImportedFile,
  type LockedTool,
  type ManifestServer,
  type McpToolsLock,
  type SecurityScheme,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import { toolName } from "@oxagen/oxagen/steering-repo/names";
import {
  classifySteeringRepoPath,
  serverFolderPath,
  serverTomlPath,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo/paths";
import type { TreeReader } from "./tree";

/** The folder under a gRPC server's folder that holds its .proto files. */
const PROTO_DIR = "proto";

/** One server folder's files, as publish reads them. */
export interface ServerFolder {
  /** The folder's name under tools/servers/, which is the server's name. */
  name: string;
  server: string;
  tools: string;
  /** tools.lock.json, or undefined when the folder has none. */
  lock: string | undefined;
  /**
   * Every file under the folder's proto/, by path relative to the folder
   * (proto/ledger.proto), sorted by path. Empty for a folder with no proto/.
   */
  proto: readonly ImportedFile[];
}

/** Compiles one server folder to its manifest entry. Throws or rejects when it cannot. */
export type ToolCompiler = (folder: ServerFolder) => ManifestServer | Promise<ManifestServer>;

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

/** `tools/servers/<name>/proto`, as a warning names it. */
export function protoDirPath(server: string): string {
  return `${serverFolderPath(server)}/${PROTO_DIR}`;
}

/** A gRPC server's proto/ that gives no descriptor set. `path` is the proto/ folder. */
export class ProtoFilesError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtoFilesError";
  }
}

/**
 * The descriptor set a gRPC server's proto/ files give, through MCP Studio's
 * gRPC importer. Throws ProtoFilesError when the folder holds no files there
 * or they do not import.
 */
export async function grpcDescriptorSet(folder: ServerFolder): Promise<Uint8Array> {
  const path = protoDirPath(folder.name);
  if (folder.proto.length === 0) {
    throw new ProtoFilesError(
      path,
      `${path} holds no .proto files, and a gRPC server needs them to serve its tools. Import the server in Studio to write them.`,
    );
  }
  let descriptorSet: Uint8Array | undefined;
  try {
    descriptorSet = (await importGrpc({ files: folder.proto })).descriptor_set;
  } catch (error) {
    throw new ProtoFilesError(path, `${path} does not import: ${(error as Error).message}`);
  }
  if (descriptorSet === undefined) {
    throw new ProtoFilesError(path, `${path} imported with no descriptor set.`);
  }
  return descriptorSet;
}

/**
 * Compile with MCP Studio: parse the three files, compile, and join the lock's
 * pins. A gRPC server's tools still come from the lock. Only its descriptor
 * set comes from proto/.
 */
export async function compileServerFolder(folder: ServerFolder): Promise<ManifestServer> {
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
    descriptor_set: server.source.type === "grpc" ? await grpcDescriptorSet(folder) : undefined,
  });
  return toManifestServer(compiled, lock);
}

/** Every file under a server folder's proto/, by path relative to the folder, sorted by path. */
async function protoFiles(reader: TreeReader, name: string): Promise<ImportedFile[]> {
  const folder = `${serverFolderPath(name)}/`;
  const prefix = `${protoDirPath(name)}/`;
  const files: ImportedFile[] = [];
  // reader.paths is sorted, so the files come out in path order.
  for (const path of reader.paths) {
    if (path.startsWith(prefix)) files.push({ path: path.slice(folder.length), text: await reader.read(path) });
  }
  return files;
}

/** What the tools under tools/servers/ give a version. */
export interface ToolsResult {
  /** The compiled servers, ordered by name. */
  servers: ManifestServer[];
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
  const result: ToolsResult = { servers: [], imported: [], warnings: [] };
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
      proto: await protoFiles(reader, name),
    };
    const tools = parseToolsToml(folder.tools);
    if (tools.ok) {
      // A tools.toml may hold no [tools] table yet, which imports nothing.
      for (const key of Object.keys(tools.value.tools ?? {})) {
        try {
          result.imported.push(toolName(name, key));
        } catch (error) {
          result.warnings.push(`${toolsPath}: ${(error as Error).message}`);
        }
      }
    }
    try {
      result.servers.push(await compiler(folder));
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
