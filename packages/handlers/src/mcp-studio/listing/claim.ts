// claim.ts: a polling machine's process lists the tools of the Studio drafts
// that wait for it (ADR-233, #4756).
//
// start_studio_listing records a listing that waits for a machine in the
// draft's source.machines. The MCP process holds the machines' long-polls in
// its broker. On each poll it calls claimDraftListings, which claims the
// workspace's open listings for the machine's groups, one at a time, and asks
// that machine to start the pinned server and answer tools/list. The machine
// checks the pin before it starts anything. The answer becomes the draft's MCP
// source, written with the listing's finish in one transaction (store.ts), so
// Review builds the folder and its first tools.lock.json from it.
import {
  STUDIO_SOURCE_BYTES_MAX,
  STUDIO_SOURCE_TOOLS_MAX,
  studioSourceBytes,
  type StudioSource,
} from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import type { McpLockSource } from "@oxagen/mcp-studio";
import { logger } from "../../logger";
import { gatewayLocalReporter, type LocalToolsReporter } from "../discovery/seams";
import { postgresStudioDraftStore, type StudioDraftStore } from "../import/store";
import type { LocalGatewayBroker } from "../local-calls/broker";
import type { MachineGroupReader } from "../local-calls/machines";
import { draftSource } from "./pin";
import {
  postgresListingClaimStore,
  type ClaimedListing,
  type ListingClaimStore,
  type ListingScope,
} from "./store";

/** The most listings one poll runs, so a poll's work stays bounded. */
export const LISTINGS_PER_POLL = 3;

/** How long one machine has to start the server and answer tools/list. */
export const LISTING_TIMEOUT_MS = 60_000;

export interface MachineListingInput {
  /** The machine's workspace, from its gateway key. */
  scope: ListingScope;
  /** The host enrollment that polled. */
  machine: string;
}

export interface MachineListingDeps {
  broker: LocalGatewayBroker;
  reader: MachineGroupReader;
  claims?: ListingClaimStore;
  drafts?: StudioDraftStore;
  /** Asks the machine. A gateway reporter bound to this machine when unset. */
  reporter?: LocalToolsReporter;
  now?: () => Date;
  limit?: number;
}

/** What one claimed listing came to. */
export interface ListingOutcome {
  server: string;
  status: "succeeded" | "failed";
  toolCount: number | null;
  error: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The pin with the version the server reported in initialize, when it reported one. */
function withServerVersion(lockSource: McpLockSource, version: string | undefined): McpLockSource {
  return version === undefined ? lockSource : { ...lockSource, server_version: version };
}

/**
 * Claim and run the listings that wait for a machine in `machine`'s groups,
 * oldest first, up to `limit`. A listing that fails records why on its row.
 */
export async function claimDraftListings(
  input: MachineListingInput,
  deps: MachineListingDeps,
): Promise<ListingOutcome[]> {
  const { scope, machine } = input;
  const groups = await deps.reader.groupsOf(scope, machine);
  if (groups.length === 0) return [];
  const claims = deps.claims ?? postgresListingClaimStore;
  const drafts = deps.drafts ?? postgresStudioDraftStore();
  const now = deps.now ?? (() => new Date());
  const limit = deps.limit ?? LISTINGS_PER_POLL;
  // Only the machine that polled: its poll is the one waiting for a call.
  const reporter =
    deps.reporter ??
    gatewayLocalReporter({ broker: deps.broker, reader: deps.reader, machines: async () => [machine] });

  const outcomes: ListingOutcome[] = [];
  for (let count = 0; count < limit; count += 1) {
    const claimed = await claims.claimOpen(scope, groups, now());
    if (claimed === null) break;
    outcomes.push(await runListing(scope, machine, claimed, { claims, drafts, reporter, now }));
  }
  return outcomes;
}

async function runListing(
  scope: ListingScope,
  machine: string,
  claimed: ClaimedListing,
  deps: { claims: ListingClaimStore; drafts: StudioDraftStore; reporter: LocalToolsReporter; now: () => Date },
): Promise<ListingOutcome> {
  const { server } = claimed;
  const failed = async (error: string): Promise<ListingOutcome> => {
    await deps.claims.fail(scope, claimed, error, deps.now());
    logger.warn(
      { orgId: scope.orgId, workspaceId: scope.workspaceId, server, machine, error },
      "Studio listing on a machine failed; the row records why",
    );
    return { server, status: "failed", toolCount: null, error };
  };

  let source: StudioSource;
  let toolCount: number;
  let reported: string;
  try {
    const draft = await deps.drafts.get(scope, server);
    if (draft === null) return await failed(`The draft for ${server} is gone, so nothing was listed.`);
    if (draft.revision !== claimed.draftRevision) {
      return await failed(
        `The draft for ${server} was saved after its tools were asked for, so nothing was listed. List its tools again.`,
      );
    }
    const report = await deps.reporter.report({
      scope,
      server,
      source: draftSource(server, draft.serverToml),
      lockSource: claimed.lockSource,
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    });
    if (report.tools.length > STUDIO_SOURCE_TOOLS_MAX) {
      return await failed(
        `${report.machine} listed ${report.tools.length} tools for ${server}, and a draft holds at most ${STUDIO_SOURCE_TOOLS_MAX}.`,
      );
    }
    source = {
      type: "mcp",
      lockSource: withServerVersion(claimed.lockSource, report.server_version) as Record<string, unknown>,
      tools: report.tools as unknown as Record<string, unknown>[],
    };
    const bytes = studioSourceBytes(source);
    if (bytes > STUDIO_SOURCE_BYTES_MAX) {
      return await failed(
        `The tools ${report.machine} listed for ${server} come to ${bytes} bytes, and a draft holds at most ${STUDIO_SOURCE_BYTES_MAX}.`,
      );
    }
    toolCount = report.tools.length;
    reported = report.machine;
  } catch (error) {
    return failed(messageOf(error));
  }

  const done = await deps.claims.complete(
    scope,
    claimed,
    { source: source as Extract<StudioSource, { type: "mcp" }>, machine: reported, toolCount },
    deps.now(),
  );
  if (done.status === "succeeded") {
    logger.info(
      { orgId: scope.orgId, workspaceId: scope.workspaceId, server, machine: reported, toolCount, draftRevision: done.draftRevision },
      "Studio listing wrote the draft's tools",
    );
    return { server, status: "succeeded", toolCount, error: null };
  }
  const error =
    done.status === "draft_changed"
      ? `The draft for ${server} was saved after its tools were asked for, so the listing wrote nothing. List its tools again.`
      : `Another request replaced the listing for ${server} while ${reported} answered, so this answer was dropped.`;
  logger.warn({ orgId: scope.orgId, workspaceId: scope.workspaceId, server, machine: reported, error }, "Studio listing wrote nothing");
  return { server, status: "failed", toolCount: null, error };
}
