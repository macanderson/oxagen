// agent-file.test.ts: the agent file enrollment proposes (#5149, ADR-265) is
// the one the gateway matches the enrolled host's runs to. The file's text
// goes through the bundle's agent/v1 read, the published tools the served
// tools read, and the run the host's gateway key resolves to, and
// matchAgent picks it.
import { agentHarnessSchema } from "@oxagen/oxagen/contracts/agent.list";
import {
  agentFileText,
  agentNameForRuntime,
  agentSchema,
} from "@oxagen/oxagen/steering-repo/agent";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { describe, expect, it } from "vitest";
import { publishedTools } from "../published";
import { resolveServedRun, type ServedHost } from "../run";
import { matchAgent } from "../snapshot";

/** The runtime an enrollment bound: its slug, as the gateway key's host names it. */
const RUNTIME = "mcp-live-1";
const OPERATOR = "usr_01k5qk7d0000000000000000";

/** The file enrollment writes for the runtime, as agent-file.ts renders it. */
function enrolledAgentFile(runtime: string, harness = "claude-code"): string {
  const name = agentNameForRuntime(runtime);
  if (name === null) throw new Error(`${runtime} is not an agent name`);
  return agentFileText({
    schema: "agent/v1",
    name,
    label: `Claude Code on ${runtime}`,
    operator: OPERATOR,
    runtime,
    harness: agentHarnessSchema.parse(harness),
  });
}

/** A published version holding these agent files, read as buildBundle reads agents/. */
function published(texts: readonly string[]) {
  const agents = texts.map((text) => {
    const read = readTomlFile(text, "agent/v1", agentSchema);
    if (!read.ok) throw new Error(`the agent file does not read: ${JSON.stringify(read.issues)}`);
    return read.value;
  });
  const bundle = {
    repository: "github.com/ox-live/mcp-live-1-steering",
    workspace: "mcp-live-1",
    version: 6,
    tools: null,
    policies: null,
    agents,
  } as unknown as Bundle;
  const tools = publishedTools(bundle);
  if (tools === null) throw new Error("a workspace's version serves tools");
  return tools;
}

/** The run a request with the enrolled host's gateway key and no session header resolves to. */
async function hostRun(runtime: string) {
  const host: ServedHost = {
    id: "host_1",
    publicId: "tch_01k5qk7d0000000000000000",
    runtime,
    operator: "5a8e2c41-9b7d-4f16-8c3e-0d2f6a1b7e94",
    operatorRole: "owner",
  };
  const ctx: CapabilityContext = {
    orgId: "org_1",
    workspaceId: "ws_1",
    userId: null,
    apiKeyId: "key_gateway",
    requestId: "req_1",
    surface: "mcp",
    messageId: null,
  };
  const run = await resolveServedRun(ctx, {
    host: () => Promise.resolve(host),
    session: () => Promise.resolve(null),
  });
  if (run === null) throw new Error("the gateway key belongs to no run");
  return run;
}

describe("the agent file enrollment proposes", () => {
  it("matches the enrolled host's run, with no session header", async () => {
    const tools = published([enrolledAgentFile(RUNTIME)]);
    const run = await hostRun(RUNTIME);

    const agent = matchAgent(tools.agents, run.runtime, run.harness);

    expect(agent).toEqual({
      name: RUNTIME,
      operator: OPERATOR,
      runtime: RUNTIME,
      harness: "claude-code",
    });
  });

  it("matches beside agent files on other runtimes", async () => {
    const tools = published([
      enrolledAgentFile("ci-linux-01", "codex"),
      enrolledAgentFile(RUNTIME),
    ]);
    const run = await hostRun(RUNTIME);
    expect(matchAgent(tools.agents, run.runtime, run.harness)?.name).toBe(RUNTIME);
  });

  it("matches no run on another runtime (negative)", async () => {
    const tools = published([enrolledAgentFile(RUNTIME)]);
    const run = await hostRun("laptop-9");
    expect(matchAgent(tools.agents, run.runtime, run.harness)).toBeNull();
  });
});
