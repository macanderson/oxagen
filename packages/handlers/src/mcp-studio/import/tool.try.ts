// tool.try.ts: try_studio_tool (mcp-studio-spec, lane M9, Try it).
//
// Studio's Try it button runs one tool once, against the environment a person
// picks, with the arguments they typed. The call is decided the way a served
// call is (lane M15), and M6's executor sends it:
//
//   1. Build the saved draft, or production's folder, as the findings panel
//      does, and find the tool. It must be imported and classified.
//   2. Read the workspace's published steering version. Its policies and
//      agents decide the call. The draft's tools stand in for the published
//      tools of the same server, so a draft classification is what is decided.
//   3. Check the off switches and the kill switches, then decide the call with
//      Cedar on the gateway tier. A rule that asks for approval denies it,
//      because Try it opens no approval.
//   4. Read the environment's credential and send the call over the cloud
//      transport, with a 30-second limit.
//   5. Return the first upstream request and answer with every credential
//      removed, and the shaped result the agent would receive.
//
// A problem with the folder, the tool, the environment, or the published
// version throws a HandlerError before the decision, and the kernel does not
// meter it. Every answer from step 3 on is an output, ok or not, and the
// kernel meters it once as a governed action.
import {
  CREDENTIAL_REQUEST_HEADERS,
  CREDENTIAL_RESPONSE_HEADERS,
  executeCall,
  inputRefusal,
  toManifestServer,
  type CallToolResult,
  type CredentialSource,
  type ManifestAuth,
  type ManifestEnvironment,
  type ManifestServer,
  type ManifestTool,
  type RecordedExchange,
  type ResolvedCredential,
  type Transport,
} from "@oxagen/mcp-studio";
import { HandlerError, type CapabilityContext, type CapabilityHandler } from "@oxagen/oxagen";
import {
  TRY_REQUEST_MAX,
  TRY_RESULT_MAX,
  toolStudioTry,
  type ToolStudioTryInput,
  type ToolStudioTryOutput,
} from "@oxagen/oxagen/contracts/tool.studio.try";
import {
  cedarTools,
  compilePolicies,
  decideToolCall,
  type AgentDeclaration,
  type CedarRuntime,
  type CompiledPolicySet,
  type PolicyFile,
  type ToolCallVerdict,
} from "@oxagen/policy";
import type { SteeringRepository } from "../../context.steering.github";
import type { ToolsPullRequestScope } from "../../tools.pr.open";
import type { BuiltFolder } from "./build";
import { buildStudioFolderView, type ListStudioFindingsDeps } from "./findings.list";
import { findStudioTool } from "./tool.find";

/** How long one Try it call may take, credential read included. */
export const TRY_TIMEOUT_MS = 30_000;
/** The longest upstream error message an ok:false answer carries. */
const FAILURE_TEXT_MAX = 2_000;
/** What a redacted header or query value reads as. */
export const REDACTED = "[redacted]";
/** A secret shorter than this is not scrubbed from text, since it would match ordinary words. */
const SCRUB_MIN = 4;
/** The most names a refusal lists. */
const NAMES_MAX = 20;

/** The workspace's published steering version, as Try it reads it. */
export interface PublishedSteering {
  /** The workspace's slug. Policies name the workspace by it. */
  workspace: string;
  version: number;
  /** The servers of the compiled tool manifest. */
  servers: ManifestServer[];
  policies: PolicyFile[];
  agents: AgentDeclaration[];
}

/** A kill switch that stops the call. */
export interface TryEmergencyStop {
  id: string;
  targetKind: string;
  targetId: string;
  reason: string;
}

/** The facts a kill switch can name. */
export interface TryEmergencyCall {
  server: string;
  tool: string;
  /** The environment's service credential, or null when the call runs on none. */
  credential: string | null;
  readOnly: boolean;
}

export interface TryStudioToolDeps extends ListStudioFindingsDeps {
  /** The workspace's published version of the repository, or null when nothing is published. */
  published: (scope: ToolsPullRequestScope, repo: SteeringRepository) => Promise<PublishedSteering | null>;
  /** Cedar's evaluator, or null when it did not load. */
  cedar: () => Promise<CedarRuntime | null>;
  /** The servers and tools a workspace admin switched off in Oxagen. */
  off: (scope: ToolsPullRequestScope) => Promise<{ servers: ReadonlySet<string>; tools: ReadonlySet<string> }>;
  /** The kill switch that stops the call, or null when none does. */
  emergencyDeny: (ctx: CapabilityContext, call: TryEmergencyCall) => Promise<TryEmergencyStop | null>;
  /** The person's workspace role, as a policy's operator_role reads it. */
  operatorRole: (scope: ToolsPullRequestScope, userId: string) => Promise<string | undefined>;
  /** The workspace's credentials. */
  credentialSource: (scope: ToolsPullRequestScope) => CredentialSource;
  /** The transport for a cloud environment. */
  transport: () => Transport;
  now?: () => number;
  timeoutMs?: number;
  /** Warnings. No caller passes a secret in its fields. */
  log: { warn: (fields: Record<string, unknown>, message: string) => void };
}

/** An error's name for a log line. A message can quote a row, a request, or a secret, so it is never logged. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Text as one sentence that ends in a single period, whether or not it had one. */
function sentenceOf(text: string): string {
  let end = text.trimEnd();
  while (end.endsWith(".")) end = end.slice(0, -1).trimEnd();
  return `${end}.`;
}

/** Up to NAMES_MAX names, in a list a sentence can end with. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_MAX).join(", ");
  return names.length > NAMES_MAX ? `${shown}, and ${names.length - NAMES_MAX} more` : shown;
}

/** JSON with every object's keys sorted, so two equal values compare equal as text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const entries = Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  });
}

/** Text cut to `max` characters, the note that says so included. */
export function capText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const note = `\n(cut to ${max} of ${text.length} characters)`;
  let kept = text.slice(0, Math.max(0, max - note.length));
  // A cut through a surrogate pair would leave half a character.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return { text: `${kept}${note}`, cut: true };
}

const REQUEST_HEADERS: ReadonlySet<string> = new Set(CREDENTIAL_REQUEST_HEADERS);
const RESPONSE_HEADERS: ReadonlySet<string> = new Set(CREDENTIAL_RESPONSE_HEADERS);
const SECRET_NAMES: ReadonlySet<string> = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "signature",
  "sig",
  "key",
  "auth",
  "authorization",
  "sessionid",
  "session",
]);
const SECRET_SUFFIXES = ["token", "secret", "password", "apikey", "signature"];

/** True for a header or query name that usually carries a secret, such as X-Api-Key or client_secret. */
function secretLooking(name: string): boolean {
  const bare = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_NAMES.has(bare) || SECRET_SUFFIXES.some((suffix) => bare.endsWith(suffix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redacted(values: Record<string, unknown>, secret: (name: string) => boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, secret(name) ? REDACTED : value]));
}

/**
 * One exchange with every credential value replaced by "[redacted]": the
 * credential headers, the API key's header or query parameter, and any header
 * or query parameter whose name usually carries a secret. The executor records
 * a request before it adds the credential, so this is a second guard for a
 * secret an argument or a template put in the request.
 */
export function redactExchange(exchange: RecordedExchange, auth: ManifestAuth | null): RecordedExchange {
  const apiKey = auth !== null && auth.apply.type === "api_key" ? auth.apply : null;
  const requestSecret = (name: string, where: "header" | "query"): boolean => {
    const lower = name.toLowerCase();
    if (where === "header" && REQUEST_HEADERS.has(lower)) return true;
    if (apiKey !== null && apiKey.in === where && apiKey.name?.toLowerCase() === lower) return true;
    return secretLooking(name);
  };
  const request: Record<string, unknown> = { ...exchange.request };
  if (isRecord(request.headers)) request.headers = redacted(request.headers, (name) => requestSecret(name, "header"));
  if (isRecord(request.query)) request.query = redacted(request.query, (name) => requestSecret(name, "query"));
  const response: Record<string, unknown> = { ...exchange.response };
  if (isRecord(response.headers)) {
    response.headers = redacted(response.headers, (name) => RESPONSE_HEADERS.has(name.toLowerCase()) || secretLooking(name));
  }
  return { request, response } as RecordedExchange;
}

/** The secret values a resolved credential sends, to scrub from any text Try it returns. */
function secretsOf(credential: ResolvedCredential | null): string[] {
  if (credential === null) return [];
  switch (credential.type) {
    case "bearer":
      return [credential.token];
    case "basic":
      return [
        credential.password,
        Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64"),
      ];
    case "api_key":
      return [credential.value];
    case "relay":
    case "missing":
      return [];
  }
}

function scrubber(secrets: readonly string[]): (text: string) => string {
  const long = secrets.filter((secret) => secret.length >= SCRUB_MIN);
  return (text) => long.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, REDACTED), text);
}

/** The shaped result as the agent would read it: structured content as JSON, or the text parts. */
function shapedText(result: CallToolResult): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  const texts = result.content.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  return texts.length > 0 ? texts.join("\n") : JSON.stringify(result.content, null, 2);
}

/** A tool the folder imported, compiled into its manifest form. */
interface TriedTool {
  key: string;
  server: ManifestServer;
  tool: ManifestTool;
}

function triedTool(folder: BuiltFolder, name: string, log: TryStudioToolDeps["log"]): TriedTool {
  const target = findStudioTool(folder, name);
  if (target === null) {
    throw new HandlerError({
      code: "not_found",
      reason: "tool_not_found",
      message: `${folder.server} has no tool named ${name}, and its source offers none by that name. Name the tool by its tools.toml key or the name the agent sees.`,
    });
  }
  const key = target.key;
  if (key === null) {
    throw new HandlerError({
      code: "not_found",
      reason: "tool_not_imported",
      message: `${folder.server}'s source offers ${name}, and the folder has not imported it. Import and classify it, then try it.`,
    });
  }
  if (folder.findings.some((finding) => finding.rule === "missing_classification" && finding.tool === key)) {
    throw new HandlerError({
      code: "conflict",
      reason: "tool_unclassified",
      message: `${key} has no classification yet, so no policy can decide it. Give it a risk, a side effect, and an egress, then try it.`,
    });
  }
  let server: ManifestServer | undefined;
  let tool: ManifestTool | undefined;
  try {
    server = toManifestServer(folder.compiled, folder.lock);
    tool = Object.hasOwn(server.tools, key) ? server.tools[key] : undefined;
  } catch (error) {
    log.warn({ server: folder.server, error: errorName(error) }, "The folder's compiled server and lock do not match.");
  }
  if (server === undefined || tool === undefined) {
    throw new HandlerError({
      code: "conflict",
      reason: "folder_not_locked",
      message: `${folder.server}'s lock has no entry for ${key}, so Oxagen cannot build the call. Run list_studio_findings to see what the folder needs.`,
    });
  }
  return { key, server, tool };
}

type ChosenEnvironment = { name: string; entry: ManifestEnvironment };

function chosenEnvironment(server: ManifestServer, name: string): ChosenEnvironment {
  const entry = Object.hasOwn(server.environments, name) ? server.environments[name] : undefined;
  if (entry === undefined) {
    const names = Object.keys(server.environments);
    throw new HandlerError({
      code: "not_found",
      reason: "environment_not_found",
      message:
        names.length === 0
          ? `${server.name} has no environments. Add one to its server.toml in Studio, then try the tool.`
          : `${server.name} has no environment named ${name}. Its environments are ${nameList(names)}.`,
    });
  }
  if (entry.network !== "cloud") {
    throw new HandlerError({
      code: "conflict",
      reason: "network_unsupported",
      message: `${server.name}'s ${name} environment runs on ${entry.network}, and Try it sends calls only over the cloud network. Pick an environment on the cloud network.`,
    });
  }
  return { name, entry };
}

/**
 * Refuse a credential sent where no merged steering PR sent it. A server with
 * sign-in may be tried only on an environment whose address and credential,
 * and whose sign-in, match the published version. Otherwise a draft could
 * send a workspace credential to an address nobody reviewed.
 */
function assertPublishedBinding(server: ManifestServer, environment: string, published: PublishedSteering): void {
  if (server.auth === null) return;
  const twin = published.servers.find((entry) => entry.name === server.name);
  if (
    twin !== undefined &&
    canonical(twin.auth) === canonical(server.auth) &&
    canonical(twin.environments[environment]) === canonical(server.environments[environment])
  ) {
    return;
  }
  throw new HandlerError({
    code: "conflict",
    reason: "environment_unpublished",
    message: `${server.name}'s ${environment} environment or sign-in differs from the published version. Try it sends a workspace credential only to an address a merged steering PR set, so open a Review, merge it, and try the tool again.`,
  });
}

function chosenAgent(published: PublishedSteering, name: string | undefined, tool: string): AgentDeclaration {
  const names = published.agents.map((agent) => agent.name);
  if (name !== undefined) {
    const agent = published.agents.find((entry) => entry.name === name);
    if (agent !== undefined) return agent;
    throw new HandlerError({
      code: "not_found",
      reason: "agent_not_found",
      message:
        names.length === 0
          ? `The published steering version declares no agents, so it has none named ${name}. Add an agent file and publish it.`
          : `The published steering version declares no agent named ${name}. Its agents are ${nameList(names)}.`,
    });
  }
  const [only, ...others] = published.agents;
  if (only === undefined) {
    throw new HandlerError({
      code: "conflict",
      reason: "no_agents",
      message: `The published steering version declares no agents, so no policy can decide ${tool}. Add an agent file and publish it.`,
    });
  }
  if (others.length > 0) {
    throw new HandlerError({
      code: "conflict",
      reason: "agent_required",
      message: `The workspace declares ${names.length} agents, and policies can allow each one different calls. Name the agent to decide ${tool} for: ${nameList(names)}.`,
    });
  }
  return only;
}

/**
 * The published policies, compiled over the published tools with the draft's
 * tools laid over the published tools of the same server.
 */
function compileTry(
  published: PublishedSteering,
  server: ManifestServer,
  runtime: CedarRuntime,
  tool: string,
  log: TryStudioToolDeps["log"],
): CompiledPolicySet {
  const twin = published.servers.find((entry) => entry.name === server.name);
  const merged: ManifestServer = twin === undefined ? server : { ...twin, tools: { ...twin.tools, ...server.tools } };
  const servers = [...published.servers.filter((entry) => entry.name !== server.name), merged];
  const tools = cedarTools({ servers });
  if (tools.skipped.length > 0) {
    log.warn(
      { server: server.name, version: published.version, skipped: tools.skipped },
      "Cedar cannot read some tools or arguments. A skipped tool is denied.",
    );
  }
  const result = compilePolicies(
    { workspace: published.workspace, policies: published.policies, agents: published.agents, tools: tools.tools },
    runtime,
  );
  if (result.policy_set === undefined) {
    const problems = result.errors.slice(0, 3).map((problem) => sentenceOf(problem.message));
    throw new HandlerError({
      code: "conflict",
      reason: "policies_invalid",
      message: `The workspace's published policies do not compile with ${server.name}'s tools, so Oxagen cannot decide ${tool}. ${problems.join(" ")}`.trimEnd(),
    });
  }
  return result.policy_set;
}

function denied(message: string): ToolStudioTryOutput {
  return { ok: false, reason: "denied", message };
}

function failed(message: string, parts: { request?: string; raw?: string } = {}): ToolStudioTryOutput {
  return { ok: false, reason: "failed", message, ...parts };
}

function denial(agent: string, tool: string, verdict: ToolCallVerdict): string {
  if (verdict.reasons.length === 0) {
    return `No policy lets ${agent} call ${tool}, so Oxagen denied the call. Ask a workspace admin to permit it in a steering PR if this agent needs it.`;
  }
  return `The policy ${verdict.reasons.join(", ")} denied ${tool} for ${agent}. Ask a workspace admin to change it in a steering PR if this call is needed.`;
}

interface Decided {
  ctx: CapabilityContext;
  scope: ToolsPullRequestScope;
  userId: string | null;
  input: ToolStudioTryInput;
  tried: TriedTool;
  environment: ChosenEnvironment;
  agent: AgentDeclaration;
  runtime: CedarRuntime;
  policy: CompiledPolicySet;
}

/** The checks a served call runs, in the served order: off switches, kill switches, then the policy. */
async function refusal(deps: TryStudioToolDeps, call: Decided): Promise<ToolStudioTryOutput | null> {
  const { server, tool } = call.tried;
  let off: Awaited<ReturnType<TryStudioToolDeps["off"]>>;
  try {
    off = await deps.off(call.scope);
  } catch (error) {
    deps.log.warn({ tool: tool.name, error: errorName(error) }, "Oxagen could not read the off switches, so the call was not sent.");
    return failed(`Oxagen could not check whether ${tool.name} is switched off, so it did not send the call. Try it again in a minute.`);
  }
  if (off.servers.has(server.name)) {
    return denied(`${server.name} is switched off in Oxagen, so ${tool.name} was not sent. Ask a workspace admin to switch it on.`);
  }
  if (off.tools.has(tool.name)) {
    return denied(`${tool.name} is switched off in Oxagen, so it was not sent. Ask a workspace admin to switch it on.`);
  }

  // The connection a switch can name: the environment's credential, and only
  // in service mode. An operator-oauth reference names an OAuth client, and
  // the call runs on the person's own token.
  const credential = server.auth?.mode === "service" ? (call.environment.entry.credential ?? null) : null;
  let stop: TryEmergencyStop | null;
  try {
    stop = await deps.emergencyDeny(call.ctx, {
      server: server.name,
      tool: tool.name,
      credential,
      readOnly: tool.classification.side_effect === "read",
    });
  } catch (error) {
    deps.log.warn({ tool: tool.name, error: errorName(error) }, "Oxagen could not read the kill switches, so the call was not sent.");
    return failed(`Oxagen could not check the kill switches for ${tool.name}, so it did not send the call. Try it again in a minute.`);
  }
  if (stop !== null) {
    return denied(
      `Kill switch ${stop.id} on ${stop.targetKind.replaceAll("_", " ")} ${stop.targetId} stops ${tool.name}, so Oxagen did not send it. Reason: ${sentenceOf(stop.reason)} Ask an admin to turn the switch off if the call must run.`,
    );
  }

  let role: string | undefined;
  if (call.userId !== null) {
    try {
      role = await deps.operatorRole(call.scope, call.userId);
    } catch (error) {
      deps.log.warn({ tool: tool.name, error: errorName(error) }, "Oxagen could not read the person's workspace role, so the call was not sent.");
      return failed(`Oxagen could not read your workspace role, which a policy may check, so it did not send ${tool.name}. Try it again in a minute.`);
    }
  }

  const verdict = decideToolCall({
    runtime: call.runtime,
    policy: call.policy,
    agent: call.agent.name,
    action: tool.name,
    args: call.input.arguments,
    version: tool.version,
    now: deps.now?.() ?? Date.now(),
    tier: "gateway",
    ...(role === undefined ? {} : { operator_role: role }),
  });
  if (verdict.errors.length > 0) {
    return denied(
      `Oxagen could not decide ${tool.name}: ${verdict.errors.join(" ")} Check the arguments against the tool's input schema, then try it again.`,
    );
  }
  if (verdict.decision === "require_approval") {
    const rule = verdict.reasons.length === 0 ? "A policy" : `The policy ${verdict.reasons.join(", ")}`;
    return denied(
      `${rule} asks a person to approve ${tool.name} for ${call.agent.name}. Try it opens no approvals, so Oxagen did not send the call.`,
    );
  }
  if (verdict.decision !== "allow") return denied(denial(call.agent.name, tool.name, verdict));
  return null;
}

/** Read the credential, send the call, and shape the answer. */
async function send(deps: TryStudioToolDeps, call: Decided): Promise<ToolStudioTryOutput> {
  const { server, tool } = call.tried;
  const timeoutMs = deps.timeoutMs ?? TRY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const tooSlow = `${tool.name} did not answer within ${Math.round(timeoutMs / 1000)} seconds, so Oxagen stopped the call.`;
  const operator = call.userId ?? undefined;
  try {
    // The credential is read first, so its failure is reported as one, and
    // the executor gets the credential already read.
    let read: ResolvedCredential | null = null;
    let credentials: CredentialSource = { resolve: () => Promise.reject(new Error("The server has no sign-in.")) };
    if (server.auth !== null) {
      try {
        read = await deps.credentialSource(call.scope).resolve(
          {
            server: server.name,
            environment: call.environment.name,
            reference: call.environment.entry.credential,
            auth: server.auth,
            operator,
          },
          controller.signal,
        );
      } catch (error) {
        // Only the error's name: a credential lookup's message can quote the secret it read.
        deps.log.warn({ tool: tool.name, error: errorName(error) }, "The credential lookup failed, so the call was not sent.");
        if (controller.signal.aborted) return failed(tooSlow);
        return failed(
          `Oxagen could not read the credential for ${server.name}, so it did not send ${tool.name}. Try it again in a minute, and ask a workspace admin to reconnect ${server.label} if it fails again.`,
        );
      }
      if (read.type === "missing") return failed(`${read.message}\n${read.connect_url}`);
      const resolved = read;
      credentials = { resolve: () => Promise.resolve(resolved) };
    }

    let result: CallToolResult;
    let exchanges: RecordedExchange[];
    try {
      ({ result, exchanges } = await executeCall(
        tool,
        call.input.arguments,
        { server, name: call.environment.name, operator },
        credentials,
        deps.transport(),
        { signal: controller.signal, ...(deps.now === undefined ? {} : { now: deps.now }) },
      ));
    } catch (error) {
      deps.log.warn({ tool: tool.name, error: errorName(error) }, "Try it could not run the call.");
      if (controller.signal.aborted) return failed(tooSlow);
      return failed(`Oxagen could not send ${tool.name} to ${server.name}'s ${call.environment.name} environment. Try it again in a minute.`);
    }

    const scrub = scrubber(secretsOf(read));
    const shown = (exchange: RecordedExchange | undefined) => {
      if (exchange === undefined) {
        return { request: capText("", TRY_REQUEST_MAX), raw: capText("", TRY_RESULT_MAX) };
      }
      const clean = redactExchange(exchange, server.auth);
      return {
        request: capText(scrub(JSON.stringify(clean.request, null, 2)), TRY_REQUEST_MAX),
        raw: capText(scrub(JSON.stringify(clean.response, null, 2)), TRY_RESULT_MAX),
      };
    };

    if (controller.signal.aborted || result.isError === true) {
      const last = shown(exchanges.at(-1));
      const parts = exchanges.length === 0 ? {} : { request: last.request.text, raw: last.raw.text };
      if (controller.signal.aborted) return failed(tooSlow, parts);
      const text = capText(scrub(shapedText(result)).trim(), FAILURE_TEXT_MAX).text;
      return failed(text.length > 0 ? text : `${server.name} refused ${tool.name}.`, parts);
    }

    const first = shown(exchanges[0]);
    const shaped = capText(scrub(shapedText(result)), TRY_RESULT_MAX);
    const cut: ("request" | "raw" | "shaped")[] = [];
    if (first.request.cut) cut.push("request");
    if (first.raw.cut) cut.push("raw");
    if (shaped.cut) cut.push("shaped");
    return {
      ok: true,
      server: server.name,
      tool: tool.name,
      environment: call.environment.name,
      agent: call.agent.name,
      request: first.request.text,
      raw: first.raw.text,
      shaped: shaped.text,
      exchanges: exchanges.length,
      cut,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createTryStudioToolHandler(deps: TryStudioToolDeps): CapabilityHandler<typeof toolStudioTry> {
  return async (input, ctx): Promise<ToolStudioTryOutput> => {
    const userId = await deps.authorize(toolStudioTry, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { folder, repo } = await buildStudioFolderView(deps, scope, input.server);
    const tried = triedTool(folder, input.tool, deps.log);
    const environment = chosenEnvironment(tried.server, input.environment);

    const published = await deps.published(scope, repo);
    if (published === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "no_published_policies",
        message: `The workspace has published no steering version, so no policy can decide ${tried.tool.name}. Merge a steering PR with an agent file and the workspace's policies, then try the tool.`,
      });
    }
    assertPublishedBinding(tried.server, environment.name, published);
    const agent = chosenAgent(published, input.agent, tried.tool.name);
    const runtime = await deps.cedar();
    if (runtime === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "policy_evaluator_unavailable",
        message: `Oxagen could not load its policy evaluator, so it cannot decide ${tried.tool.name}. Try it again in a few minutes.`,
      });
    }
    const policy = compileTry(published, tried.server, runtime, tried.tool.name, deps.log);

    const call: Decided = { ctx, scope, userId, input, tried, environment, agent, runtime, policy };
    const refused = await refusal(deps, call);
    if (refused !== null) return refused;
    // The executor's schema check, after the decision, so a policy denial is
    // reported as one.
    const badArguments = inputRefusal(tried.tool.definition.inputSchema, input.arguments);
    if (badArguments !== null) return failed(badArguments);
    return send(deps, call);
  };
}
