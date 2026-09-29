// source.ts: a draft's source, imported again at Review (lane M11, ADR-224).
//
// Review builds the steering PR from inputs, not from Studio's view: the MCP
// server's tools/list result, or the definition. Importing it again gives the
// tools the source offers, the files the folder vendors, and what the lock
// records about them.
//
// The gRPC importer is a parameter, so a test can pass its own. An importer
// that throws NotBuiltError makes Review refuse with `importer_not_built`.
import { HandlerError } from "@oxagen/oxagen";
import type { StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import {
  importGraphql,
  importGrpc,
  importOpenApi,
  mcpLockSourceSchema,
  mcpToolSchema,
  NotBuiltError,
  upstreamFromMcpTool,
  type ImportedFile,
  type ImportNote,
  type ImportResult,
  type McpLockSource,
  type SecurityScheme,
  type UpstreamTool,
} from "@oxagen/mcp-studio";

export type GrpcImporter = typeof importGrpc;

/** What Review needs from a source, whatever its type. */
export interface ImportedSource {
  type: StudioSource["type"];
  /** Every tool the source offers, imported or not. */
  offered: UpstreamTool[];
  notes: ImportNote[];
  /** OpenAPI's components.securitySchemes by name. Empty for every other type. */
  securitySchemes: Record<string, SecurityScheme>;
  /** SHA-256 of the vendored definition, or null for an MCP server. */
  documentHash: string | null;
  /** The definition files the folder vendors, by path relative to the folder. */
  files: ImportedFile[];
  /** gRPC only: the serialized FileDescriptorSet compile needs. */
  descriptorSet: Uint8Array | undefined;
  /** MCP only: the lock's source, as Studio recorded it. */
  mcpLockSource: McpLockSource | null;
  /** The commit a repository definition resolved to, when Studio sent one. */
  commit: string | undefined;
}

/** The folder paths a definition vendors, by source type. */
export const OPENAPI_FILE = "openapi.yaml";
export const OVERLAY_FILE = "overlay.yaml";
export const GRAPHQL_FILE = "schema.graphql";
export const PROTO_DIR = "proto/";

function sourceInvalid(message: string, cause?: unknown): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "source_invalid",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function base64Bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

function fromResult(
  type: ImportedSource["type"],
  result: ImportResult,
  files: ImportedFile[],
  commit: string | undefined,
): ImportedSource {
  const securitySchemes: Record<string, SecurityScheme> = {};
  for (const { scheme, ...rest } of result.auth) securitySchemes[scheme] = rest as SecurityScheme;
  return {
    type,
    offered: result.tools,
    notes: result.notes,
    securitySchemes,
    documentHash: result.document_hash,
    files,
    descriptorSet: result.descriptor_set,
    mcpLockSource: null,
    commit,
  };
}

function importMcp(source: Extract<StudioSource, { type: "mcp" }>): ImportedSource {
  const lockSource = mcpLockSourceSchema.safeParse(source.lockSource);
  if (!lockSource.success) {
    throw sourceInvalid(
      "The MCP server's lock source is not a remote, registry, or local source as tools.lock.json records one.",
    );
  }
  const offered: UpstreamTool[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of source.tools.entries()) {
    const tool = mcpToolSchema.safeParse(raw);
    if (!tool.success) {
      throw sourceInvalid(`Tool ${index + 1} of the server's tools/list result is not an MCP tool.`);
    }
    if (seen.has(tool.data.name)) {
      throw sourceInvalid(`The server's tools/list result names ${tool.data.name} twice.`);
    }
    seen.add(tool.data.name);
    offered.push(upstreamFromMcpTool(tool.data));
  }
  return {
    type: "mcp",
    offered,
    notes: [],
    securitySchemes: {},
    documentHash: null,
    files: [],
    descriptorSet: undefined,
    mcpLockSource: lockSource.data,
    commit: undefined,
  };
}

async function importDefinition(
  source: Exclude<StudioSource, { type: "mcp" }>,
  grpc: GrpcImporter,
): Promise<ImportedSource> {
  switch (source.type) {
    case "openapi": {
      const entry = source.files.find((file) => file.path === source.entry);
      if (entry === undefined) {
        throw sourceInvalid(`The OpenAPI files hold no ${source.entry}, which the source names as the root document.`);
      }
      const result = await importOpenApi({
        files: source.files,
        entry: source.entry,
        overlay: source.overlay,
      });
      // The folder keeps the document import hashed: the bundle when import
      // inlined other files, else the root document as sent.
      const files: ImportedFile[] = [{ path: OPENAPI_FILE, text: result.files[0]?.text ?? entry.text }];
      if (source.overlay !== undefined) files.push({ path: OVERLAY_FILE, text: source.overlay });
      return fromResult("openapi", result, files, source.commit);
    }
    case "graphql": {
      if ("sdl" in source) {
        const result = await importGraphql({ sdl: source.sdl });
        return fromResult("graphql", result, [{ path: GRAPHQL_FILE, text: source.sdl }], source.commit);
      }
      const result = await importGraphql({ introspection: source.introspection });
      return fromResult("graphql", result, result.files, undefined);
    }
    case "grpc": {
      if ("files" in source) {
        const outside = source.files.find((file) => !file.path.startsWith(PROTO_DIR));
        if (outside !== undefined) {
          throw sourceInvalid(`${outside.path} is outside proto/. A gRPC definition's files live under proto/ in the server's folder.`);
        }
        const result = await grpc({ files: source.files });
        return fromResult("grpc", result, source.files, source.commit);
      }
      const result = await grpc({
        reflection: { file_descriptor_protos: source.reflection.map(base64Bytes) },
      });
      return fromResult("grpc", result, result.files, undefined);
    }
  }
}

/**
 * Import a draft's source. A source that does not import is refused with
 * `source_invalid`, and an importer whose lane has not landed with
 * `importer_not_built`.
 */
export async function importSource(
  source: StudioSource,
  grpc: GrpcImporter = importGrpc,
): Promise<ImportedSource> {
  if (source.type === "mcp") return importMcp(source);
  try {
    return await importDefinition(source, grpc);
  } catch (err) {
    if (err instanceof HandlerError) throw err;
    if (err instanceof NotBuiltError) {
      throw new HandlerError({
        code: "conflict",
        reason: "importer_not_built",
        message: `Oxagen cannot import a ${source.type} definition yet: the ${err.module} importer has not shipped.`,
      });
    }
    throw sourceInvalid(`The ${source.type} definition does not import. ${reason(err)}`, err);
  }
}
