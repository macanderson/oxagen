// sources.ts: read what a server's source offers now, by kind of source
// (lane M10, #4682; mcp-studio-spec, Sync).
//
// - remote, and registry with no machines: tools/list at the sandbox
//   environment's endpoint, with the service credential or the token of the
//   person who asked.
// - local, and registry with machines: the local gateway's report.
// - openapi and graphql: the definition from a linked repository, a url, the
//   folder, or an introspection query at the first environment's endpoint.
// - grpc: lane M3's reflection and descriptor reads, through its seam.
//
// Each returns the tools the source offers and the lock source a new lock
// records. None of them writes anything.
import {
  DEFINITION_BYTES_MAX,
  importGraphql,
  importOpenApi,
  registryLockSource,
  upstreamFromMcpTool,
  type DefinitionLockSource,
  type ImportedFile,
  type ImportResult,
  type ManifestServer,
  type McpLockSource,
  type McpServer,
  type McpTool,
  type McpToolsLock,
  type RegistryEntry,
  type RegistryLockSource,
  type RegistrySource,
  type SecurityScheme,
  type SendCredential,
  type ServerSource,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import { serverFolderPath } from "@oxagen/oxagen/steering-repo";
import {
  fetchText,
  introspectGraphql,
  listMcpTools,
  type McpListResult,
} from "./mcp-client";
import type { Scrubber } from "./scrub";
import type { DiscoverySeams, SteeringCheckout } from "./seams";
import type { SnapshotDescriptor } from "./store";
import {
  DiscoveryRefused,
  type DiscoveryScope,
  type DiscoveryTrigger,
} from "./types";

type ManifestEnvironment = ManifestServer["environments"][string];
type RemoteSource = Extract<ServerSource, { type: "remote" }>;
type LocalSource = Extract<ServerSource, { type: "local" }>;
type DefinitionSource = Extract<
  ServerSource,
  { type: "openapi" | "graphql" | "grpc" }
>;

/** What one discovery knows before it reads the source. */
export interface SourceContext {
  scope: DiscoveryScope;
  /** The folder name under tools/servers/. */
  server: string;
  trigger: DiscoveryTrigger;
  /** The person whose token an operator-oauth server is listed with. */
  requestedBy: string | undefined;
  /** server.toml on the production branch. */
  parsed: McpServer;
  /** What the gateway serves now, compiled from the production branch. */
  served: ManifestServer;
  /** tools.lock.json on the production branch. */
  servedLock: McpToolsLock;
  checkout: SteeringCheckout;
  seams: DiscoverySeams;
  scrubber: Scrubber;
  signal: AbortSignal;
}

/** What the source offers now, and what a new lock records about it. */
export interface Discovered {
  /** Every tool the source offers, imported or not. */
  offered: UpstreamTool[];
  lockSource: McpLockSource | DefinitionLockSource;
  /** OpenAPI's components.securitySchemes by name. Empty for other sources. */
  securitySchemes: Record<string, SecurityScheme>;
  /** gRPC only. */
  descriptorSet: Uint8Array | undefined;
  /** A registry server's new source.version, when the catalog moved on. */
  version: string | undefined;
  /** The catalog's newest version, when this discovery read the catalog. */
  latestVersion: string | undefined;
  /** Files the steering PR writes into the server's folder, relative to it. */
  files: ImportedFile[];
  /** The machine that reported a local server's tools. */
  machine: string | null;
  /** The diff header's text after the folder path. */
  origin: string;
}

/**
 * A registry server that runs on machines has a newer catalog version. Its
 * lock pins the package's digest, and discovery cannot read one, so the run
 * records the version and opens no PR.
 */
export class NeedsDigest extends DiscoveryRefused {
  readonly latestVersion: string;

  constructor(server: string, latestVersion: string) {
    super(
      "needs_digest",
      `${server} ${latestVersion} is in the catalog. It runs on machines, so its lock needs the package's digest. Import the new version in Studio.`,
    );
    this.name = "NeedsDigest";
    this.latestVersion = latestVersion;
  }
}

/** The triggers that read the registry catalog for a newer version. */
const CATALOG_TRIGGERS: ReadonlySet<DiscoveryTrigger> = new Set([
  "schedule",
  "registry_version",
  "manual",
]);

/** A definition type with its article, as a refusal names it. */
const DEFINITION_LABELS: Record<DefinitionSource["type"], string> = {
  openapi: "An OpenAPI",
  graphql: "A GraphQL",
  grpc: "A gRPC",
};

/** An OpenAPI scheme name a lock can hold. */
const SCHEME_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** "2026-09-26 03:00 UTC", as the diff header prints a time. */
export function utc(now: Date): string {
  return `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The rows discovery writes to mcp.tool_snapshots. */
export function snapshotsOf(
  offered: readonly UpstreamTool[],
): SnapshotDescriptor[] {
  return offered.map((tool) => ({
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
  }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Environments and credentials ─────────────────────────────────────────────

/**
 * The environment discovery reads from. MCP sources list tools where agents
 * call them, the sandbox environment. Introspection reads the first
 * environment's endpoint, as server.toml's source documents.
 */
function environment(
  ctx: SourceContext,
  which: "sandbox" | "first",
): [string, ManifestEnvironment] {
  const entries = Object.entries(ctx.served.environments);
  const found =
    which === "first"
      ? entries[0]
      : entries.find(([, env]) => env.sandbox);
  if (found === undefined) {
    throw new DiscoveryRefused(
      "server_file",
      `${ctx.server} has no ${which === "first" ? "environment" : "sandbox environment"} to discover from.`,
    );
  }
  return found;
}

function endpoint(
  ctx: SourceContext,
  name: string,
  env: ManifestEnvironment,
): string {
  if (env.url === undefined) {
    throw new DiscoveryRefused(
      "server_file",
      `The ${name} environment of ${ctx.server} names no url.`,
    );
  }
  return env.url;
}

/**
 * The credential for one environment. A server with no auth needs none. An
 * operator-oauth server with no service credential is listed with the token
 * of the person who last asked, so a scheduled run of one nobody asked about
 * is refused with the fix.
 */
async function sendCredential(
  ctx: SourceContext,
  name: string,
  env: ManifestEnvironment,
): Promise<SendCredential> {
  const auth = ctx.served.auth;
  if (auth === null) return { type: "none" };
  if (
    auth.mode === "operator-oauth" &&
    env.credential === undefined &&
    ctx.requestedBy === undefined
  ) {
    throw new DiscoveryRefused(
      "credential",
      `${ctx.server} uses each operator's own token. Run discovery from Studio, and it lists the tools with yours.`,
    );
  }
  const resolved = await ctx.seams.credentials(ctx.scope).resolve(
    {
      server: ctx.served.name,
      environment: name,
      reference: env.credential,
      auth,
      operator: ctx.requestedBy,
    },
    ctx.signal,
  );
  if (resolved.type === "missing") {
    throw new DiscoveryRefused("credential", resolved.message);
  }
  return resolved;
}

async function listTools(
  ctx: SourceContext,
  name: string,
  env: ManifestEnvironment,
): Promise<McpListResult> {
  const url = endpoint(ctx, name, env);
  return listMcpTools({
    url,
    network: env.network,
    auth: ctx.served.auth,
    credential: await sendCredential(ctx, name, env),
    transport: ctx.seams.transport(),
    scrubber: ctx.scrubber,
    signal: ctx.signal,
  });
}

// ── Lock sources ─────────────────────────────────────────────────────────────

/** The served lock's source, when it is of the type server.toml names. */
function servedMcpSource<Type extends McpLockSource["type"]>(
  ctx: SourceContext,
  type: Type,
): Extract<McpLockSource, { type: Type }> {
  const source = ctx.servedLock.source;
  if (source.type !== type) {
    throw new DiscoveryRefused(
      "server_file",
      `The lock for ${ctx.server} is for a ${source.type} source, and server.toml names a ${type} source.`,
    );
  }
  return source as Extract<McpLockSource, { type: Type }>;
}

/** A lock source with the version the server reported, or with none. */
export function withServerVersion(
  source: McpLockSource,
  version: string | undefined,
): McpLockSource {
  const out: McpLockSource = { ...source };
  delete out.server_version;
  if (version !== undefined) out.server_version = version;
  return out;
}

function fromMcp(
  tools: readonly McpTool[],
  lockSource: McpLockSource,
  rest: Pick<Discovered, "latestVersion" | "machine" | "origin" | "version">,
): Discovered {
  return {
    offered: tools.map((tool) => upstreamFromMcpTool(tool)),
    lockSource,
    securitySchemes: {},
    descriptorSet: undefined,
    files: [],
    ...rest,
  };
}

// ── MCP sources ──────────────────────────────────────────────────────────────

async function discoverRemote(
  ctx: SourceContext,
  source: RemoteSource,
): Promise<Discovered> {
  const [name, env] = environment(ctx, "sandbox");
  const listed = await listTools(ctx, name, env);
  const lockSource: McpLockSource = withServerVersion(
    { type: "remote", url: source.url },
    listed.serverVersion,
  );
  return fromMcp(listed.tools, lockSource, {
    latestVersion: undefined,
    machine: null,
    origin: `tools/list changed at ${utc(ctx.seams.now())}`,
    version: undefined,
  });
}

async function discoverLocalReport(
  ctx: SourceContext,
  source: RegistrySource | LocalSource,
  latestVersion: string | undefined,
): Promise<Discovered> {
  const lockSource =
    source.type === "registry"
      ? servedMcpSource(ctx, "registry")
      : servedMcpSource(ctx, "local");
  const report = await ctx.seams.local.report({
    scope: ctx.scope,
    server: ctx.server,
    source,
    lockSource,
    signal: ctx.signal,
  });
  return fromMcp(
    report.tools,
    withServerVersion(lockSource, report.server_version),
    {
      latestVersion,
      machine: report.machine,
      origin: `tools/list changed at ${utc(ctx.seams.now())}`,
      version: undefined,
    },
  );
}

function registryLock(
  source: RegistrySource,
  entry: RegistryEntry,
  serverVersion: string | undefined,
): RegistryLockSource {
  try {
    return registryLockSource({
      source,
      entry,
      digest: undefined,
      server_version: serverVersion,
    });
  } catch (error) {
    throw new DiscoveryRefused("source", messageOf(error));
  }
}

/**
 * A registry server. The schedule, a manual run, and the catalog's own
 * signal read the catalog's newest entry. When it names a newer version, a
 * server with no machines is listed at the new entry's endpoint, and the PR
 * moves source.version. One on machines stops at needs_digest.
 */
async function discoverRegistry(
  ctx: SourceContext,
  source: RegistrySource,
): Promise<Discovered> {
  let latest: RegistryEntry | undefined;
  if (CATALOG_TRIGGERS.has(ctx.trigger)) {
    latest = await ctx.seams.catalog.entry(
      source.registry,
      source.server,
      "latest",
      ctx.signal,
    );
  }
  const latestVersion = latest?.server.version;
  const moving = latest !== undefined && latestVersion !== source.version;

  if (source.machines !== undefined) {
    if (moving && latestVersion !== undefined) {
      throw new NeedsDigest(source.server, latestVersion);
    }
    return discoverLocalReport(ctx, source, latestVersion);
  }

  const [name, env] = environment(ctx, "sandbox");
  if (!moving || latest === undefined || latestVersion === undefined) {
    // Check the served lock first, so a wrong lock sends no request.
    const served = servedMcpSource(ctx, "registry");
    const listed = await listTools(ctx, name, env);
    return fromMcp(
      listed.tools,
      withServerVersion(served, listed.serverVersion),
      {
        latestVersion,
        machine: null,
        origin: `tools/list changed at ${utc(ctx.seams.now())}`,
        version: undefined,
      },
    );
  }

  const next: RegistrySource = { ...source, version: latestVersion };
  const preliminary = registryLock(next, latest, undefined);
  // An environment that names its own url keeps it. Otherwise the new
  // entry's endpoint replaces the one the served lock pinned.
  const url = ctx.parsed.environments?.[name]?.url ?? preliminary.url;
  if (url === undefined) {
    throw new DiscoveryRefused(
      "source",
      `${source.server} ${latestVersion} names no endpoint.`,
    );
  }
  const listed = await listTools(ctx, name, { ...env, url });
  return fromMcp(
    listed.tools,
    registryLock(next, latest, listed.serverVersion),
    {
      latestVersion,
      machine: null,
      origin: `${source.server} ${latestVersion} is in the catalog`,
      version: latestVersion,
    },
  );
}

// ── Definitions ──────────────────────────────────────────────────────────────

/** An importer's error, as a refusal a person can act on. */
async function imported(
  run: () => Promise<ImportResult>,
): Promise<ImportResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DiscoveryRefused) throw error;
    throw new DiscoveryRefused(
      "source",
      `The definition does not import: ${messageOf(error)}`,
    );
  }
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** The definition's text, where it came from, and the name import reads it by. */
interface DefinitionText {
  from: "repository" | "url" | "upload";
  entry: string;
  text: string;
  location: Pick<DefinitionLockSource, "repo" | "path" | "ref" | "commit" | "url">;
  origin: string;
}

function required(
  ctx: SourceContext,
  value: string | undefined,
  field: string,
): string {
  if (value === undefined) {
    throw new DiscoveryRefused(
      "server_file",
      `server.toml for ${ctx.server} names no source.${field}.`,
    );
  }
  return value;
}

async function readDefinition(
  ctx: SourceContext,
  source: DefinitionSource,
): Promise<DefinitionText> {
  switch (source.from) {
    case "repository": {
      const repo = required(ctx, source.repo, "repo");
      const path = required(ctx, source.path, "path");
      const ref = required(ctx, source.ref, "ref");
      const read = await ctx.seams.definitions.read(
        ctx.scope,
        { repo, path, ref },
        ctx.signal,
      );
      const entry = basename(path);
      const name = repo.split("/").slice(1).join("/");
      return {
        from: "repository",
        entry,
        text: read.text,
        location: { repo, path, ref, commit: read.commit },
        origin: `${entry} changed at ${name}@${read.commit.slice(0, 7)}`,
      };
    }
    case "url": {
      const url = required(ctx, source.url, "url");
      const graphql = source.type === "graphql";
      const text = await fetchText({
        url,
        network: source.network ?? "cloud",
        transport: ctx.seams.transport(),
        signal: ctx.signal,
        accept: graphql
          ? "application/graphql, text/plain;q=0.9, */*;q=0.1"
          : "application/yaml, application/json;q=0.9, text/plain;q=0.5, */*;q=0.1",
        maxBytes: DEFINITION_BYTES_MAX,
      });
      const json = /\.json$/i.test(new URL(url).pathname);
      return {
        from: "url",
        entry: graphql
          ? "schema.graphql"
          : json
            ? "openapi.json"
            : "openapi.yaml",
        text,
        location: { url },
        origin: `${url} changed at ${utc(ctx.seams.now())}`,
      };
    }
    case "upload": {
      const folder = serverFolderPath(ctx.server);
      const names =
        source.type === "graphql"
          ? ["schema.graphql"]
          : ["openapi.yaml", "openapi.json"];
      for (const entry of names) {
        const text = await ctx.checkout.read(`${folder}/${entry}`);
        if (text !== null) {
          return {
            from: "upload",
            entry,
            text,
            location: {},
            origin: `${entry} changed at ${ctx.checkout.commit.slice(0, 7)}`,
          };
        }
      }
      throw new DiscoveryRefused(
        "source",
        `${folder} holds no ${names.join(" or ")}.`,
      );
    }
    default:
      throw new DiscoveryRefused(
        "server_file",
        `${DEFINITION_LABELS[source.type]} definition cannot come from ${source.from}.`,
      );
  }
}

/** OpenAPI's schemes as the lock records them, keyed by scheme name. */
function lockedSchemes(result: ImportResult): Record<string, SecurityScheme> {
  const out: Record<string, SecurityScheme> = {};
  for (const { scheme, ...rest } of result.auth) {
    if (SCHEME_NAME.test(scheme)) out[scheme] = rest;
  }
  return out;
}

async function introspect(
  ctx: SourceContext,
): Promise<{ result: ImportResult; origin: string }> {
  const [name, env] = environment(ctx, "first");
  const url = endpoint(ctx, name, env);
  const answer = await introspectGraphql({
    url,
    network: env.network,
    auth: ctx.served.auth,
    credential: await sendCredential(ctx, name, env),
    transport: ctx.seams.transport(),
    scrubber: ctx.scrubber,
    signal: ctx.signal,
    maxBytes: DEFINITION_BYTES_MAX,
  });
  const record =
    typeof answer === "object" && answer !== null && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : undefined;
  const errors = record?.errors;
  if (
    record === undefined ||
    (Array.isArray(errors) && errors.length > 0) ||
    typeof record.data !== "object" ||
    record.data === null
  ) {
    throw new DiscoveryRefused(
      "source",
      `The ${name} environment of ${ctx.server} answered the introspection query with no schema. Introspection may be turned off there. Read the schema from a linked repository instead.`,
    );
  }
  const data = record.data;
  const result = await imported(() => importGraphql({ introspection: data }));
  return { result, origin: `introspection changed at ${utc(ctx.seams.now())}` };
}

async function discoverDefinition(
  ctx: SourceContext,
  source: DefinitionSource,
): Promise<Discovered> {
  if (source.type === "grpc") {
    return ctx.seams.grpc.discover({
      scope: ctx.scope,
      server: ctx.server,
      signal: ctx.signal,
    });
  }
  const base = {
    descriptorSet: undefined,
    version: undefined,
    latestVersion: undefined,
    machine: null,
  };

  if (source.type === "graphql" && source.from === "introspection") {
    const { result, origin } = await introspect(ctx);
    return {
      ...base,
      offered: result.tools,
      lockSource: {
        type: "graphql",
        from: "introspection",
        document_hash: result.document_hash,
      },
      securitySchemes: {},
      files: result.files,
      origin,
    };
  }

  const read = await readDefinition(ctx, source);
  if (source.type === "graphql") {
    const result = await imported(() => importGraphql({ sdl: read.text }));
    return {
      ...base,
      offered: result.tools,
      lockSource: {
        type: "graphql",
        from: read.from,
        document_hash: result.document_hash,
        ...read.location,
      },
      securitySchemes: {},
      files: [],
      origin: read.origin,
    };
  }

  const overlay = await ctx.checkout.read(
    `${serverFolderPath(ctx.server)}/overlay.yaml`,
  );
  const result = await imported(() =>
    importOpenApi({
      files: [{ path: read.entry, text: read.text }],
      entry: read.entry,
      overlay: overlay ?? undefined,
    }),
  );
  const schemes = lockedSchemes(result);
  const lockSource: DefinitionLockSource = {
    type: "openapi",
    from: read.from,
    document_hash: result.document_hash,
    ...read.location,
  };
  if (Object.keys(schemes).length > 0) lockSource.security_schemes = schemes;
  return {
    ...base,
    offered: result.tools,
    lockSource,
    securitySchemes: schemes,
    files: [],
    origin: read.origin,
  };
}

// ── The dispatcher ───────────────────────────────────────────────────────────

/** Read what the server's source offers now. */
export async function discover(ctx: SourceContext): Promise<Discovered> {
  const source = ctx.parsed.source;
  switch (source.type) {
    case "remote":
      return discoverRemote(ctx, source);
    case "registry":
      return discoverRegistry(ctx, source);
    case "local":
      return discoverLocalReport(ctx, source, undefined);
    case "openapi":
    case "graphql":
    case "grpc":
      return discoverDefinition(ctx, source);
  }
}
