// claim.ts: a polling machine's process runs the discoveries that wait for
// it (#4772; mcp-studio-spec, Local servers).
//
// The API's durable functions record a discovery of a server that runs on
// machines as waiting_for_machine, with the groups that may run it
// (seams.ts, waitingLocalReporter). The MCP process holds the machines'
// long-polls in its broker. On each poll it calls claimMachineDiscoveries,
// which claims the workspace's waiting discoveries for the machine's groups,
// one at a time, and runs each through runDiscoveryEvent with a local
// reporter bound to its broker and to that machine. The claim locks the row
// and skips one another transaction holds, so two processes never run one
// discovery.
import { logger } from "../../logger";
import type { LocalGatewayBroker } from "../local-calls/broker";
import type { MachineGroupReader } from "../local-calls/machines";
import { runDiscoveryEvent, type DiscoveryRunData } from "./entry";
import {
  discoverySeams,
  gatewayLocalReporter,
  type DiscoverySeams,
} from "./seams";
import {
  postgresDiscoveryClaimStore,
  type DiscoveryClaimStore,
} from "./store";
import type { RunDiscoveryDeps } from "./sync";
import type { DiscoveryResult, DiscoveryScope } from "./types";

/** The most discoveries one poll runs, so a poll's work stays bounded. */
export const CLAIMS_PER_POLL = 5;

export interface MachineDiscoveryInput {
  /** The machine's workspace, from its gateway key. */
  scope: DiscoveryScope;
  /** The host enrollment that polled. */
  machine: string;
}

export interface MachineDiscoveryDeps {
  broker: LocalGatewayBroker;
  reader: MachineGroupReader;
  claims?: DiscoveryClaimStore;
  /** The seams the rest of each run uses. discoverySeams() when unset. */
  seams?: () => Promise<DiscoverySeams>;
  /** Runs one claimed discovery. runDiscoveryEvent when unset. */
  run?: (
    data: DiscoveryRunData,
    deps: RunDiscoveryDeps,
  ) => Promise<DiscoveryResult>;
  now?: () => Date;
  limit?: number;
}

/**
 * Claim and run the discoveries that wait for a machine in `machine`'s
 * groups, oldest first, up to `limit`. Each run asks this machine for
 * tools/list through the broker, so it lands on the poll that is waiting now.
 * A failed run is recorded on its row by runDiscovery and logged here: no
 * durable function retries it, and the next request or sweep asks again.
 */
export async function claimMachineDiscoveries(
  input: MachineDiscoveryInput,
  deps: MachineDiscoveryDeps,
): Promise<DiscoveryResult[]> {
  const { scope, machine } = input;
  const groups = await deps.reader.groupsOf(scope, machine);
  if (groups.length === 0) return [];
  const claims = deps.claims ?? postgresDiscoveryClaimStore;
  const run = deps.run ?? runDiscoveryEvent;
  const now = deps.now ?? (() => new Date());
  const limit = deps.limit ?? CLAIMS_PER_POLL;

  const results: DiscoveryResult[] = [];
  let seams: DiscoverySeams | undefined;
  for (let claimedCount = 0; claimedCount < limit; claimedCount += 1) {
    const claimed = await claims.claimWaiting(scope, groups, now());
    if (claimed === null) break;
    seams ??= {
      ...(await (deps.seams ?? discoverySeams)()),
      // Only the machine that polled: its poll is the one waiting for a call.
      local: gatewayLocalReporter({
        broker: deps.broker,
        reader: deps.reader,
        machines: async () => [machine],
      }),
    };
    try {
      results.push(
        await run(
          {
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            server: claimed.server,
            trigger: claimed.trigger,
            requestedBy: claimed.requestedBy ?? undefined,
          },
          { seams },
        ),
      );
    } catch (error) {
      logger.warn(
        {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          server: claimed.server,
          machine,
          error: error instanceof Error ? error.message : String(error),
        },
        "MCP discovery on a machine failed; the row records why",
      );
    }
  }
  return results;
}
