// discovery.ts: a local server's tools/list, from one machine in its group,
// for lane M10's discovery (mcp-studio-spec, Local servers).
//
// The cloud gateway cannot reach a local server, so a machine in the
// server's group starts it, lists its tools, and reports them with its own
// id. The sync PR names the machine the tools came from.
import type { LocalServerRefusal, LaunchSpec, ToolsReply } from "@oxagen/recorder/local-servers";
import type { LocalGatewayBroker } from "./broker";
import { LOCAL_CALL_TTL_MS, newNonce } from "./envelope";
import { checkMachine, type MachineGroupReader, type MachineScope } from "./machines";
import { REPLY_GRACE_MS } from "./transport";

/** How long a machine gets to start a server and list its tools. */
export const DISCOVERY_DEADLINE_MS = 60_000;

export interface DiscoverLocalToolsOptions {
  scope: MachineScope;
  machine: string;
  /** server.toml's source.machines. */
  groups: readonly string[];
  reader: MachineGroupReader;
  broker: LocalGatewayBroker;
  launch: LaunchSpec;
  signal: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
}

export type LocalDiscovery =
  | { ok: true; report: ToolsReply }
  | { ok: false; refusal: LocalServerRefusal };

/**
 * List the server's tools on the machine. A refusal from either side comes
 * back as ok false. A machine that is not connected throws TransportError.
 */
export async function discoverLocalTools(options: DiscoverLocalToolsOptions): Promise<LocalDiscovery> {
  const refused = await checkMachine(options.reader, options.scope, options.machine, options.groups);
  if (refused !== undefined) return { ok: false, refusal: refused };
  const deadlineMs = options.deadlineMs ?? DISCOVERY_DEADLINE_MS;
  const now = options.now ?? Date.now;
  const reply = await options.broker.dispatch(
    options.machine,
    { kind: "discover", id: newNonce(), launch: options.launch, deadline_ms: deadlineMs },
    { signal: options.signal, pickupBy: now() + LOCAL_CALL_TTL_MS, replyWithinMs: deadlineMs + REPLY_GRACE_MS },
  );
  if (reply.kind === "tools") return { ok: true, report: reply };
  if (reply.kind === "refused") return { ok: false, refusal: reply.refusal };
  throw new Error("The local gateway answered a discovery with a call result.");
}
