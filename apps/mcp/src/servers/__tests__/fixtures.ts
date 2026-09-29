// fixtures.ts: a published steering version with one server for each source,
// the policies the tests decide with, and fake ports (lane M15).
//
// Every server has one sandbox environment, so each call goes to the sandbox.
// The Senders are fakes, so a cloud call never reaches the network, and the
// Transport records each call to a local server.
import type {
  CallToolResult,
  CredentialRequest,
  EffectiveDefinition,
  LocalCall,
  ManifestClassification,
  ManifestServer,
  ManifestTool,
  RequestKind,
  RequestTemplate,
  ResolvedCredential,
  SendContext,
  Sender,
  Senders,
  SendResult,
  ToolManifest,
  Transport,
  UpstreamArguments,
} from "@oxagen/mcp-studio";
import { requireCedarRuntime, type CedarRuntime, type PolicyFile } from "@oxagen/policy";
import { ServedCache, servedView, type ServedView } from "../snapshot";
import type {
  Admission,
  ApprovalRequest,
  ApprovalState,
  EmergencyCall,
  EmergencyDeny,
  MeterEvent,
  PublishedTools,
  ServedAgent,
  ServedPorts,
  ServedRoute,
  ServedRun,
  ServedTransport,
} from "../types";

export const HASH = `sha256:${"a".repeat(64)}`;
export const DIGEST = `sha256:${"d".repeat(64)}`;
/** Tuesday 2026-09-22 at 11:30 UTC. */
export const NOW = Date.UTC(2026, 8, 22, 11, 30);

type Risk = ManifestClassification["risk"];
type SideEffect = ManifestClassification["side_effect"];
type Impacts = ManifestClassification["impacts"];

export interface ToolSpec {
  /** The key after the prefix: create_refund. */
  key: string;
  description?: string;
  side_effect?: SideEffect;
  risk?: Risk;
  impacts?: Impacts;
  properties?: Record<string, unknown>;
  required?: string[];
  request?: RequestTemplate;
  /** The upstream's own annotations, when a test needs them to disagree with the classification. */
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

const GRPC_REQUEST: RequestTemplate = {
  kind: "grpc",
  method: "/ledger.v1.Entries/ListEntries",
  streaming: "unary",
  idempotency_level: "NO_SIDE_EFFECTS",
  request_type: "ledger.v1.ListEntriesRequest",
  response_type: "ledger.v1.ListEntriesResponse",
};

/** The request template a source's tools send. */
export function requestFor(source: string, key: string): RequestTemplate {
  switch (source) {
    case "openapi":
      return { kind: "http", operation: key, method: "GET", path: `/${key}`, parameters: [] };
    case "graphql":
      return { kind: "graphql", operation_type: "query", field: `Query.${key}`, arguments: [], selection: "{ id }" };
    case "grpc":
      return GRPC_REQUEST;
    default:
      return { kind: "mcp", tool: key };
  }
}

export function tool(server: string, source: string, spec: ToolSpec): ManifestTool {
  const name = `${server}__${spec.key}`;
  const side_effect = spec.side_effect ?? "read";
  const inputSchema: ManifestTool["definition"]["inputSchema"] = { type: "object", properties: spec.properties ?? {} };
  if (spec.required !== undefined) inputSchema.required = spec.required;
  return {
    name,
    version: 1,
    definition_hash: HASH,
    upstream_hash: HASH,
    definition: {
      name,
      description: spec.description ?? `Runs ${spec.key}. It answers with what the upstream returns.`,
      inputSchema,
      annotations: spec.annotations ?? {
        readOnlyHint: side_effect === "read",
        destructiveHint: side_effect === "irreversible",
        openWorldHint: true,
      },
    },
    tokens: 10,
    classification: {
      risk: spec.risk ?? "low",
      side_effect,
      egress: "third_party",
      impacts: spec.impacts ?? [],
      measures: {},
      data_classes: [],
    },
    shaping: {
      hide: [],
      fixed: {},
      defaults: {},
      rename: {},
      select: [],
      redact: [],
      max_result_bytes: 65536,
      deadline_ms: 30000,
    },
    request: spec.request ?? requestFor(source, spec.key),
  };
}

export interface ServerSpec {
  name: string;
  source: "openapi" | "graphql" | "grpc" | "remote" | "registry" | "local";
  tools: ToolSpec[];
  network?: string;
  /** The environments by name. Defaults to one sandbox on the network. */
  environments?: Record<string, { sandbox: boolean; network: string; credential?: string }>;
  /** The credential reference the default sandbox names: oxagen:credential/<name>. */
  credential?: string;
  mode?: "direct" | "search";
  auth?: boolean;
  /** The auth mode when auth is set. Defaults to service. */
  authMode?: "service" | "operator-oauth";
}

function pinnedFor(source: ServerSpec["source"]): Record<string, unknown> {
  if (source === "local") return { type: "local", package: { digest: DIGEST } };
  if (source === "registry") return { type: "registry", package: { digest: DIGEST } };
  if (source === "remote") return { type: "remote" };
  return { type: source, from: "url", document_hash: HASH };
}

/** The search, describe, and call definitions a search-mode server lists. */
export function searchDefinitions(server: string): EffectiveDefinition[] {
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  return [
    {
      name: `${server}__search`,
      description: `Find ${server} tools by what they do.`,
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
      annotations,
    },
    {
      name: `${server}__describe`,
      description: `Read one ${server} tool's input schema.`,
      inputSchema: { type: "object", properties: { tool: { type: "string" } }, required: ["tool"] },
      annotations,
    },
    {
      name: `${server}__call`,
      description: `Call one ${server} tool.`,
      inputSchema: { type: "object", properties: { tool: { type: "string" }, arguments: { type: "object" } }, required: ["tool"] },
      annotations,
    },
  ];
}

export function server(spec: ServerSpec): ManifestServer {
  const network = spec.network ?? (spec.source === "local" ? "local" : "cloud");
  const environments = spec.environments ?? {
    [spec.source === "local" ? "default" : "sandbox"]: {
      sandbox: true,
      network,
      ...(spec.credential === undefined ? {} : { credential: spec.credential }),
    },
  };
  const tools: Record<string, ManifestTool> = {};
  for (const entry of spec.tools) tools[entry.key] = tool(spec.name, spec.source, entry);
  const mode = spec.mode ?? "direct";
  const built = {
    name: spec.name,
    label: spec.name.charAt(0).toUpperCase() + spec.name.slice(1),
    description: `The ${spec.name} server.`,
    source: { type: spec.source },
    pinned: pinnedFor(spec.source),
    auth:
      spec.auth === true
        ? spec.authMode === "operator-oauth"
          ? { mode: "operator-oauth", scheme: "oauth", apply: { type: "http_bearer" } }
          : { mode: "service", scheme: "bearer", apply: { type: "http_bearer" } }
        : null,
    environments,
    exposure: { mode, definition_budget: 8000 },
    tokens: { definitions: 10 * spec.tools.length, request: 10 * spec.tools.length },
    search: mode === "search" ? searchDefinitions(spec.name) : null,
    tools,
  };
  return built as unknown as ManifestServer;
}

/** One server for each source, each on its sandbox. */
export const SOURCES: readonly ServerSpec[] = [
  {
    name: "billing",
    source: "openapi",
    auth: true,
    credential: "oxagen:credential/billing-sandbox",
    tools: [
      {
        key: "list_charges",
        description: "List the charges on the account. Newest first.",
        properties: { limit: { type: "integer" } },
      },
      {
        key: "create_refund",
        description: "Refund a charge to the card it was paid with.",
        side_effect: "irreversible",
        risk: "high",
        impacts: ["moves_money"],
        properties: { charge: { type: "string" }, amount: { type: "integer" } },
        required: ["charge"],
      },
      { key: "delete_customer", description: "Delete a customer and their cards.", side_effect: "write", risk: "medium" },
    ],
  },
  { name: "catalog", source: "graphql", tools: [{ key: "list_products", description: "List the products for sale." }] },
  { name: "ledger", source: "grpc", tools: [{ key: "list_entries", description: "List the ledger's entries." }] },
  { name: "stripe", source: "remote", tools: [{ key: "list_customers", description: "List the Stripe customers." }] },
  { name: "github", source: "registry", tools: [{ key: "get_issue", description: "Read one GitHub issue." }] },
  { name: "files", source: "local", tools: [{ key: "read_file", description: "Read one file on the machine." }] },
];

/** The fixture server with this name. */
export function sourceNamed(name: string): ServerSpec {
  const found = SOURCES.find((spec) => spec.name === name);
  if (found === undefined) throw new Error(`No fixture server is named ${name}.`);
  return found;
}

/** A server whose only environment is on a relay. */
export const RELAY: ServerSpec = {
  name: "corp",
  source: "openapi",
  network: "relay:corp",
  tools: [{ key: "list_users", description: "List the directory's users." }],
};

export const AGENT: ServedAgent = {
  name: "aintel.finops.release-bot",
  operator: "priya",
  runtime: "ci-linux-01",
  harness: "claude-code",
};

/** A second agent on the same runtime, so the harness picks between them. */
export const REVIEWER: ServedAgent = {
  name: "aintel.finops.reviewer",
  operator: "sam",
  runtime: "ci-linux-01",
  harness: "codex",
};

export const POLICIES: readonly PolicyFile[] = [
  {
    path: "policy/approvals.cedar",
    text: `@id("irreversible.approval")
@decision("require_approval")
forbid (principal, action, resource)
when { context.tool.side_effect == "irreversible" }
unless { context.approval.granted };`,
  },
  {
    path: "policy/customers.cedar",
    text: `@id("customers.never")
forbid (principal, action == Action::"billing__delete_customer", resource);`,
  },
  {
    path: "policy/charges.cedar",
    text: `@id("charges.limit")
forbid (principal, action == Action::"billing__list_charges", resource)
when { context.args has limit && context.args.limit > 100 };`,
  },
];

export interface PublishedOptions {
  servers?: readonly ManifestServer[];
  policies?: readonly PolicyFile[] | null;
  agents?: readonly ServedAgent[];
  version?: number;
}

export function published(options: PublishedOptions = {}): PublishedTools {
  const servers = options.servers ?? SOURCES.map(server);
  const manifest: ToolManifest = { schema: "tool-manifest/v1", servers: [...servers] };
  return {
    repository: "finops-steering",
    workspace: "finops",
    version: options.version ?? 1,
    manifest,
    policies: options.policies === undefined ? POLICIES : options.policies,
    agents: options.agents ?? [AGENT, REVIEWER],
  };
}

/** The auth.users id of the person who enrolled the run's host. */
export const OPERATOR = "5a8e2c41-9b7d-4f16-8c3e-0d2f6a1b7e94";

export function run(overrides: Partial<ServedRun> = {}): ServedRun {
  return {
    orgId: "org_1",
    workspaceId: "ws_1",
    requestId: "req_1",
    sessionId: "ses_1",
    runtime: "ci-linux-01",
    harness: "claude-code",
    operator: OPERATOR,
    machine: "hst_1",
    runPublicId: "tse_1",
    ...overrides,
  };
}

export interface Sent {
  kind: RequestKind;
  args: UpstreamArguments;
  context: SendContext;
}

export interface LogLine {
  message: string;
  fields: Record<string, unknown> | undefined;
}

export interface Recorded {
  /** The runs billing was asked to admit an action for. */
  admitted: ServedRun[];
  meter: MeterEvent[];
  logs: LogLine[];
  approvals: ApprovalRequest[];
  /** The calls that asked for one more approval. */
  requested: ApprovalRequest[];
  /** The approvals a call used, with the number of people it needed. */
  claims: Array<{ request: ApprovalRequest; approvers: number }>;
  /** The calls checked against the kill switches. */
  emergencyDenies: EmergencyCall[];
  credentials: CredentialRequest[];
  routes: ServedRoute[];
  local: LocalCall[];
  sent: Sent[];
}

export interface PortOptions {
  off?: { servers?: string[]; tools?: string[] };
  withheld?: string[];
  admit?: (run: ServedRun) => Promise<Admission>;
  approval?: (request: ApprovalRequest) => Promise<ApprovalState>;
  /** Answers requestAnother. Defaults to a new pending approval, apr_4. */
  another?: (request: ApprovalRequest) => Promise<{ id: string }>;
  /** Answers claim. Defaults to true. */
  claim?: (request: ApprovalRequest, approvers: number) => Promise<boolean>;
  /** The kill switch that stops a call. Defaults to none. */
  emergencyDeny?: (call: EmergencyCall) => Promise<EmergencyDeny | null>;
  credential?: (request: CredentialRequest) => Promise<ResolvedCredential>;
  /** Replaces the Transport lookup, such as to throw for a route or to refuse a call before the claim. */
  transport?: (route: ServedRoute) => ServedTransport;
  local?: (call: LocalCall) => Promise<CallToolResult>;
  answer?: (kind: RequestKind) => SendResult;
  meter?: (event: MeterEvent) => Promise<void>;
  cedar?: () => Promise<CedarRuntime | null>;
}

function answered(kind: RequestKind): SendResult {
  const value: unknown = kind === "mcp" ? { content: [{ type: "text", text: "mcp answered" }] } : { answered: kind };
  return { ok: true, value, attempts: 1, exchanges: [] };
}

function unreached(): Promise<never> {
  return Promise.reject(new Error("A fake Sender answers every cloud call."));
}

export function fakePorts(options: PortOptions = {}): { ports: ServedPorts; recorded: Recorded } {
  const recorded: Recorded = {
    admitted: [],
    meter: [],
    logs: [],
    approvals: [],
    requested: [],
    claims: [],
    emergencyDenies: [],
    credentials: [],
    routes: [],
    local: [],
    sent: [],
  };
  let actions = 0;
  function sender<K extends RequestKind>(kind: K): Sender<K> {
    return {
      kind,
      send: (_template, args, context) => {
        recorded.sent.push({ kind, args, context });
        return Promise.resolve((options.answer ?? answered)(kind));
      },
    };
  }
  const senders: Senders = { mcp: sender("mcp"), http: sender("http"), graphql: sender("graphql"), grpc: sender("grpc") };
  const transport: Transport = {
    http: unreached,
    grpc: unreached,
    local: (call) => {
      recorded.local.push(call);
      return options.local?.(call) ?? Promise.resolve({ content: [{ type: "text", text: "local answered" }] });
    },
  };
  const ports: ServedPorts = {
    off: () =>
      Promise.resolve({ servers: new Set(options.off?.servers ?? []), tools: new Set(options.off?.tools ?? []) }),
    withheld: () => Promise.resolve(new Set(options.withheld ?? [])),
    admit: (served) => {
      recorded.admitted.push(served);
      return options.admit?.(served) ?? Promise.resolve({ admitted: true });
    },
    emergencyDeny: (call) => {
      recorded.emergencyDenies.push(call);
      return options.emergencyDeny?.(call) ?? Promise.resolve(null);
    },
    approvals: {
      settle: (request) => {
        recorded.approvals.push(request);
        return options.approval?.(request) ?? Promise.resolve({ state: "pending", id: "apr_1" });
      },
      requestAnother: (request) => {
        recorded.requested.push(request);
        return options.another?.(request) ?? Promise.resolve({ id: "apr_4" });
      },
      claim: (request, approvers) => {
        recorded.claims.push({ request, approvers });
        return options.claim?.(request, approvers) ?? Promise.resolve(true);
      },
    },
    credentials: {
      resolve: (request) => {
        recorded.credentials.push(request);
        return options.credential?.(request) ?? Promise.resolve({ type: "bearer", token: "tok_never_logged" });
      },
    },
    transport: (route) => {
      recorded.routes.push(route);
      return options.transport?.(route) ?? transport;
    },
    meter: (event) => {
      recorded.meter.push(event);
      return options.meter?.(event) ?? Promise.resolve();
    },
    cedar: options.cedar ?? requireCedarRuntime,
    log: {
      warn: (message, fields) => {
        recorded.logs.push({ message, fields });
      },
    },
    senders,
    now: () => NOW,
    newId: () => `act_${++actions}`,
  };
  return { ports, recorded };
}

/** The view one run's agent has of a published version. */
export function view(
  version: PublishedTools | null = published(),
  ports: ServedPorts = fakePorts().ports,
  served: ServedRun = run(),
  cache: ServedCache = new ServedCache(),
): Promise<ServedView> {
  return servedView(version, served, ports, cache);
}

/** The text of a tools/call result's first content item. */
export function textOf(result: CallToolResult | null): string {
  const text = result?.content[0]?.["text"];
  return typeof text === "string" ? text : "";
}
