// tools.list.ts: list_studio_tools (lane M10, #4682).
//
// Studio's Tools tab reads the published folder on the production branch and
// the tools the last discovery found, and ./catalog joins them. A server with
// no folder answers not_found. A folder whose files do not parse answers
// conflict with the file's message, since Studio cannot list its keys.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioToolsList } from "@oxagen/oxagen/contracts/tool.studio.tools.list";
import { toolCatalog } from "./catalog";
import { discoveryActor } from "./discovery.start";
import { assertReader, serverName } from "./entry";
import { discoverySeams, type SteeringFiles } from "./seams";
import {
  postgresDiscoveryStore,
  postgresDiscoveryToolsStore,
  type DiscoveryStore,
  type DiscoveryToolsStore,
} from "./store";
import { readServerFiles, type ServerFiles } from "./sync";
import { DiscoveryRefused, type DiscoveryScope } from "./types";

export interface ListStudioToolsDeps {
  store?: Pick<DiscoveryStore, "steeringServerId">;
  tools?: DiscoveryToolsStore;
  /** The steering repo. The installed discovery seam when unset. */
  steering?: SteeringFiles;
}

/** The folder's three files, with a refusal a person can act on. */
async function publishedFiles(
  steering: SteeringFiles,
  scope: DiscoveryScope,
  server: string,
): Promise<ServerFiles> {
  try {
    return await readServerFiles(await steering.open(scope), server);
  } catch (error) {
    if (!(error instanceof DiscoveryRefused)) throw error;
    if (error.code === "no_server") {
      throw new HandlerError({
        code: "not_found",
        reason: "mcp_server_not_found",
        message: error.message,
      });
    }
    if (error.code === "server_file") {
      throw new HandlerError({
        code: "conflict",
        reason: "server_file_invalid",
        message: error.message,
      });
    }
    throw error;
  }
}

export function createListStudioToolsHandler(
  deps: ListStudioToolsDeps = {},
): CapabilityHandler<typeof toolStudioToolsList> {
  return async (input, ctx) => {
    const scope = await assertReader(discoveryActor(ctx));
    const server = serverName(input.server);
    const steering = deps.steering ?? (await discoverySeams()).steering;
    const [files, read, mcpServerId] = await Promise.all([
      publishedFiles(steering, scope, server),
      (deps.tools ?? postgresDiscoveryToolsStore).read(scope, server),
      (deps.store ?? postgresDiscoveryStore).steeringServerId(scope, server),
    ]);
    return toolCatalog({
      server,
      mcpServerId,
      files,
      offered: read.tools,
      withheldUpstream: read.withheldUpstream,
    });
  };
}

export const listStudioToolsHandler = createListStudioToolsHandler();
