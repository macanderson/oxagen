// server.get.ts: get_studio_server (#4678, part 3).
//
// Studio's server page reads one folder: server.toml's source, auth,
// environments, exposure and sync schedule, each tools.toml key's shaping,
// and the catalog list_studio_tools returns, all from one read of the
// production branch. A server with no folder answers not_found, and a folder
// whose files do not parse answers conflict, the way list_studio_tools does.
//
// A credential appears only as its vault reference. A registry source's
// `arguments` are left out, because a value there may be a literal.
import type { McpServer, McpTools } from "@oxagen/mcp-studio";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  toolStudioServerGet,
  type ToolStudioServerGetOutput,
} from "@oxagen/oxagen/contracts/tool.studio.server.get";
import { serverFolderPath } from "@oxagen/oxagen/steering-repo";
import { toolCatalog } from "./catalog";
import { discoveryActor } from "./discovery.start";
import { assertReader, serverName } from "./entry";
import { discoverySeams, type SteeringFiles } from "./seams";
import {
  postgresDiscoveryStore,
  postgresDiscoveryToolsStore,
  type DiscoveryRow,
  type DiscoveryStore,
  type DiscoveryToolsStore,
} from "./store";
import { publishedFiles } from "./tools.list";

export interface GetStudioServerDeps {
  store?: Pick<DiscoveryStore, "steeringServerId" | "read">;
  tools?: DiscoveryToolsStore;
  /** The steering repo. The installed discovery seam when unset. */
  steering?: SteeringFiles;
}

type Output = ToolStudioServerGetOutput;

/** server.toml's `[source]` in the output's camelCase shape. */
export function sourceOf(source: McpServer["source"]): Output["source"] {
  switch (source.type) {
    case "remote":
      return {
        type: "remote",
        url: source.url,
        transport: source.transport,
        network: source.network ?? null,
      };
    case "registry":
      return {
        type: "registry",
        registry: source.registry,
        server: source.server,
        version: source.version,
        network: source.network ?? null,
        machines: [...(source.machines ?? [])],
        registryType: source.registry_type ?? null,
        env: [...(source.env ?? [])],
      };
    case "local":
      return {
        type: "local",
        command: source.command,
        args: [...(source.args ?? [])],
        env: [...(source.env ?? [])],
        machines: [...(source.machines ?? [])],
      };
    default:
      return {
        type: source.type,
        from: source.from,
        repo: source.repo ?? null,
        path: source.path ?? null,
        ref: source.ref ?? null,
        url: source.url ?? null,
        network: source.network ?? null,
      };
  }
}

/** server.toml's `[auth]`, or mode none for a server with no table. */
function authOf(server: McpServer): Output["auth"] {
  const auth = server.auth;
  if (auth === undefined) return { mode: "none", scheme: null, credential: null };
  return {
    mode: auth.mode,
    scheme: auth.scheme ?? null,
    credential: auth.credential ?? null,
  };
}

/** Each `[environments.<name>]` table, in the order server.toml lists them. */
function environmentsOf(server: McpServer): Output["environments"] {
  return Object.entries(server.environments ?? {}).map(([name, env]) => ({
    name,
    sandbox: env.sandbox ?? false,
    url: env.url ?? null,
    network: env.network ?? null,
    credential: env.credential ?? null,
  }));
}

/** Each tools.toml key's shaping, with each fixed value as JSON. */
export function shapingOf(tools: McpTools): Output["shaping"] {
  return Object.entries(tools.tools ?? {}).map(([tool, entry]) => ({
    tool,
    hide: [...(entry.hide ?? [])],
    fixed: Object.entries(entry.fixed ?? {}).map(([name, value]) => ({
      name,
      value: JSON.stringify(value),
    })),
    select: [...(entry.select ?? [])],
    selection: entry.selection ?? null,
  }));
}

/** When the last discovery finished, when it succeeded. */
function lastSyncOf(row: DiscoveryRow | null): string | null {
  if (row === null || row.status !== "succeeded" || row.finishedAt === null) {
    return null;
  }
  return row.finishedAt.toISOString();
}

export function createGetStudioServerHandler(
  deps: GetStudioServerDeps = {},
): CapabilityHandler<typeof toolStudioServerGet> {
  return async (input, ctx) => {
    const scope = await assertReader(discoveryActor(ctx));
    const server = serverName(input.server);
    const steering = deps.steering ?? (await discoverySeams()).steering;
    const store = deps.store ?? postgresDiscoveryStore;
    const [files, read, mcpServerId, discovery] = await Promise.all([
      publishedFiles(steering, scope, server),
      (deps.tools ?? postgresDiscoveryToolsStore).read(scope, server),
      store.steeringServerId(scope, server),
      store.read(scope, server),
    ]);
    const catalog = toolCatalog({
      server,
      mcpServerId,
      files,
      offered: read.tools,
      withheldUpstream: read.withheldUpstream,
    });
    const parsed = files.parsed;
    return {
      ...catalog,
      folder: serverFolderPath(server),
      label: parsed.label,
      description: parsed.description,
      source: sourceOf(parsed.source),
      auth: authOf(parsed),
      environments: environmentsOf(parsed),
      sync: { schedule: parsed.sync.schedule, lastAt: lastSyncOf(discovery) },
      shaping: shapingOf(files.tools),
    };
  };
}

export const getStudioServerHandler = createGetStudioServerHandler();
