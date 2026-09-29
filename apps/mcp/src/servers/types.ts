// types.ts: what the served tools read and the ports they call (lane M15;
// mcp-studio-spec, Call path and Large servers).
//
// A wrapped agent's MCP connection lists the imported tools of the
// workspace's published steering version and calls them through the
// executor. Everything that touches the database, the vault, or the network
// is a port here, so list, call, and search run in tests with fakes.
import type { CredentialSource, ManifestServer, ResolvedCredential, Senders, ToolManifest, Transport } from "@oxagen/mcp-studio";
import type { CedarRuntime, PolicyFile } from "@oxagen/policy";
import type { Ranker } from "./search";

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
  /** The workspace's slug. Policies name the workspace by it: Workspace::"finops". */
  workspace: string;
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
  /**
   * The client's x-request-id, or a fresh UUID when it sends none. The
   * client chooses it, so it traces a request and keys nothing.
   */
  requestId: string;
  /** The tacho session the request names, when it names one. */
  sessionId: string | null;
  /** The runtime slug the gateway key's host enrolled as. */
  runtime: string;
  /** The harness the session reports, when it reports one. */
  harness: string | null;
  /**
   * The auth.users id of the person who enrolled the gateway key's host, when
   * the host records one. They operate every session the host opens, so an
   * operator-oauth server signs in with their token.
   */
  operator?: string;
  /** The role the gateway key's host enroller holds in the workspace now, when they hold one. */
  operatorRole?: string;
  /** The tacho.hosts public id of the machine the run is on. A local server runs there. */
  machine: string | null;
  /** The tacho session's public id (tse_...), which an approval records as its run. */
  runPublicId: string | null;
}

/** Where one call goes: the environment's network, the server, and the run. */
export interface ServedRoute {
  network: string;
  server: ManifestServer;
  run: ServedRun;
}

/** A route's Transport, which can say before any send that it would refuse the call. */
export interface ServedTransport extends Transport {
  /**
   * Why this route would refuse the call before sending it, or null when it
   * would take it. It gets the credential runTool read, or null when the
   * server needs none. runTool asks before it claims an approval, so a call
   * the route cannot send leaves the approval for the retry. It sends
   * nothing. A route without it is checked only when the call is sent.
   */
  refusal?(credential: ResolvedCredential | null): Promise<string | null>;
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
  | {
      state: "approved";
      /** The first approval that answers for the call. */
      id: string;
      /** The distinct people who approved the call. A rule can ask for more than one. */
      approvers: number;
    }
  | { state: "pending"; id: string }
  | { state: "refused"; id: string };

/** One call that a rule parks for a person's approval. */
export interface ApprovalRequest {
  run: ServedRun;
  agent: ServedAgent;
  /** The full tool name the call was decided as. */
  tool: string;
  /** The tool's locked version. An approval answers for this version only. */
  version: number;
  /**
   * The published steering version the call was decided under. An approval
   * answers for this publication only, since a publish can change the
   * server's environments, credentials, or policies without a new tool
   * version. Null only when nothing is published, which serves no tool.
   */
  publication: { repository: string; version: number } | null;
  server: string;
  args: Record<string, unknown>;
  /** The approval rules that parked the call. */
  reasons: readonly string[];
  /** The tool's classified risk: low, medium, high, or critical. */
  risk: string;
}

export interface ServedApprovals {
  /**
   * Where the approvals for this exact call stand, opening one when there is
   * none. A refusal outweighs a pending approval, and a pending approval
   * outweighs the approved ones. Settling uses no approval: only claim does.
   */
  settle(request: ApprovalRequest): Promise<ApprovalState>;
  /**
   * Open one more approval for a call whose approvals are too few for its
   * rule. When one is already pending, that one answers.
   */
  requestAnother(request: ApprovalRequest): Promise<{ id: string }>;
  /**
   * Use every approval that answers for the call, so they let this one call
   * through and no other. False when fewer than `approvers` people still
   * answer for it, because another call used them or they expired.
   */
  claim(request: ApprovalRequest, approvers: number): Promise<boolean>;
}

/** The facts about one call that a kill switch can name. */
export interface EmergencyCall {
  /** The server's name in the manifest: billing. */
  server: string;
  /** The full tool name: billing__create_refund. */
  tool: string;
  /**
   * The credential reference the call's environment names
   * (oxagen:credential/<name>). Null when the server takes no credential.
   */
  credential: string | null;
  /** True when the tool only reads. A read is checked against the switches the request last read. */
  readOnly: boolean;
}

/** The kill switch that stops a call. */
export interface EmergencyDeny {
  /** The switch's public id. */
  id: string;
  /** What the switch names: tool_version, tool_server, connection, operator, workspace, org, or class. */
  targetKind: string;
  /** The id the switch was set on. */
  targetId: string;
  /** The reason the person who set the switch gave. */
  reason: string;
}

export type MeterKind = "call" | "search" | "describe";
export type MeterOutcome = "allowed" | "denied" | "parked" | "failed";

/** One governed action: a call, a search, or a describe. */
export interface MeterEvent {
  /** Oxagen's id for this one action. The ledger keys the action by it. */
  id: string;
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

/** Why billing refused a governed action. */
export type AdmissionRefusal = "units_exhausted" | "no_payment_method" | "suspended";

/** Whether billing lets the organization take one more governed action. */
export type Admission = { admitted: true } | { admitted: false; reason: AdmissionRefusal };

export interface ServedLog {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type ServedRouteCode = "local_unavailable";

/**
 * A network route that cannot carry this call, such as a local route with no
 * signing key, no enrolled machine, or no launch spec. The call ends with an
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
  /** Billing's admission for one governed action. Throws when billing cannot be read. */
  admit(run: ServedRun): Promise<Admission>;
  /**
   * The kill switch that stops this call, or null when none does. Throws
   * when the switches cannot be read.
   */
  emergencyDeny(call: EmergencyCall): Promise<EmergencyDeny | null>;
  approvals: ServedApprovals;
  credentials: CredentialSource;
  /** The Transport for an environment's network. Throws ServedRouteError for a route Oxagen cannot carry. */
  transport(route: ServedRoute): ServedTransport;
  meter(event: MeterEvent): Promise<void>;
  /** Cedar's evaluator, or null when it is not installed. */
  cedar(): Promise<CedarRuntime | null>;
  log: ServedLog;
  /**
   * Ranks a search-mode server's search. Production ranks by the
   * workspace's embeddings. Keyword ranking runs when this is absent or
   * throws.
   */
  rank?: Ranker;
  /** Senders in place of the executor's defaults. Tests pass fakes. */
  senders?: Partial<Senders>;
  /** Milliseconds since the epoch. Tests pass a clock. */
  now?: () => number;
  /** A new id for each governed action. Tests pass a counter. */
  newId?: () => string;
  signal?: AbortSignal;
}
