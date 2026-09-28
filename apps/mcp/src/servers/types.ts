// types.ts: what the served tools read and the ports they call (lane M15;
// mcp-studio-spec, Call path and Large servers).
//
// A wrapped agent's MCP connection lists the imported tools of the
// workspace's published steering version and calls them through the
// executor. Everything that touches the database, the vault, or the network
// is a port here, so list, call, and search run in tests with fakes.
import type { CredentialSource, Senders, ToolManifest, Transport } from "@oxagen/mcp-studio";
import type { CedarRuntime, PolicyFile } from "@oxagen/policy";

/** One agent from agents/<name>.toml (agent/v1), in the fields the gateway reads. */
export interface ServedAgent {
  name: string;
  operator: string;
  runtime: string;
  harness: string;
}

/** The published steering version's tools, policies, and agents. */
export interface PublishedTools {
  /** The steering repository the version belongs to. */
  repository: string;
  /** The published version number. */
  version: number;
  /** The compiled tool manifest. Null when the steering record imports no server. */
  manifest: ToolManifest | null;
  /** The files under policy/. Null when the steering record has none, which leaves the grant alone. */
  policies: readonly PolicyFile[] | null;
  agents: readonly ServedAgent[];
}

/** The run one MCP request belongs to. */
export interface ServedRun {
  orgId: string;
  workspaceId: string;
  /** One per HTTP request. The meter keys each governed action by it. */
  requestId: string;
  /** The tacho session the request names, when it names one. */
  sessionId: string | null;
  /** The runtime slug the gateway key's host enrolled as. */
  runtime: string;
  /** The harness the session reports, when it reports one. */
  harness: string | null;
  /** The operator's role, when Oxagen knows it. */
  operatorRole?: string;
}

/** The servers and tools a person switched off in Oxagen. */
export interface OffSwitches {
  /** Server names. */
  servers: ReadonlySet<string>;
  /** Full tool names: billing__create_refund. */
  tools: ReadonlySet<string>;
}

/** Where a parked call's approval stands. */
export type ApprovalState =
  | { state: "approved"; id: string }
  | { state: "pending"; id: string }
  | { state: "refused"; id: string };

/** One call that a rule parks for a person's approval. */
export interface ApprovalRequest {
  run: ServedRun;
  agent: ServedAgent;
  /** The full tool name the call was decided as. */
  tool: string;
  server: string;
  args: Record<string, unknown>;
  /** The approval rules that parked the call. */
  reasons: readonly string[];
  /** The tool's classified risk: low, medium, high, or critical. */
  risk: string;
}

export interface ServedApprovals {
  /**
   * Find the approval for this exact call, or open one. An approved
   * approval is claimed, so it lets one call through.
   */
  settle(request: ApprovalRequest): Promise<ApprovalState>;
}

export type MeterKind = "call" | "search" | "describe";
export type MeterOutcome = "allowed" | "denied" | "parked" | "failed";

/** One governed action: a call, a search, or a describe. */
export interface MeterEvent {
  kind: MeterKind;
  /** The full tool name: the underlying tool for a call, or <server>__search. */
  tool: string;
  server: string;
  outcome: MeterOutcome;
  /** The agent's name. Null when the key's host matches no agent. */
  agent: string | null;
  run: ServedRun;
  at: Date;
}

export interface ServedLog {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type ServedRouteCode = "relay_not_built" | "local_unavailable";

/**
 * A network route Oxagen cannot carry a call on yet. The call ends with an
 * isError result that says so, and nothing is sent.
 */
export class ServedRouteError extends Error {
  readonly code: ServedRouteCode;

  constructor(code: ServedRouteCode, message: string) {
    super(message);
    this.name = "ServedRouteError";
    this.code = code;
  }
}

export interface ServedPorts {
  /** The servers and tools switched off in Oxagen, read fresh for each request. */
  off(run: ServedRun): Promise<OffSwitches>;
  /** Full tool names Oxagen withholds from every agent. */
  withheld(run: ServedRun): Promise<ReadonlySet<string>>;
  approvals: ServedApprovals;
  credentials: CredentialSource;
  /** The Transport for an environment's network. Throws ServedRouteError for a route Oxagen cannot carry. */
  transport(network: string): Transport;
  meter(event: MeterEvent): Promise<void>;
  /** Cedar's evaluator, or null when it is not installed. */
  cedar(): Promise<CedarRuntime | null>;
  log: ServedLog;
  /** Senders in place of the executor's defaults. Tests pass fakes. */
  senders?: Partial<Senders>;
  /** Milliseconds since the epoch. Tests pass a clock. */
  now?: () => number;
  signal?: AbortSignal;
}
