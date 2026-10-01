// transport.ts: the local path as a Transport, for lane M15's call path
// (mcp-studio-spec, Call path and Local servers).
//
// One Transport serves one local server on one machine. For each call it
// checks that the machine is in one of the server's groups, signs a
// local-call-envelope/v1, hands the call to the machine's local gateway, and
// returns the result the gateway screened. The cloud gateway then shapes,
// records, and meters it as it does any other result.
//
// A refusal, from this side or the machine's, comes back as a tool result
// with isError set and the refusal's text: what happened, then what to do.
// A machine that is not connected throws TransportError "disconnected".
import {
  TransportError,
  type CallToolResult,
  type LocalCall,
  type Transport,
} from "@oxagen/mcp-studio";
import {
  launchMismatch,
  refusalText,
  type LaunchSpec,
  type LocalServerRefusal,
} from "@oxagen/recorder/local-servers";
import type { LocalGatewayBroker } from "./broker";
import { signLocalCall } from "./envelope";
import { checkMachine, type MachineGroupReader, type MachineScope } from "./machines";
import type { LocalCallSigner } from "./signer";

/** Time after deadline_ms for the machine's reply to reach the cloud gateway. */
export const REPLY_GRACE_MS = 5_000;

export interface LocalTransportOptions {
  scope: MachineScope;
  /** The machine that runs the server: its tacho.hosts public id. */
  machine: string;
  /** server.toml's source.machines: the groups that may run the server. */
  groups: readonly string[];
  reader: MachineGroupReader;
  signer: LocalCallSigner;
  broker: LocalGatewayBroker;
  /** How the machine starts the server, from the lock and server.toml. */
  launch: LaunchSpec;
  now?: () => Date;
  nonce?: () => string;
}

/** A refusal as the tool result the agent reads. */
export function refusalResult(refusal: LocalServerRefusal): CallToolResult {
  return {
    content: [{ type: "text", text: refusalText(refusal) }],
    structuredContent: { error: { code: refusal.code, message: refusal.message, fix: refusal.fix } },
    isError: true,
  };
}

function unsupported(kind: string): Promise<never> {
  return Promise.reject(
    new TransportError(
      "unsupported",
      `A local server takes only local calls, not ${kind} requests. Route ${kind} tools through the cloud or a relay.`,
      false,
    ),
  );
}

async function callLocal(options: LocalTransportOptions, call: LocalCall): Promise<CallToolResult> {
  const refused = await checkMachine(options.reader, options.scope, options.machine, options.groups);
  if (refused !== undefined) return refusalResult(refused);
  if (call.package_digest !== options.launch.package.digest) {
    return refusalResult(launchMismatch("the call's package digest is not the digest the lock pins for the server"));
  }

  const envelope = signLocalCall({
    call: {
      tool: call.tool,
      upstream: call.upstream,
      version: call.version,
      definition_hash: call.definition_hash,
      package_digest: call.package_digest,
      arguments: call.arguments,
      deadline_ms: call.deadline_ms,
    },
    machine: options.machine,
    signer: options.signer,
    now: options.now?.(),
    nonce: options.nonce?.(),
  });
  const reply = await options.broker.dispatch(
    options.machine,
    { kind: "call", envelope, arguments: call.arguments, launch: options.launch },
    {
      signal: call.signal,
      pickupBy: Date.parse(envelope.expires_at),
      replyWithinMs: call.deadline_ms + REPLY_GRACE_MS,
    },
  );
  if (reply.kind === "result") return reply.result;
  if (reply.kind === "refused") return refusalResult(reply.refusal);
  // The broker settles a call only with a result or a refusal.
  throw new TransportError("disconnected", "The local gateway answered a call with a tools list.", true);
}

/** The Transport for one local server on one machine. HTTP and gRPC requests are unsupported. */
export function createLocalTransport(options: LocalTransportOptions): Transport {
  return {
    http: () => unsupported("HTTP"),
    grpc: () => unsupported("gRPC"),
    local: (call) => callLocal(options, call),
  };
}
