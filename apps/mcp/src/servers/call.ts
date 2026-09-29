// call.ts: a served tools/call (lane M15; mcp-studio-spec, Call path, and
// steering spec, Finding tools).
//
// A call to an imported tool is decided by S12's Cedar evaluator on the real
// tool, parked for a person's approval when a rule asks for one, and run by
// M6's executor on the server's sandbox environment. A search-mode server's
// search, describe, and call answer here too, and call is decided as the
// tool it names. Every one of them is a governed action. Billing admits
// each one before anything else runs, and each is metered whether it was
// allowed, denied, parked, or failed.
import {
  SearchIndexError,
  effectiveAnnotations,
  execute,
  type CallToolResult,
  type CredentialSource,
  type ManifestServer,
  type ResolvedCredential,
  type Transport,
} from "@oxagen/mcp-studio";
import { decideToolCall, type ToolCallVerdict } from "@oxagen/policy";
import { findInServer, resolveName } from "./names";
import { keywordRank, searchArguments, searchEntry, searchLines, type Ranker, type SearchEntry } from "./search";
import { unserved, visibleTools, type ServedTool, type ServedView } from "./snapshot";
import {
  ServedRouteError,
  type Admission,
  type ApprovalRequest,
  type ApprovalState,
  type EmergencyDeny,
  type MeterKind,
  type MeterOutcome,
  type ServedAgent,
  type ServedPorts,
  type ServedRoute,
} from "./types";

interface Answer {
  result: CallToolResult;
  outcome: MeterOutcome;
}

function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function refusal(message: string, outcome: MeterOutcome): Answer {
  return { result: failure(message), outcome };
}

function clock(ports: ServedPorts): number {
  return ports.now?.() ?? Date.now();
}

/** An error's name for a log line. A message can quote a row, a request, or a secret, so it is never logged. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

async function meter(
  view: ServedView,
  ports: ServedPorts,
  kind: MeterKind,
  tool: string,
  server: string,
  outcome: MeterOutcome,
): Promise<void> {
  try {
    await ports.meter({
      id: ports.newId?.() ?? crypto.randomUUID(),
      kind,
      tool,
      server,
      outcome,
      agent: view.agent?.name ?? null,
      run: view.run,
      at: new Date(clock(ports)),
    });
  } catch (error) {
    ports.log.warn("Oxagen could not record a governed action. The call's result stands.", {
      kind,
      tool,
      outcome,
      error: errorName(error),
    });
  }
}

/**
 * Billing's refusal of a governed action, or null when billing admits it.
 * It runs first, as the kernel runs assertGauAvailable, so nobody is asked
 * to approve a call that billing then refuses. A refused action is not
 * metered. When billing cannot be read, nothing is sent.
 */
async function unadmitted(view: ServedView, ports: ServedPorts, name: string): Promise<CallToolResult | null> {
  let admission: Admission;
  try {
    admission = await ports.admit(view.run);
  } catch (error) {
    ports.log.warn("Oxagen could not read the organization's billing, so the call was not sent.", {
      tool: name,
      error: errorName(error),
    });
    return failure(`Oxagen could not check billing for ${name}, so it was not sent. Call it again in a minute.`);
  }
  if (admission.admitted) return null;
  switch (admission.reason) {
    case "units_exhausted":
      return failure(
        `The organization has no governed actions left this period, so Oxagen did not send ${name}. Ask an organization admin to add units in Billing.`,
      );
    case "no_payment_method":
      return failure(
        `The organization used this month's free governed actions, so Oxagen did not send ${name}. Ask an organization admin to add a payment method in Billing.`,
      );
    case "suspended":
      return failure(
        `Billing is suspended for the organization, so Oxagen did not send ${name}. Ask an organization admin to pay the open invoice in Billing.`,
      );
  }
}

/** The environment every agent's calls to a server go to: its sandbox, or its only environment. */
export function sandboxOf(server: ManifestServer): { name: string; network: string } | null {
  const entries = Object.entries(server.environments).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sandbox = entries.find(([, environment]) => environment.sandbox) ?? (entries.length === 1 ? entries[0] : undefined);
  return sandbox === undefined ? null : { name: sandbox[0], network: sandbox[1].network };
}

/**
 * The refusal for a network Oxagen cannot carry a call on yet. A relay
 * waits for lane M12, so nothing is sent over one.
 */
export function unbuiltRoute(network: string): ServedRouteError | null {
  if (!network.startsWith("relay:")) return null;
  return new ServedRouteError(
    "relay_not_built",
    `Oxagen cannot send calls over ${network} yet, so it sent nothing. Ask a workspace admin to give the server a cloud or local sandbox environment.`,
  );
}

function transportFor(ports: ServedPorts, route: ServedRoute): Transport | ServedRouteError {
  const unbuilt = unbuiltRoute(route.network);
  if (unbuilt !== null) return unbuilt;
  try {
    return ports.transport(route);
  } catch (error) {
    if (error instanceof ServedRouteError) return error;
    throw error;
  }
}

function denial(agent: ServedAgent, tool: string, verdict: ToolCallVerdict): string {
  if (verdict.reasons.length === 0) {
    return `No policy lets ${agent.name} call ${tool}, so Oxagen denied the call. Ask a workspace admin to permit it in a steering PR if this agent needs it.`;
  }
  return `The policy ${verdict.reasons.join(", ")} denied ${tool} for ${agent.name}. Ask a workspace admin to change it in a steering PR if this call is needed.`;
}

/** The refusal for a tool that is not served, or null when it is. */
function unservedRefusal(view: ServedView, entry: ServedTool, agent: ServedAgent): Answer | null {
  const { server, tool } = entry;
  switch (unserved(view, entry)) {
    case "server_off":
      return refusal(`${server.name} is switched off in Oxagen, so ${tool.name} was not sent. Ask a workspace admin to switch it on.`, "denied");
    case "tool_off":
      return refusal(`${tool.name} is switched off in Oxagen, so it was not sent. Ask a workspace admin to switch it on.`, "denied");
    case "withheld":
      return refusal(`Oxagen withholds ${tool.name} from every agent, so it was not sent.`, "denied");
    case "hidden":
      return refusal(
        `The workspace's policies do not let ${agent.name} call ${tool.name}, so Oxagen denied the call. Ask a workspace admin to permit it in a steering PR if this agent needs it.`,
        "denied",
      );
    case null:
      return null;
  }
}

/** Text as one sentence that ends in a single period, whether or not it had one. */
function sentenceOf(text: string): string {
  let end = text.trimEnd();
  while (end.endsWith(".")) end = end.slice(0, -1).trimEnd();
  return `${end}.`;
}

/** A switch's target kind in words: tool_server reads "tool server". */
function targetWords(deny: EmergencyDeny): string {
  return deny.targetKind.replaceAll("_", " ");
}

/**
 * The refusal for a call a kill switch stops, or null when none does. A
 * failed read stops the call too, since Oxagen cannot tell that no switch
 * is on.
 */
async function emergencyRefusal(
  ports: ServedPorts,
  entry: ServedTool,
  environment: { name: string } | null,
): Promise<Answer | null> {
  const { server, tool } = entry;
  // The reference executeCall resolves: the sandbox environment's, when the
  // server takes a credential at all.
  const credential =
    environment === null || server.auth === null ? null : (server.environments[environment.name]?.credential ?? null);
  let deny: EmergencyDeny | null;
  try {
    deny = await ports.emergencyDeny({
      server: server.name,
      tool: tool.name,
      credential,
      readOnly: tool.classification.side_effect === "read",
    });
  } catch (error) {
    ports.log.warn("Oxagen could not read the kill switches, so the call was not sent.", {
      tool: tool.name,
      error: errorName(error),
    });
    return refusal(
      `Oxagen could not check the kill switches for ${tool.name}, so it did not send the call. Call it again in a minute.`,
      "failed",
    );
  }
  if (deny === null) return null;
  return refusal(
    `Kill switch ${deny.id} on ${targetWords(deny)} ${deny.targetId} stops ${tool.name}, so Oxagen did not send it. Reason: ${sentenceOf(deny.reason)} Ask an admin to turn the switch off if the call must run.`,
    "denied",
  );
}

/** The refusal for an approval Oxagen could not read or open. Logs only the error's name. */
function approvalFailed(ports: ServedPorts, tool: string, error: unknown): Answer {
  ports.log.warn("Oxagen could not open an approval, so the call was not sent.", { tool, error: errorName(error) });
  return refusal(`Oxagen could not open an approval for ${tool}, so it was not sent. Call it again in a minute.`, "failed");
}

/**
 * How many people approved a call so far, as a sentence. An approval an
 * auto-approval rule resolved names no person, so it counts none.
 */
function peopleApproved(approvers: number): string {
  if (approvers === 0) return "No person has approved it yet.";
  return approvers === 1 ? "One person has approved it so far." : `${approvers} people have approved it so far.`;
}

/** Decide one call to an imported tool, park it or run it, and say how it ended. */
async function runTool(view: ServedView, ports: ServedPorts, entry: ServedTool, args: Record<string, unknown>): Promise<Answer> {
  const { server, tool } = entry;
  const agent = view.agent;
  if (agent === null) {
    return refusal(
      `Oxagen matched no agent to this run, so it serves no tool and did not send ${tool.name}. Add an agent file for runtime ${view.run.runtime} to the steering record and publish it.`,
      "denied",
    );
  }
  // With no decider nothing is visible, so this comes before the visibility
  // test to say why.
  const decider = view.decider;
  if (decider === null) {
    return refusal(
      `Oxagen could not load the workspace's policies, so it denied ${tool.name}. If a steering PR changed the policies, fix them and publish again. Otherwise call the tool again in a minute.`,
      "denied",
    );
  }
  const refused = unservedRefusal(view, entry, agent);
  if (refused !== null) return refused;

  // The kill switches come before the policy, so a stopped call opens no
  // approval, reads no credential, and sends nothing.
  const environment = sandboxOf(server);
  const stopped = await emergencyRefusal(ports, entry, environment);
  if (stopped !== null) return stopped;

  // Five live facts a rule can name have no source on the served path yet,
  // so both decisions leave them out (#4666):
  // - rate: the governed action ledger records no outcome, so a count read
  //   from it would include denied and parked retries.
  // - taint: nothing on the served path marks a run's data as tainted.
  // - run: nothing records which served calls a run has made or read.
  // - budget_remaining_cents: nothing records what a served agent has spent.
  //   A spend budget caps model spend in micros, which is not this fact.
  // - mandate_remaining_cents: no mandate reaches a served call.
  // A rule on one of them reads the policy's default: an untainted run, no
  // calls in the last hour or minute, no prior calls, the budget the agent
  // file declares or none, and no mandate.
  const decide = (approval?: { granted: boolean; approvers: number }): ToolCallVerdict =>
    decideToolCall({
      runtime: decider.runtime,
      policy: decider.policy,
      agent: agent.name,
      action: tool.name,
      args,
      version: tool.version,
      now: clock(ports),
      tier: "gateway",
      ...(view.run.operatorRole === undefined ? {} : { operator_role: view.run.operatorRole }),
      ...(approval === undefined ? {} : { approval }),
    });

  let verdict = decide();
  // The approvals the call is sent on. Claimed after every other check and
  // after the credential is read, so a call that fails any of them leaves the
  // approvals for the retry.
  let approved: { request: ApprovalRequest; id: string; approvers: number } | null = null;
  if (verdict.decision === "require_approval" && verdict.errors.length === 0) {
    const request: ApprovalRequest = {
      run: view.run,
      agent,
      tool: tool.name,
      version: tool.version,
      publication:
        view.published === null ? null : { repository: view.published.repository, version: view.published.version },
      server: server.name,
      args,
      reasons: verdict.reasons,
      risk: tool.classification.risk,
    };
    let approval: ApprovalState;
    try {
      approval = await ports.approvals.settle(request);
    } catch (error) {
      return approvalFailed(ports, tool.name, error);
    }
    if (approval.state === "pending") {
      return refusal(
        `${tool.name} waits for a person's approval under ${verdict.reasons.join(", ")}. Oxagen opened approval ${approval.id}. Call the tool again with the same arguments once it is approved.`,
        "parked",
      );
    }
    if (approval.state === "refused") {
      return refusal(`A person refused ${tool.name} under approval ${approval.id}, so it was not sent.`, "denied");
    }
    // The second decision reads how many distinct people approved, so a rule
    // that asks for two people parks the call again after one.
    verdict = decide({ granted: true, approvers: approval.approvers });
    if (verdict.decision === "require_approval" && verdict.errors.length === 0) {
      let another: { id: string };
      try {
        another = await ports.approvals.requestAnother({ ...request, reasons: verdict.reasons });
      } catch (error) {
        return approvalFailed(ports, tool.name, error);
      }
      return refusal(
        `${tool.name} needs approval from another person under ${verdict.reasons.join(", ")}. ${peopleApproved(approval.approvers)} Oxagen opened approval ${another.id}. Call the tool again with the same arguments once another person approves it.`,
        "parked",
      );
    }
    approved = { request, id: approval.id, approvers: approval.approvers };
  }
  if (verdict.errors.length > 0) {
    return refusal(
      `Oxagen could not decide ${tool.name}: ${verdict.errors.join(" ")} Check the arguments against the tool's input schema, then call it again.`,
      "denied",
    );
  }
  if (verdict.decision !== "allow") return refusal(denial(agent, tool.name, verdict), "denied");

  if (environment === null) {
    return refusal(
      `${server.name} has no sandbox environment, so Oxagen cannot send ${tool.name}. Ask a workspace admin to mark one environment as the sandbox.`,
      "failed",
    );
  }
  const transport = transportFor(ports, { network: environment.network, server, run: view.run });
  if (transport instanceof ServedRouteError) return refusal(transport.message, "failed");

  // The credential is read here, before the claim, so a failed lookup leaves
  // the approval unused. The executor then gets the credential already read.
  // The request is the one the executor would build.
  let credentials: CredentialSource = ports.credentials;
  if (server.auth !== null) {
    let credential: ResolvedCredential;
    try {
      credential = await ports.credentials.resolve(
        {
          server: server.name,
          environment: environment.name,
          reference: server.environments[environment.name]?.credential,
          auth: server.auth,
          // The run's operator, not the agent file's: an agent names a member
          // or a team by slug, and only a person holds an operator token.
          operator: view.run.operator,
        },
        ports.signal ?? new AbortController().signal,
      );
    } catch (error) {
      // Only the error's name: a credential lookup's message can quote the secret it read.
      ports.log.warn("The credential lookup failed, so the call was not sent.", {
        tool: tool.name,
        error: errorName(error),
      });
      return refusal(
        `Oxagen could not read the credential for ${server.name}, so it did not send ${tool.name}. Call it again in a minute, and ask a workspace admin to reconnect ${server.label} if it fails again.`,
        "failed",
      );
    }
    if (credential.type === "missing") return refusal(`${credential.message}\n${credential.connect_url}`, "failed");
    const read = credential;
    credentials = { resolve: () => Promise.resolve(read) };
  }

  if (approved !== null) {
    let claimed: boolean;
    try {
      claimed = await ports.approvals.claim(approved.request, approved.approvers);
    } catch (error) {
      ports.log.warn("Oxagen could not use the approval, so the call was not sent.", {
        tool: tool.name,
        error: errorName(error),
      });
      return refusal(`Oxagen could not use approval ${approved.id} for ${tool.name}, so it was not sent. Call it again in a minute.`, "failed");
    }
    if (!claimed) {
      return refusal(
        `Approval ${approved.id} no longer covers ${tool.name}, because another call used it or it expired. Oxagen did not send the call. Call the tool again with the same arguments to ask for a new approval.`,
        "failed",
      );
    }
  }

  const result = await execute(
    tool,
    args,
    { server, name: environment.name, operator: view.run.operator },
    credentials,
    transport,
    { senders: ports.senders, signal: ports.signal, now: ports.now },
  );
  return { result, outcome: result.isError === true ? "failed" : "allowed" };
}

function describeTool(entry: ServedTool): CallToolResult {
  const { definition } = entry.tool;
  const described: Record<string, unknown> = {
    name: definition.name,
    ...(definition.title === undefined ? {} : { title: definition.title }),
    description: definition.description ?? "",
    input_schema: definition.inputSchema,
    ...(definition.outputSchema === undefined ? {} : { output_schema: definition.outputSchema }),
    annotations: effectiveAnnotations(entry.tool.classification),
  };
  return { content: [{ type: "text", text: JSON.stringify(described, null, 2) }], structuredContent: described };
}

function servedIn(view: ServedView, server: ManifestServer, name: string): ServedTool | null {
  const entry = findInServer(view, server, name);
  return entry !== null && unserved(view, entry) === null ? entry : null;
}

/** The tool name a search-mode describe or call passes, or null when it passes none. */
function toolArgument(args: Record<string, unknown>): string | null {
  const name = args["tool"];
  return typeof name === "string" && name !== "" ? name : null;
}

async function search(view: ServedView, ports: ServedPorts, server: ManifestServer, args: Record<string, unknown>, rank: Ranker): Promise<Answer> {
  const parsed = searchArguments(args);
  if (!parsed.ok) return refusal(parsed.message, "failed");
  const entries = visibleTools(view)
    .filter((entry) => entry.server.name === server.name)
    .map((entry) => searchEntry(server, entry));
  let found: readonly SearchEntry[];
  try {
    found = await rank(parsed.query, entries, parsed.limit);
  } catch (error) {
    // A SearchIndexError's code says why (no_key, unreachable, timeout), and
    // carries no key, url, or response body.
    ports.log.warn("The search index failed, so search ranked by keyword.", {
      server: server.name,
      error: errorName(error),
      ...(error instanceof SearchIndexError ? { code: error.code } : {}),
    });
    found = await keywordRank(parsed.query, entries, parsed.limit);
  }
  if (found.length === 0) return { result: text(`No ${server.name} tool matches "${parsed.query}". Search again with other words.`), outcome: "allowed" };
  return { result: text(searchLines(found.slice(0, parsed.limit))), outcome: "allowed" };
}

function describe(view: ServedView, server: ManifestServer, args: Record<string, unknown>): Answer {
  const name = toolArgument(args);
  if (name === null) return refusal("describe needs a tool. Pass the tool's name in tool.", "failed");
  const entry = servedIn(view, server, name);
  if (entry === null) {
    return refusal(`${server.name} serves no tool named ${name}. Call ${server.name}__search to find one.`, "failed");
  }
  return { result: describeTool(entry), outcome: "allowed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * runTool, with any error it throws turned into a failed answer, so the
 * call is still answered and still metered.
 */
async function governed(view: ServedView, ports: ServedPorts, entry: ServedTool, args: Record<string, unknown>): Promise<Answer> {
  try {
    return await runTool(view, ports, entry, args);
  } catch (error) {
    ports.log.warn("A served call failed before it was sent.", { tool: entry.tool.name, error: errorName(error) });
    return refusal(`Oxagen could not send ${entry.tool.name} because of an internal error. Call it again in a minute.`, "failed");
  }
}

/**
 * Answer a tools/call for a published server's tool, or null when the name
 * names no published server, which leaves the call to Oxagen's own tools.
 * Search ranks with rank, then ports.rank, then by keyword.
 */
export async function callServed(
  view: ServedView,
  ports: ServedPorts,
  name: string,
  args: Record<string, unknown>,
  rank?: Ranker,
): Promise<CallToolResult | null> {
  const resolved = resolveName(view, name);
  if (resolved === null) return null;
  const refused = await unadmitted(view, ports, name);
  if (refused !== null) return refused;

  if (resolved.kind === "tool") {
    const { entry } = resolved;
    const answer = await governed(view, ports, entry, args);
    await meter(view, ports, "call", entry.tool.name, entry.server.name, answer.outcome);
    return answer.result;
  }

  const { server } = resolved;
  if (resolved.kind === "search") {
    const answer = await search(view, ports, server, args, rank ?? ports.rank ?? keywordRank);
    await meter(view, ports, "search", `${server.name}__search`, server.name, answer.outcome);
    return answer.result;
  }
  if (resolved.kind === "describe") {
    const answer = describe(view, server, args);
    await meter(view, ports, "describe", `${server.name}__describe`, server.name, answer.outcome);
    return answer.result;
  }

  // call: decided, parked, run, and metered as the tool it names.
  const inner = args["arguments"] ?? {};
  const toolName = toolArgument(args);
  const entry = toolName === null ? null : findInServer(view, server, toolName);
  if (entry === null || !isRecord(inner)) {
    let message = `arguments is an object of the tool's input. Call ${server.name}__describe for its schema.`;
    if (toolName === null) message = "call needs a tool. Pass the tool's name in tool.";
    else if (entry === null) message = `${server.name} serves no tool named ${toolName}. Call ${server.name}__search to find one.`;
    const answer = refusal(message, "failed");
    await meter(view, ports, "call", entry?.tool.name ?? `${server.name}__call`, server.name, answer.outcome);
    return answer.result;
  }
  const answer = await governed(view, ports, entry, inner);
  await meter(view, ports, "call", entry.tool.name, server.name, answer.outcome);
  return answer.result;
}
