// call.ts: a served tools/call (lane M15; mcp-studio-spec, Call path, and
// steering spec, Finding tools).
//
// A call to an imported tool is decided by S12's Cedar evaluator on the real
// tool, parked for a person's approval when a rule asks for one, and run by
// M6's executor on the server's sandbox environment. A search-mode server's
// search, describe, and call answer here too, and call is decided as the
// tool it names. Every one of them is a governed action, so each is metered
// whether it was allowed, denied, parked, or failed.
import { effectiveAnnotations, execute, type CallToolResult, type ManifestServer, type Transport } from "@oxagen/mcp-studio";
import { decideToolCall, type ToolCallVerdict } from "@oxagen/policy";
import { findInServer, resolveName } from "./names";
import { keywordRank, searchArguments, searchEntry, searchLines, type Ranker, type SearchEntry } from "./search";
import { unserved, visibleTools, type ServedTool, type ServedView } from "./snapshot";
import {
  ServedRouteError,
  type ApprovalState,
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

function refusal(message: string, outcome: MeterOutcome): Answer {
  return { result: { content: [{ type: "text", text: message }], isError: true }, outcome };
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
    await ports.meter({ kind, tool, server, outcome, agent: view.agent?.name ?? null, run: view.run, at: new Date(clock(ports)) });
  } catch (error) {
    ports.log.warn("Oxagen could not record a governed action. The call's result stands.", {
      kind,
      tool,
      outcome,
      error: errorName(error),
    });
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
  if (verdict.decision === "require_approval" && verdict.errors.length === 0) {
    let approval: ApprovalState;
    try {
      approval = await ports.approvals.settle({
        run: view.run,
        agent,
        tool: tool.name,
        server: server.name,
        args,
        reasons: verdict.reasons,
        risk: tool.classification.risk,
      });
    } catch (error) {
      ports.log.warn("Oxagen could not open an approval, so the call was not sent.", {
        tool: tool.name,
        error: errorName(error),
      });
      return refusal(`Oxagen could not open an approval for ${tool.name}, so it was not sent. Call it again in a minute.`, "failed");
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
    verdict = decide({ granted: true, approvers: 1 });
  }
  if (verdict.errors.length > 0) {
    return refusal(
      `Oxagen could not decide ${tool.name}: ${verdict.errors.join(" ")} Check the arguments against the tool's input schema, then call it again.`,
      "denied",
    );
  }
  if (verdict.decision !== "allow") return refusal(denial(agent, tool.name, verdict), "denied");

  const environment = sandboxOf(server);
  if (environment === null) {
    return refusal(
      `${server.name} has no sandbox environment, so Oxagen cannot send ${tool.name}. Ask a workspace admin to mark one environment as the sandbox.`,
      "failed",
    );
  }
  const transport = transportFor(ports, { network: environment.network, server, run: view.run });
  if (transport instanceof ServedRouteError) return refusal(transport.message, "failed");

  try {
    const result = await execute(
      tool,
      args,
      { server, name: environment.name, operator: agent.operator },
      ports.credentials,
      transport,
      { senders: ports.senders, signal: ports.signal, now: ports.now },
    );
    return { result, outcome: result.isError === true ? "failed" : "allowed" };
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
    ports.log.warn("The search index failed, so search ranked by keyword.", {
      server: server.name,
      error: errorName(error),
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
 */
export async function callServed(
  view: ServedView,
  ports: ServedPorts,
  name: string,
  args: Record<string, unknown>,
  rank: Ranker = keywordRank,
): Promise<CallToolResult | null> {
  const resolved = resolveName(view, name);
  if (resolved === null) return null;

  if (resolved.kind === "tool") {
    const { entry } = resolved;
    const answer = await governed(view, ports, entry, args);
    await meter(view, ports, "call", entry.tool.name, entry.server.name, answer.outcome);
    return answer.result;
  }

  const { server } = resolved;
  if (resolved.kind === "search") {
    const answer = await search(view, ports, server, args, rank);
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
  const name = toolArgument(args);
  const entry = name === null ? null : findInServer(view, server, name);
  if (entry === null || !isRecord(inner)) {
    let message = `arguments is an object of the tool's input. Call ${server.name}__describe for its schema.`;
    if (name === null) message = "call needs a tool. Pass the tool's name in tool.";
    else if (entry === null) message = `${server.name} serves no tool named ${name}. Call ${server.name}__search to find one.`;
    const answer = refusal(message, "failed");
    await meter(view, ports, "call", entry?.tool.name ?? `${server.name}__call`, server.name, answer.outcome);
    return answer.result;
  }
  const answer = await governed(view, ports, entry, inner);
  await meter(view, ports, "call", entry.tool.name, server.name, answer.outcome);
  return answer.result;
}
