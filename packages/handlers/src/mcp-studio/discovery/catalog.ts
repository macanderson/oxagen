// catalog.ts: the rows of list_studio_tools (lane M10, #4682; mcp-studio-spec,
// Tools tab).
//
// The Tools tab shows two groups. First comes every tools.toml key on the
// production branch, with the classification tools.toml states. Then comes
// every tool the last discovery found that no key imports, with the
// classification Studio suggests. The totals compare the imported tools'
// definition tokens with server.toml's definition budget.
//
// An available tool's suggestion reads only what mcp.tool_snapshots keeps: the
// name, the description, the input schema, and the MCP hints. A snapshot keeps
// no request template, so an OpenAPI, GraphQL, or gRPC tool's suggestion falls
// back to fail_safe. Its token count is an estimate that leaves out the title
// and the output schema.
import {
  CompileError,
  compile,
  definitionTokens,
  effectiveAnnotations,
  lockedMcpToolAnnotationsSchema,
  suggest,
  type CompiledServer,
  type ObjectJsonSchema,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import type {
  StudioServerTool,
  ToolStudioToolsListOutput,
} from "@oxagen/oxagen/contracts/tool.studio.tools.list";
import { TOOL_SEPARATOR } from "@oxagen/oxagen/steering-repo/names";
import { DEFAULT_SERVER_DEFINITION_BUDGET } from "@oxagen/oxagen/steering-repo/tokens";
import {
  lockedSecuritySchemes,
  lockedUpstreamTools,
} from "@oxagen/steering-bundle";
import { derivedKey, suggestNetwork } from "../import/build";
import type { StoredTool } from "./store";
import type { ServerFiles } from "./sync";

export interface ToolCatalogInput {
  /** The folder name under tools/servers/. */
  server: string;
  /** The live mcp.mcp_servers row the published folder wrote, or null. */
  mcpServerId: string | null;
  /** server.toml, tools.toml, and tools.lock.json on the production branch. */
  files: ServerFiles;
  /** The tools the last discovery found, each from its newest snapshot. */
  offered: readonly StoredTool[];
  /** Upstream names the gateway withholds until the sync steering PR merges. */
  withheldUpstream: readonly string[];
}

/** The fields a pinned upstream and a snapshot share. */
interface ToolFace {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Compile the folder as the gateway would. A folder that does not compile
 * still lists its tools, with no token counts and the compiler's message.
 *
 * A gRPC folder passes an empty descriptor set. compile() only encodes the
 * set into the manifest, and no count reads it, so the list skips the proto
 * import the served manifest needs.
 */
function compiled(
  files: ServerFiles,
): { server: CompiledServer; error: null } | { server: null; error: string } {
  try {
    const server = compile({
      server: files.parsed,
      tools: files.tools,
      upstream: lockedUpstreamTools(files.lock),
      security_schemes: lockedSecuritySchemes(files.lock),
      descriptor_set:
        files.parsed.source.type === "grpc" ? new Uint8Array() : undefined,
    });
    return { server, error: null };
  } catch (error) {
    if (error instanceof CompileError) return { server: null, error: error.message };
    throw error;
  }
}

function timestamp(date: Date | null | undefined): string | null {
  return date == null ? null : date.toISOString();
}

/** The newest snapshot among the offered tools. */
function newest(offered: readonly StoredTool[]): StoredTool | null {
  let found: StoredTool | null = null;
  for (const tool of offered) {
    if (found === null || tool.capturedAt > found.capturedAt) found = tool;
  }
  return found;
}

/**
 * A stand-in UpstreamTool for a snapshot. The snapshot keeps no request
 * template, so the stand-in reads as an MCP tool, and suggest() reads its
 * hints.
 */
function standIn(tool: StoredTool): UpstreamTool {
  const upstream: UpstreamTool = {
    name: tool.name,
    inputSchema: tool.inputSchema as ObjectJsonSchema,
    request: { kind: "mcp", tool: tool.name },
  };
  if (tool.description !== null) upstream.description = tool.description;
  if (tool.annotations !== null) {
    // A hint the lock's schema does not know drops every hint, and the
    // suggestion falls back to fail_safe.
    const hints = lockedMcpToolAnnotationsSchema.safeParse(tool.annotations);
    if (hints.success) upstream.annotations = hints.data;
  }
  return upstream;
}

function snapshotFields(snapshot: StoredTool | undefined): {
  snapshotId: string | null;
  capturedAt: string | null;
} {
  return {
    snapshotId: snapshot?.snapshotId ?? null,
    capturedAt: timestamp(snapshot?.capturedAt),
  };
}

/** The tools.toml keys, each with its confirmed classification. */
function importedRows(
  input: ToolCatalogInput,
  build: CompiledServer | null,
  offered: ReadonlyMap<string, StoredTool>,
  held: ReadonlySet<string>,
): StudioServerTool[] {
  const entries = Object.entries(input.files.tools.tools ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return entries.map(([key, entry]) => {
    const pinned: ToolFace | undefined =
      build?.tools[key]?.upstream ?? input.files.lock.tools[key]?.upstream;
    const name = pinned?.name ?? entry.upstream ?? key;
    const snapshot = offered.get(name);
    const face: ToolFace | undefined =
      snapshot === undefined
        ? pinned
        : {
            name,
            ...(snapshot.description === null ? {} : { description: snapshot.description }),
            inputSchema: snapshot.inputSchema,
            ...(snapshot.annotations === null ? {} : { annotations: snapshot.annotations }),
          };
    return {
      name,
      key,
      state: "imported",
      description: face?.description ?? null,
      importedDescription: entry.description ?? null,
      inputSchema: { ...(face?.inputSchema ?? {}) },
      annotations: face?.annotations === undefined ? null : { ...face.annotations },
      tokens: build?.tools[key]?.tokens ?? null,
      classification: {
        risk: entry.risk,
        sideEffect: entry.side_effect,
        egress: entry.egress,
        impacts: [...(entry.impacts ?? [])],
        confirmed: true,
        basis: null,
      },
      ...snapshotFields(snapshot),
      withheld: held.has(name),
    } satisfies StudioServerTool;
  });
}

/** The offered tools no key imports, each with a suggested classification. */
function availableRows(
  input: ToolCatalogInput,
  used: ReadonlySet<string>,
  held: ReadonlySet<string>,
): StudioServerTool[] {
  const context = {
    source: input.files.parsed.source.type,
    network: suggestNetwork(input.files.parsed),
  };
  return input.offered
    .filter((tool) => !used.has(tool.name))
    .map((tool) => {
      const upstream = standIn(tool);
      const suggestion = suggest(upstream, context);
      const key = derivedKey(upstream, input.server);
      const tokens = definitionTokens({
        name: `${input.server}${TOOL_SEPARATOR}${key}`,
        ...(upstream.description === undefined ? {} : { description: upstream.description }),
        inputSchema: upstream.inputSchema,
        annotations: effectiveAnnotations(suggestion),
      });
      return {
        name: tool.name,
        key: null,
        state: "available",
        description: tool.description,
        importedDescription: null,
        inputSchema: { ...tool.inputSchema },
        annotations: tool.annotations === null ? null : { ...tool.annotations },
        tokens,
        classification: {
          risk: suggestion.risk,
          sideEffect: suggestion.side_effect,
          egress: suggestion.egress,
          impacts: [...suggestion.impacts],
          confirmed: false,
          basis: suggestion.basis,
        },
        ...snapshotFields(tool),
        withheld: held.has(tool.name),
      } satisfies StudioServerTool;
    });
}

/**
 * list_studio_tools's answer for one server: the imported keys, then the
 * available tools by name, with the definition token totals.
 */
export function toolCatalog(input: ToolCatalogInput): ToolStudioToolsListOutput {
  const { files } = input;
  const build = compiled(files);
  const offered = new Map(input.offered.map((tool) => [tool.name, tool]));
  const held = new Set(input.withheldUpstream);
  const imported = importedRows(input, build.server, offered, held);
  const used = new Set(imported.map((row) => row.name));
  const available = availableRows(input, used, held).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const mode = files.parsed.exposure.mode;
  const budget =
    files.parsed.exposure.definition_budget ?? DEFAULT_SERVER_DEFINITION_BUDGET;
  const definitions = build.server?.tokens.definitions ?? null;
  const latest = newest(input.offered);
  return {
    server: input.server,
    mcpServerId: input.mcpServerId,
    snapshotId: latest?.snapshotId ?? null,
    capturedAt: timestamp(latest?.capturedAt),
    exposure: { mode, budget },
    tokens: { definitions, budget },
    imported: imported.length,
    offered: input.offered.length,
    searchRecommended:
      mode === "direct" && definitions !== null && definitions > budget,
    compileError: build.error,
    tools: [...imported, ...available],
  };
}
