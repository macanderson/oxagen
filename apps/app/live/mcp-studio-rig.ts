/**
 * The rig for the MCP Studio live test (lane M17, #5139).
 *
 * It builds on the steering live test's rig (`steering-rig.ts`): the same
 * sign-in, workspace, GitHub, polling, and cleanup helpers, with workspaces
 * named `mcp-live-<run id>-<attempt>`. This file adds what MCP Studio needs:
 *
 *   - the four server folders the suite imports, each from M0's fixtures
 *   - the Studio, relay, enrollment, approval, and import calls to Oxagen
 *   - a client for the MCP gateway, which calls tools as an enrolled agent
 *   - a client for the sample servers' control port (mcp-studio-servers.ts)
 *
 * `mergeSteeringPullRequest` merges a steering PR through the proposal row its
 * opener wrote (#5122). `publishAgentFile` finds the agent file PR the host's
 * enrollment opened (#5149), which the suite then merges the same way.
 *
 * Like the steering rig, it never prints a secret: the upstream token, the
 * relay token, and the gateway key stay out of every error message.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AgentApprovalListOutput } from "@oxagen/oxagen/contracts/agent.approval.list";
import { agentNameForRuntime } from "@oxagen/oxagen/steering-repo/agent";
import type { ContextProposalListOutput } from "@oxagen/oxagen/contracts/context.proposal.list";
import type { RuntimeListItem } from "@oxagen/oxagen/contracts/runtime.list";
import type { SteeringMarkdownImportCommitOutput } from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import type { SteeringMarkdownImportParseOutput } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import type { TachoEnrollmentCreateOutput } from "@oxagen/oxagen/contracts/tacho.enrollment.create";
import type { ToolRelayCreateOutput } from "@oxagen/oxagen/contracts/tool.relay.create";
import type { ToolRelayRevokeOutput } from "@oxagen/oxagen/contracts/tool.relay.revoke";
import type { ToolStudioCredentialSetOutput } from "@oxagen/oxagen/contracts/tool.studio.credential.set";
import type { ToolStudioDiscoveryGetOutput } from "@oxagen/oxagen/contracts/tool.studio.discovery.get";
import type { ToolStudioDiscoveryStartOutput } from "@oxagen/oxagen/contracts/tool.studio.discovery.start";
import type { ToolStudioDraftGetOutput } from "@oxagen/oxagen/contracts/tool.studio.draft.get";
import type { ToolStudioDraftSaveOutput } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import type { ToolStudioReviewOpenOutput } from "@oxagen/oxagen/contracts/tool.studio.review.open";
import {
  excerpt,
  type GithubRig,
  HttpError,
  MCP_STUDIO_SUITE,
  mergeSteeringPr,
  MINUTE,
  newestRun,
  type Oxagen,
  parseBody,
  poll,
  reached,
  readSettings,
  readSteeringPr,
  SECOND,
  type Settings,
  waiting,
  workspacePath,
} from "./steering-rig";

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Values the workflow makes for each run. None is a GitHub secret or
 * variable: the workflow generates the upstream token, starts the tunnel, and
 * starts the sample servers before the suite runs.
 */
const RUN_VALUES = ["MCP_STUDIO_LIVE_TUNNEL_URL", "MCP_STUDIO_LIVE_UPSTREAM_TOKEN"] as const;

export interface StudioSettings extends Settings {
  /** The public tunnel to the sample servers' upstream port, with no trailing slash. */
  tunnelUrl: string;
  /** The bearer token the sample upstreams require. The suite stores it as a credential. */
  upstreamToken: string;
  /** The sample servers' control port, on the runner only. */
  controlUrl: string;
  /** Oxagen's MCP endpoint, where an enrolled agent lists and calls tools. */
  mcpUrl: string;
  /** The relay broker: the MCP endpoint's host over `wss://`. */
  brokerUrl: string;
  /** The relay's name: the run slug, which also names the relay network. */
  relayName: string;
}

/**
 * A workflow value by name, as the steering rig reads its own: these are
 * workflow inputs, not deployment settings, so the env registry lists none.
 */
function workflowValue(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

/** A URL from the environment with no trailing slash: unset or empty means the default. */
function url(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return workflowValue(env, name, fallback).replace(/\/+$/, "");
}

/** Reads the steering rig's settings for the MCP Studio suite, plus this run's own values. */
export function readStudioSettings(env: NodeJS.ProcessEnv = process.env): StudioSettings {
  const base = readSettings(env, MCP_STUDIO_SUITE);
  const missing = RUN_VALUES.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) {
    throw new Error(
      `The MCP Studio live test is missing ${missing.join(", ")}. The workflow sets each one before the suite runs, so run the suite from .github/workflows/mcp-studio-live.yml.`,
    );
  }
  const mcpUrl = url(env, "MCP_STUDIO_LIVE_MCP_URL", "https://mcp.oxagen.sh/mcp");
  return {
    ...base,
    tunnelUrl: url(env, "MCP_STUDIO_LIVE_TUNNEL_URL", ""),
    upstreamToken: workflowValue(env, "MCP_STUDIO_LIVE_UPSTREAM_TOKEN", ""),
    controlUrl: url(env, "MCP_STUDIO_LIVE_CONTROL_URL", "http://127.0.0.1:8788"),
    mcpUrl,
    brokerUrl: `wss://${new URL(mcpUrl).host}`,
    relayName: base.runSlug,
  };
}

// ── Server folders ───────────────────────────────────────────────────────────

/** The workspace credential that holds the sample upstreams' bearer token. */
export const UPSTREAM_CREDENTIAL = "mcp-live-upstream";

export type SideEffect = "read" | "write" | "irreversible";

export interface ImportedTool {
  /** The upstream name, which is also the tools.toml key. */
  name: string;
  risk: "low" | "medium" | "high" | "critical";
  sideEffect: SideEffect;
  egress: "local" | "org_tenant" | "third_party";
  impacts: string[];
}

export interface StudioServer {
  /** The folder under tools/servers/. Agents see `<folder>__<tool>`. */
  folder: string;
  /** The gRPC server is the one Oxagen reaches through the relay. */
  kind: "mcp" | "openapi" | "graphql" | "grpc";
  tools: [ImportedTool, ImportedTool];
}

/**
 * The four servers and the two tools the suite imports from each. Each first
 * tool is a read. `create_payment` is the irreversible tool the approval
 * policy parks, and the MCP server's `create_issue` is the tool the Cedar
 * policy forbids the test agent.
 */
export const SERVERS: readonly StudioServer[] = [
  {
    folder: "live_mcp",
    kind: "mcp",
    tools: [
      { name: "list_repositories", risk: "low", sideEffect: "read", egress: "third_party", impacts: [] },
      { name: "create_issue", risk: "medium", sideEffect: "write", egress: "third_party", impacts: [] },
    ],
  },
  {
    folder: "live_payments",
    kind: "openapi",
    tools: [
      { name: "get_payment", risk: "low", sideEffect: "read", egress: "third_party", impacts: [] },
      {
        name: "create_payment",
        risk: "high",
        sideEffect: "irreversible",
        egress: "third_party",
        impacts: ["moves_money"],
      },
    ],
  },
  {
    folder: "live_desk",
    kind: "graphql",
    tools: [
      { name: "issue", risk: "low", sideEffect: "read", egress: "third_party", impacts: [] },
      { name: "create_issue", risk: "medium", sideEffect: "write", egress: "third_party", impacts: [] },
    ],
  },
  {
    folder: "live_ledger",
    kind: "grpc",
    tools: [
      { name: "get_entry", risk: "low", sideEffect: "read", egress: "org_tenant", impacts: [] },
      { name: "post_entry", risk: "medium", sideEffect: "write", egress: "org_tenant", impacts: [] },
    ],
  },
];

/** The name an agent calls a tool by. */
export function servedName(server: StudioServer, tool: ImportedTool): string {
  return `${server.folder}__${tool.name}`;
}

export function serverFor(folder: string): StudioServer {
  const server = SERVERS.find((s) => s.folder === folder);
  if (server === undefined) throw new Error(`The suite imports no server folder ${folder}.`);
  return server;
}

/** A fixture file from M0, as text. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../packages/mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

const toml = (value: string): string => JSON.stringify(value);

/** server.toml for one folder. Every folder syncs only when asked, so no hourly run races the suite. */
export function serverToml(server: StudioServer, settings: StudioSettings, grpcPort: number): string {
  const head = [
    "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
    'schema = "mcp-server/v1"',
    `name = ${toml(server.folder)}`,
    `label = ${toml(`Live ${server.kind} sample`)}`,
    `description = ${toml(`The sample ${server.kind} server the MCP Studio live test imports.`)}`,
    "",
  ];
  const bearer = [
    "[auth]",
    'mode = "service"',
    'scheme = "bearer"',
    `credential = ${toml(`oxagen:credential/${UPSTREAM_CREDENTIAL}`)}`,
    "",
  ];
  const tail = ["[exposure]", 'mode = "direct"', "", "[sync]", 'schedule = "manual"', ""];
  switch (server.kind) {
    case "mcp":
      return [
        ...head,
        "[source]",
        'type = "remote"',
        `url = ${toml(`${settings.tunnelUrl}/mcp`)}`,
        'transport = "http"',
        "",
        ...bearer,
        ...tail,
      ].join("\n");
    case "openapi":
    case "graphql":
      return [
        ...head,
        "[source]",
        `type = ${toml(server.kind)}`,
        'from = "upload"',
        "",
        ...bearer,
        "[environments.sandbox]",
        `url = ${toml(`${settings.tunnelUrl}/${server.kind}`)}`,
        "",
        ...tail,
      ].join("\n");
    case "grpc":
      // Production refuses a private address, so this environment is
      // reachable only through the relay, which runs beside the server.
      return [
        ...head,
        "[source]",
        'type = "grpc"',
        'from = "upload"',
        "",
        "[auth]",
        'mode = "none"',
        "",
        "[environments.sandbox]",
        `url = ${toml(`http://127.0.0.1:${String(grpcPort)}`)}`,
        `network = ${toml(`relay:${settings.relayName}`)}`,
        "",
        ...tail,
      ].join("\n");
  }
}

/** What the folder imports from. Every source is inline, so no import step fetches anything. */
export function studioSource(server: StudioServer, mcpTools: McpListing | null): Record<string, unknown> {
  switch (server.kind) {
    case "mcp":
      if (mcpTools === null) throw new Error("The MCP server's source needs its tools/list result.");
      return {
        type: "mcp",
        lockSource: { type: "remote", url: mcpTools.url, server_version: mcpTools.serverVersion },
        tools: mcpTools.tools,
      };
    case "openapi":
      return { type: "openapi", files: [{ path: "openapi.yaml", text: fixture("openapi/openapi-3.1.yaml") }], entry: "openapi.yaml" };
    case "graphql":
      return { type: "graphql", sdl: fixture("graphql/schema.graphql") };
    case "grpc":
      return { type: "grpc", files: [{ path: "proto/ledger.proto", text: fixture("grpc/ledger.proto") }] };
  }
}

/** The draft's edits: import both tools and classify each one. */
export function draftOps(server: StudioServer): Record<string, unknown>[] {
  return server.tools.flatMap((tool) => [
    { kind: "import", tool: tool.name },
    {
      kind: "classify",
      tool: tool.name,
      risk: tool.risk,
      sideEffect: tool.sideEffect,
      egress: tool.egress,
      impacts: tool.impacts,
    },
  ]);
}

/**
 * The Cedar policies the suite publishes after the tools. The first parks
 * every irreversible call until a person approves it. The second forbids the
 * test agent the MCP server's create_issue in every case, so the gateway also
 * leaves that tool out of the agent's tools/list. `agent` is the name of the
 * agent file enrollment proposed: the runtime's slug (ADR-265).
 */
export function policyMarkdown(agent: string): string {
  return [
    "# MCP Studio live test policies",
    "",
    "Every irreversible tool call waits for a person's approval.",
    "",
    "```cedar",
    '@id("live.irreversible-approval")',
    '@decision("require_approval")',
    "forbid (principal, action, resource)",
    'when { context.tool.side_effect == "irreversible" }',
    "unless { context.approval.granted };",
    "```",
    "",
    "The test agent may not create an issue through the sample MCP server.",
    "",
    "```cedar",
    '@id("live.deny-create-issue")',
    `forbid (principal == Agent::${toml(agent)}, action == Action::"live_mcp__create_issue", resource);`,
    "```",
    "",
  ].join("\n");
}

// ── Oxagen ───────────────────────────────────────────────────────────────────

// Local schemas for the fields the suite reads. As in steering-rig.ts, each
// Fits line below fails the typecheck when a shared contract stops fitting.

const pullRequest = z.object({ number: z.number().int(), url: z.string(), branch: z.string() });

const credentialSet = z.object({ name: z.string(), reference: z.string(), created: z.boolean() });

const draftSaved = z.object({ server: z.string(), revision: z.number().int(), pr: pullRequest.nullable() });

const draftRead = z.object({ draft: draftSaved.nullable() });

const reviewOpened = z.object({
  number: z.number().int(),
  url: z.string(),
  branch: z.string(),
  headSha: z.string(),
  imported: z.array(z.string()),
  findings: z.array(
    z.object({
      rule: z.string(),
      level: z.enum(["error", "warning", "info"]),
      tool: z.string().nullable(),
      message: z.string(),
    }),
  ),
});
export type ReviewOpened = z.output<typeof reviewOpened>;

const discovery = z.object({
  status: z.enum(["queued", "running", "waiting_for_machine", "succeeded", "failed"]),
  error: z.string().nullable(),
  outcome: z.enum(["unchanged", "pr_opened", "pr_updated", "needs_digest", "skipped"]).nullable(),
  pr: pullRequest.nullable(),
  withheld: z.array(z.string()),
});
export type Discovery = z.output<typeof discovery>;

const discoveryRead = z.object({ discovery: discovery.nullable() });
const discoveryStarted = z.object({ discovery });

const relayCreated = z.object({ publicId: z.string(), name: z.string(), token: z.string() });
const relayRevoked = z.object({ name: z.string(), revokedAt: z.string() });

const hostEnrolled = z.object({
  hostEnrollmentId: z.string(),
  gatewayApiKey: z.string().optional(),
  bundlePublicKeyPem: z.string(),
});

const runtimeListed = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
});

const approvalsListed = z.object({
  items: z.array(z.object({ id: z.string(), tool: z.string() })),
  nextCursor: z.string().nullable(),
});

/** A policy row as parse returns it, every field kept. Commit takes the row back with `action` set. */
const policyRow = z.looseObject({
  path: z.string(),
  issues: z.array(z.looseObject({ message: z.string() })),
  action: z.enum(["add", "skip"]),
});

const importParsed = z.object({ policies: z.array(policyRow) });

/** The proposals on one lineage, each with its kind and the steering PR it carries. */
const agentProposals = z.object({
  proposals: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      status: z.string(),
      pr: z.object({ number: z.number().int(), branch: z.string() }).nullable(),
    }),
  ),
});

/** The open proposals, each with the steering PR it carries. */
const openProposals = z.object({
  proposals: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      pr: z.object({ number: z.number().int(), branch: z.string() }).nullable(),
    }),
  ),
});

const importCommitted = z.object({
  pullRequest: z
    .object({ number: z.number().int(), url: z.string(), branch: z.string(), headSha: z.string() })
    .nullable(),
});

type Fits<Contract, Local> = [Contract] extends [Local] ? true : false;
type Assert<T extends true> = T;

/** One entry per route the suite calls. An entry that stops fitting fails the typecheck. */
export type StudioContractFit = [
  Assert<Fits<ToolStudioCredentialSetOutput, z.output<typeof credentialSet>>>,
  Assert<Fits<ToolStudioDraftSaveOutput, z.output<typeof draftSaved>>>,
  Assert<Fits<ToolStudioDraftGetOutput, z.output<typeof draftRead>>>,
  Assert<Fits<ToolStudioReviewOpenOutput, ReviewOpened>>,
  Assert<Fits<ToolStudioDiscoveryStartOutput, z.output<typeof discoveryStarted>>>,
  Assert<Fits<ToolStudioDiscoveryGetOutput, z.output<typeof discoveryRead>>>,
  Assert<Fits<ToolRelayCreateOutput, z.output<typeof relayCreated>>>,
  Assert<Fits<ToolRelayRevokeOutput, z.output<typeof relayRevoked>>>,
  Assert<Fits<TachoEnrollmentCreateOutput, z.output<typeof hostEnrolled>>>,
  Assert<Fits<{ items: RuntimeListItem[] }, z.output<typeof runtimeListed>>>,
  Assert<Fits<AgentApprovalListOutput, z.output<typeof approvalsListed>>>,
  Assert<Fits<SteeringMarkdownImportParseOutput, z.output<typeof importParsed>>>,
  Assert<Fits<SteeringMarkdownImportCommitOutput, z.output<typeof importCommitted>>>,
  Assert<Fits<ContextProposalListOutput, z.output<typeof openProposals>>>,
  Assert<Fits<ContextProposalListOutput, z.output<typeof agentProposals>>>,
];

function path(settings: Settings, rest: string): string {
  return workspacePath(settings, settings.runSlug, rest);
}

/** Stores the sample upstreams' bearer token as the workspace credential server.toml names. */
export function setUpstreamCredential(ox: Oxagen, settings: StudioSettings) {
  return ox.call(
    "POST",
    path(settings, "/tools/studio/credential"),
    { name: UPSTREAM_CREDENTIAL, kind: "secret", secret: settings.upstreamToken },
    credentialSet,
  );
}

export function saveDraft(
  ox: Oxagen,
  settings: Settings,
  draft: { server: string; serverToml: string; ops: Record<string, unknown>[]; source: Record<string, unknown> },
) {
  return ox.call("POST", path(settings, "/tools/studio/draft"), draft, draftSaved);
}

export function readDraft(ox: Oxagen, settings: Settings, server: string) {
  return ox.call("POST", path(settings, "/tools/studio/draft/get"), { server }, draftRead);
}

export function openReview(ox: Oxagen, settings: Settings, server: string) {
  return ox.call("POST", path(settings, "/tools/studio/review"), { server }, reviewOpened);
}

export function startDiscovery(ox: Oxagen, settings: Settings, server: string) {
  return ox.call("POST", path(settings, "/tools/studio/discovery/start"), { server }, discoveryStarted);
}

export function readDiscovery(ox: Oxagen, settings: Settings, server: string) {
  return ox.call("POST", path(settings, "/tools/studio/discovery/get"), { server }, discoveryRead);
}

export function createRelay(ox: Oxagen, settings: StudioSettings) {
  return ox.call("POST", path(settings, "/tools/relays"), { name: settings.relayName }, relayCreated);
}

export function revokeRelay(ox: Oxagen, settings: StudioSettings) {
  return ox.call("POST", path(settings, "/tools/relays/revoke"), { name: settings.relayName }, relayRevoked);
}

/** A host enrollment's gateway key, and the key Oxagen signs bundles and relay calls with. */
export interface Host {
  hostEnrollmentId: string;
  gatewayKey: string;
  signingKeyPem: string;
}

/**
 * Enrolls a host named after the run, valid for one day. Every enrollment
 * with this hostname binds the same runtime, so a test in a new worker
 * enrolls again and the agent file still matches.
 */
export async function enrollHost(ox: Oxagen, settings: Settings): Promise<Host> {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const enrolled = await ox.call(
    "POST",
    path(settings, "/tacho/enrollments"),
    {
      hostname: settings.runSlug,
      osUser: "runner",
      platform: "linux",
      devicePublicKey: `ed25519:${der.toString("base64")}`,
      harnesses: ["claude-code"],
      validityDays: 1,
    },
    hostEnrolled,
  );
  if (enrolled.gatewayApiKey === undefined) {
    throw new Error(`Enrollment ${enrolled.hostEnrollmentId} returned no gateway key, so no agent can call a served tool.`);
  }
  return {
    hostEnrollmentId: enrolled.hostEnrollmentId,
    gatewayKey: enrolled.gatewayApiKey,
    signingKeyPem: enrolled.bundlePublicKeyPem,
  };
}

/** The slug of the runtime the run's host enrollment bound, which the agent file names. */
export async function hostRuntime(ox: Oxagen, settings: Settings): Promise<string> {
  const listed = await ox.call("POST", path(settings, "/runtimes"), {}, runtimeListed);
  const runtime = listed.items.find((r) => r.name.toLowerCase() === settings.runSlug);
  if (runtime === undefined) {
    throw new Error(
      `Workspace ${settings.runSlug} has no runtime named ${settings.runSlug}. Enrollment binds one, so read the enrollment's error first.`,
    );
  }
  return runtime.slug;
}

export async function listApprovals(ox: Oxagen, settings: Settings) {
  const listed = await ox.call("POST", path(settings, "/agent/approvals/list"), { limit: 100 }, approvalsListed);
  return listed.items;
}

/**
 * Opens the steering PR that adds the suite's Cedar policies, through the
 * Markdown import. Parse turns each fenced cedar block into a policy file,
 * and commit opens one steering PR with every row marked add.
 */
export async function openPolicyPr(ox: Oxagen, settings: Settings) {
  const agent = agentNameFor(await hostRuntime(ox, settings));
  const parsed = await ox.call(
    "POST",
    path(settings, "/context/steering/import/parse"),
    { documents: [{ filename: "mcp-live-policies.md", content: policyMarkdown(agent), target: "policies" }] },
    importParsed,
  );
  const problems = parsed.policies.flatMap((row) => row.issues.map((issue) => `${row.path}: ${issue.message}`));
  if (parsed.policies.length === 0 || problems.length > 0) {
    throw new Error(
      `The Markdown import found ${String(parsed.policies.length)} policy files and these problems: ${problems.join("; ") || "none"}.`,
    );
  }
  const committed = await ox.call(
    "POST",
    path(settings, "/context/steering/import/commit"),
    { records: [], memories: [], policies: parsed.policies.map((row) => ({ ...row, action: "add" })) },
    importCommitted,
  );
  if (committed.pullRequest === null) {
    throw new Error("The Markdown import opened no steering PR, though every policy row was marked add.");
  }
  return committed.pullRequest;
}

// ── Steering PRs ─────────────────────────────────────────────────────────────

/** A steering PR the suite merges: a Studio Review, a sync, a Markdown import, or an agent file. */
export interface BarePullRequest {
  number: number;
  headSha: string;
}

/** The open proposal that carries steering PR `number`, or null when none does. */
async function openProposalFor(ox: Oxagen, settings: Settings, number: number) {
  const listed = await ox.call(
    "POST",
    path(settings, "/context/proposals"),
    { state: "open", limit: 200 },
    openProposals,
  );
  return listed.proposals.find((p) => p.pr?.number === number) ?? null;
}

/**
 * Merges a steering PR through Oxagen. Each opener writes a proposal row for
 * the PR it opens (#5122), so the suite finds the row by the PR's number and
 * calls `merge_context_pr` with it. The merge runs the steering checks on the
 * PR's head, lands it through the merge queue, and answers the steering
 * version it published.
 */
export async function mergeSteeringPullRequest(
  ox: Oxagen,
  settings: Settings,
  pr: BarePullRequest,
): Promise<{ publishedVersion: number | null }> {
  const proposal = await openProposalFor(ox, settings, pr.number);
  if (proposal === null) {
    throw new Error(
      `No open proposal in workspace ${settings.runSlug} carries steering PR #${String(pr.number)}. Its opener writes one when it opens the PR, so read the API log for a "proposal row was not written" error.`,
    );
  }
  const merged = await mergeSteeringPr(ox, settings, proposal.id);
  return { publishedVersion: merged.publishedVersion };
}

// ── The agent file ───────────────────────────────────────────────────────────

/** The name of the agent file enrollment proposes for a runtime: its slug (ADR-265). */
function agentNameFor(runtime: string): string {
  const name = agentNameForRuntime(runtime);
  if (name === null) {
    throw new Error(`Runtime ${runtime} has a slug no agent file can be named after, so enrollment proposed none.`);
  }
  return name;
}

/**
 * The steering PR that adds `agents/<runtime>.toml`, which the host's
 * enrollment opened (#5149). The MCP gateway needs the file before it serves
 * any tool to the host. The file names the enrolling member as operator, the
 * runtime, and the harness the host reported. The suite merges it through
 * `mergeSteeringPullRequest`.
 */
export async function publishAgentFile(ox: Oxagen, settings: Settings, runtime: string): Promise<BarePullRequest> {
  const branch = `agents/${agentNameFor(runtime)}`;
  const listed = await ox.call(
    "POST",
    path(settings, "/context/proposals"),
    { lineageId: branch, limit: 20 },
    agentProposals,
  );
  const proposal = listed.proposals.find(
    (p) => p.kind === "agent_file" && p.status !== "rejected" && p.pr !== null,
  );
  if (proposal === undefined || proposal.pr === null) {
    throw new Error(
      `Enrollment opened no agent file PR on ${branch} in workspace ${settings.runSlug}. Read the API log for the enrollment's "agent file:" line, which says why.`,
    );
  }
  const view = await readSteeringPr(ox, settings, proposal.id);
  return { number: proposal.pr.number, headSha: view.pr?.headSha ?? "" };
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/**
 * Waits for the newest "Oxagen steering" check run on a commit to finish, and
 * answers it whatever its conclusion. A tools steering PR has no proposal, so
 * the suite reads its check on GitHub instead of through Oxagen.
 */
export function waitForSteeringCheck(gh: GithubRig, fullName: string, sha: string) {
  return poll(
    `the Oxagen steering check on ${fullName}@${sha.slice(0, 7)}`,
    { timeoutMs: 5 * MINUTE, intervalMs: 5 * SECOND },
    async () => {
      const run = newestRun(await gh.steeringCheckRuns(fullName, sha));
      if (run === null) return waiting("no check run");
      return run.status === "completed" ? reached(run) : waiting(`status ${run.status}`);
    },
  );
}

// ── MCP gateway ──────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_PARAMS = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "oxagen-mcp-studio-live-test", version: "1" },
};

const servedTool = z.looseObject({ name: z.string(), description: z.string().optional() });
export type ServedTool = z.output<typeof servedTool>;

const toolsListed = z.object({ tools: z.array(servedTool), nextCursor: z.string().optional() });

const callResult = z.object({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export type CallResult = z.output<typeof callResult>;

/** The text items of a tool result, joined. */
export function textOf(result: CallResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

const rpcReply = z.object({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

/** The JSON-RPC reply to request `id`, from a JSON body or an event stream. */
function rpcPayload(contentType: string, text: string, id: number, what: string): unknown {
  const messages: unknown[] = [];
  if (contentType.split(";")[0]?.trim().toLowerCase() === "text/event-stream") {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        messages.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // A keep-alive or a partial line carries no reply.
      }
    }
  } else {
    messages.push(parseBody(what, text, z.unknown()));
  }
  for (const message of messages.flatMap((m) => (Array.isArray(m) ? (m as unknown[]) : [m]))) {
    const reply = rpcReply.safeParse(message);
    if (!reply.success || reply.data.id !== id) continue;
    if (reply.data.error !== undefined) {
      throw new Error(`${what} answered JSON-RPC error ${String(reply.data.error.code)}: ${reply.data.error.message}`);
    }
    return reply.data.result;
  }
  throw new Error(`${what} sent no reply to request ${String(id)}: ${excerpt(text)}`);
}

export interface Gateway {
  listTools(): Promise<ServedTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallResult>;
}

/** Calls Oxagen's MCP endpoint as the enrolled host, with its gateway key. */
export function gateway(settings: StudioSettings, key: string): Gateway {
  let nextId = 1;
  let started: Promise<void> | undefined;

  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const what = `MCP ${method}`;
    const res = await fetch(settings.mcpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL_VERSION,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${what} answered ${String(res.status)}: ${excerpt(text)}`);
    return rpcPayload(res.headers.get("content-type") ?? "", text, id, what);
  }

  /** The endpoint is stateless, so one initialize per client is enough to check the key. */
  function start(): Promise<void> {
    started ??= rpc("initialize", INITIALIZE_PARAMS).then(() => undefined);
    return started;
  }

  return {
    async listTools() {
      await start();
      const tools: ServedTool[] = [];
      let cursor: string | undefined;
      do {
        const page = toolsListed.parse(await rpc("tools/list", cursor === undefined ? {} : { cursor }));
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    async callTool(name, args) {
      await start();
      return callResult.parse(await rpc("tools/call", { name, arguments: args }));
    },
  };
}

// ── Sample servers ───────────────────────────────────────────────────────────

const receivedCall = z.object({ upstream: z.string(), name: z.string(), at: z.string() });
export type ReceivedCall = z.output<typeof receivedCall>;

const relayEvent = z.object({ event: z.string(), code: z.union([z.string(), z.number()]).optional(), at: z.string() });
export type RelayEvent = z.output<typeof relayEvent>;

const controlStatus = z.object({
  grpcPort: z.number().int(),
  calls: z.array(receivedCall),
  relay: z.object({ running: z.boolean(), exitCode: z.number().nullable(), events: z.array(relayEvent) }),
});
export type ControlStatus = z.output<typeof controlStatus>;

/** The MCP server's tools/list, read through the tunnel as Oxagen's discovery would read it. */
export interface McpListing {
  url: string;
  serverVersion: string | undefined;
  tools: Record<string, unknown>[];
}

const initializeResult = z.object({ serverInfo: z.object({ version: z.string().optional() }).optional() });
const toolsListResult = z.object({ tools: z.array(z.record(z.string(), z.unknown())) });

export interface Control {
  status(): Promise<ControlStatus>;
  setDescription(tool: string, description: string): Promise<void>;
  startRelay(start: { token: string; workspace: string; trustedKeys: string }): Promise<void>;
  stopRelay(): Promise<void>;
  /** Lists the sample MCP server's tools through the public tunnel, with the run's token. */
  listMcpTools(): Promise<McpListing>;
}

export function control(settings: StudioSettings): Control {
  async function call<S extends z.ZodType>(method: "GET" | "POST", route: string, body: unknown, schema: S) {
    const res = await fetch(`${settings.controlUrl}${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const what = `The sample servers' ${method} ${route}`;
    if (!res.ok) throw new HttpError(res.status, `${what} answered ${String(res.status)}: ${excerpt(text)}`);
    return parseBody(what, text, schema);
  }

  async function mcp(method: string, id: number): Promise<unknown> {
    const url = `${settings.tunnelUrl}/mcp`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${settings.upstreamToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? INITIALIZE_PARAMS : {} }),
    });
    const text = await res.text();
    const what = `The sample MCP server's ${method} through the tunnel`;
    if (!res.ok) throw new HttpError(res.status, `${what} answered ${String(res.status)}: ${excerpt(text)}`);
    return rpcPayload(res.headers.get("content-type") ?? "", text, id, what);
  }

  return {
    status: () => call("GET", "/status", undefined, controlStatus),
    async setDescription(tool, description) {
      await call("POST", "/mcp/description", { tool, description }, z.unknown());
    },
    async startRelay(start) {
      await call(
        "POST",
        "/relay/start",
        { brokerUrl: settings.brokerUrl, name: settings.relayName, ...start },
        z.unknown(),
      );
    },
    async stopRelay() {
      await call("POST", "/relay/stop", {}, z.unknown());
    },
    async listMcpTools() {
      const init = initializeResult.parse(await mcp("initialize", 1));
      const listed = toolsListResult.parse(await mcp("tools/list", 2));
      return { url: `${settings.tunnelUrl}/mcp`, serverVersion: init.serverInfo?.version, tools: listed.tools };
    },
  };
}

/** The calls one upstream received for one name, such as the MCP server's `create_issue`. */
export function callsTo(status: ControlStatus, upstream: string, name: string): ReceivedCall[] {
  return status.calls.filter((c) => c.upstream === upstream && c.name === name);
}

/** The relay's log events, on one line, for an error message. */
export function describeRelay(status: ControlStatus): string {
  const events = status.relay.events.map((e) => (e.code === undefined ? e.event : `${e.event}(${String(e.code)})`));
  return `running ${String(status.relay.running)}, exit code ${status.relay.exitCode === null ? "none" : String(status.relay.exitCode)}, events [${events.join(", ")}]`;
}

/** Waits until the relay logs an event the predicate accepts. */
export function waitForRelay(
  ctl: Control,
  what: string,
  timeoutMs: number,
  accept: (event: RelayEvent) => boolean,
): Promise<RelayEvent> {
  return poll(what, { timeoutMs, intervalMs: 2 * SECOND }, async () => {
    const status = await ctl.status();
    const hit = status.relay.events.find(accept);
    return hit === undefined ? waiting(describeRelay(status)) : reached(hit);
  });
}

/** Waits for a server's discovery to finish, and answers it whatever its outcome. */
export function waitForDiscovery(ox: Oxagen, settings: Settings, server: string): Promise<Discovery> {
  return poll(`discovery of ${server} finished`, { timeoutMs: 10 * MINUTE, intervalMs: 5 * SECOND }, async () => {
    const read = await readDiscovery(ox, settings, server);
    const d = read.discovery;
    if (d === null) return waiting("no discovery yet");
    return d.status === "succeeded" || d.status === "failed" ? reached(d) : waiting(`status ${d.status}`);
  });
}
