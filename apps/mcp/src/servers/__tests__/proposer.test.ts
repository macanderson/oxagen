// proposer.test.ts: the agent behind a propose_steering call, from the run
// the gateway key and session header name and the published agents/ files
// (#5134).
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { describe, expect, it } from "vitest";
import { proposingAgentOf, type ProposerSources } from "../proposer";
import type { SteeringConnectionRead } from "../published";
import type { ServedHost, ServedSession } from "../run";

const SESSION = "0b8f5c1e-7d2a-4f3b-9c6e-1a2b3c4d5e6f";

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    orgId: "org_1",
    workspaceId: "ws_1",
    userId: null,
    apiKeyId: "key_1",
    requestId: "req_1",
    surface: "mcp",
    messageId: null,
    gatewaySessionUuid: SESSION,
    ...overrides,
  };
}

const HOST: ServedHost = {
  id: "host_1",
  publicId: "tch_1",
  runtime: "ci-linux-01",
  operator: "5a8e2c41-9b7d-4f16-8c3e-0d2f6a1b7e94",
  operatorRole: "member",
};

const CONNECTION: SteeringConnectionRead = {
  provider: "github",
  source: "binding",
  owner: "a-intel",
  repo: "oxagen-core-platform",
};

const REVIEWER = { name: "a-intel.core.ci-reviewer", operator: "platform-team", runtime: "ci-linux-01", harness: "codex" };
const RELEASE = { name: "a-intel.core.release-bot", operator: "platform-team", runtime: "ci-linux-01", harness: "claude-code" };
const OTHER = { name: "a-intel.core.other", operator: "platform-team", runtime: "mac-02", harness: "codex" };

/** A published workspace version with these agents. Only the fields the resolver reads are real. */
// `null` is an organization repository's version, which has no workspace slug. A default
// parameter cannot stand for it: passing `undefined` would apply the default.
function bundle(agents: object[], workspace: string | null = "core-platform"): Bundle {
  return { workspace: workspace ?? undefined, agents } as unknown as Bundle;
}

interface Options {
  host?: ServedHost | null;
  session?: ServedSession | null;
  connection?: SteeringConnectionRead | null;
  current?: Bundle | null;
}

function sources(options: Options = {}) {
  const asked: { repositories: string[] } = { repositories: [] };
  const read: ProposerSources = {
    run: {
      host: () => Promise.resolve(options.host === undefined ? HOST : options.host),
      session: () =>
        Promise.resolve(options.session === undefined ? { publicId: "tse_1", harness: "codex" } : options.session),
    },
    published: {
      connection: () => Promise.resolve(options.connection === undefined ? CONNECTION : options.connection),
      current: (_scope, repository) => {
        asked.repositories.push(repository);
        return Promise.resolve(options.current === undefined ? bundle([REVIEWER, OTHER]) : options.current);
      },
    },
  };
  return { read, asked };
}

describe("proposingAgentOf", () => {
  it("names the one agent on the run's runtime, and the run the session names", async () => {
    const { read, asked } = sources();
    expect(await proposingAgentOf(context(), read)).toEqual({ agent: "a-intel.core.ci-reviewer", run: "tse_1" });
    expect(asked.repositories).toEqual(["github.com/a-intel/oxagen-core-platform"]);
  });

  it("lets the session's harness pick between agents that share the runtime", async () => {
    const { read } = sources({
      session: { publicId: "tse_2", harness: "claude-code" },
      current: bundle([REVIEWER, RELEASE]),
    });
    expect(await proposingAgentOf(context(), read)).toEqual({ agent: "a-intel.core.release-bot", run: "tse_2" });
  });

  it("names the agent with no run when the request names no session on the key's machine", async () => {
    const { read } = sources({ session: null });
    expect(await proposingAgentOf(context(), read)).toEqual({ agent: "a-intel.core.ci-reviewer", run: null });
  });

  it("names no agent when agents share the runtime and the request names no session", async () => {
    const { read } = sources({ session: null, current: bundle([REVIEWER, RELEASE]) });
    expect(await proposingAgentOf(context(), read)).toBeNull();
  });

  it("names no agent without a gateway key's machine", async () => {
    expect(await proposingAgentOf(context({ apiKeyId: null }), sources().read)).toBeNull();
    expect(await proposingAgentOf(context(), sources({ host: null }).read)).toBeNull();
    expect(await proposingAgentOf(context(), sources({ host: { ...HOST, runtime: null } }).read)).toBeNull();
  });

  it("names no agent when the workspace connected no steering repo or published nothing", async () => {
    expect(await proposingAgentOf(context(), sources({ connection: null }).read)).toBeNull();
    expect(await proposingAgentOf(context(), sources({ current: null }).read)).toBeNull();
  });

  it("names no agent from an organization repository's version", async () => {
    const { read } = sources({ current: bundle([REVIEWER], null) });
    expect(await proposingAgentOf(context(), read)).toBeNull();
  });

  it("names no agent when no agent file is on the run's runtime", async () => {
    const { read } = sources({ current: bundle([OTHER]) });
    expect(await proposingAgentOf(context(), read)).toBeNull();
  });
});
