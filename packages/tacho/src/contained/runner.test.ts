/**
 * The daemon side of `tacho run --contained` (ADR-152): what the runner
 * refuses before Docker is ever asked, what it hands the launcher, and what
 * it cleans up whether the run succeeds or throws. The launcher and the
 * bridge are replaced with doubles so the lifecycle can be driven step by
 * step without Docker or a socket; `launcher.docker.test.ts` covers the real
 * launcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRegistry } from "../collector/registry";
import type { HookEnvelope } from "../collector/server";
import type { ModelProxy } from "../collector/model-proxy";
import type { IssueRunTokenAnswer } from "../collector/credential-issuer";
import type { TachoEvent } from "../envelope";
import type { HostFile } from "../host/host-file";
import type { FetchLike } from "../host/control-client";
import {
  bundleSigner,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { ContainedBridgeOptions } from "./bridge";
import type { ContainedLauncherOptions } from "./launcher";
import type { ContainmentMeasurement } from "./profile";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  bridge: vi.fn(),
}));
vi.mock("./launcher", () => ({ launchContainedAgent: mocks.launch }));
vi.mock("./bridge", () => ({ startContainedBridge: mocks.bridge }));

const { containedLaunchEndpoint, createContainedRunner } = await import(
  "./runner"
);

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const TOKEN = `ghs_${"a".repeat(36)}`;
const SESSION_UUID = "0192f000-0000-7000-8000-000000000001";
const MEASUREMENT = {
  profile: "oxagen.contained.v1",
  containerId: "c0ffee",
  imageDigest: "sha256:abc",
  configurationDigest: "sha256:def",
  gatewayOnlyEgress: true,
  workspaceOnlyWrites: true,
  readOnlyHooks: true,
} as unknown as ContainmentMeasurement;

const REQUEST = {
  workspace: "/work/repo",
  harness: "claude-code",
  args: ["-p", "fix the test"],
  image: "oxagen/contained-claude:1",
};

function issued(token = "oxrt_run_token"): IssueRunTokenAnswer {
  return {
    status: 200,
    body: {
      token,
      token_id: "rt_1",
      provider: "anthropic",
      harness: "claude-code",
      placement: "static",
      expires_at: "2026-09-10T13:00:00.000Z",
    } as never,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * One fake network for GitHub and the Oxagen API. Each route answers with a
 * status; the calls are kept in order so a test can say what was never asked.
 */
function network(routes: {
  verify?: { status: number; body?: unknown };
  revoke?: number | Error;
  register?: number;
}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const reply = (status: number, body: unknown = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    });
    if (url.includes("/installation/repositories")) {
      const verify = routes.verify ?? {
        status: 200,
        body: {
          total_count: 1,
          repositories: [{ full_name: "acme/app" }],
        },
      };
      return reply(verify.status, verify.body);
    }
    if (url.endsWith("/installation/token")) {
      if (routes.revoke instanceof Error) throw routes.revoke;
      return reply(routes.revoke ?? 204);
    }
    if (url.endsWith("/tacho/contained-launch"))
      return reply(routes.register ?? 201);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetch };
}

/** The hook event a recorded envelope carried. */
function eventName(envelope: HookEnvelope): unknown {
  return (envelope.payload as Record<string, unknown>)["hook_event_name"];
}

function sealedEvent(
  kind: string,
  body: Record<string, unknown>,
  options?: unknown,
) {
  return { kind, body, options } as unknown as TachoEvent;
}

function runner(
  overrides: {
    host?: Partial<HostFile>;
    credential?: IssueRunTokenAnswer;
    fetch?: FetchLike;
    recorded?: boolean;
    genesis?: string | undefined;
  } = {},
) {
  const signer = bundleSigner();
  const host = testHostFile(
    signer,
    signer.sign(unsignedBundle()),
    overrides.host,
  );
  const hooks: HookEnvelope[] = [];
  const records: TachoEvent[][] = [];
  const log = vi.fn<(line: string) => void>();
  const credential = vi.fn(() => overrides.credential ?? issued());
  const seenLaunched: boolean[] = [];
  const recorder = {
    sessionUuid: SESSION_UUID,
    sealCollectorEvent: vi.fn(sealedEvent),
  };
  const registry = {
    get: vi.fn(() => (overrides.recorded === false ? undefined : { recorder })),
  } as unknown as SessionRegistry;
  const net = network({});
  const fetch = overrides.fetch ?? net.fetch;
  const hook = vi.fn(async (envelope: HookEnvelope) => {
    hooks.push(envelope);
    const id = (envelope.payload as { session_id: string }).session_id;
    seenLaunched.push(contained.launched(id));
    return {};
  });
  const contained = createContainedRunner({
    host: () => host,
    registry,
    genesis: () =>
      "genesis" in overrides ? overrides.genesis : "sha256:genesis",
    hook,
    record: (events) => records.push([...events]),
    model: { handle: vi.fn() } as unknown as ModelProxy,
    modelPort: () => 47100,
    issueCredential: credential,
    fetch,
    log,
  });
  return {
    contained,
    host,
    hooks,
    hook,
    records,
    log,
    credential,
    seenLaunched,
    recorder,
    calls: net.calls,
  };
}

/**
 * A launcher double that walks the real lifecycle order: prepare, then
 * measured, then sealed, then the result. `fail: "prepare"` throws once the
 * runner's prepare step has run, the way the real launcher throws on a
 * container that fails to create.
 */
function launcherWalks(
  fail?: "prepare",
  exitCode = 0,
): (options: ContainedLauncherOptions) => Promise<unknown> {
  return async (options) => {
    const sessionId = "contained-0123";
    const prepared = await options.prepare({
      sessionId,
      directory: "/tmp/oxagen-contained-x",
      workspace: options.request.workspace,
    });
    if (fail === "prepare") throw new Error("prepare stopped here");
    try {
      await options.measured(sessionId, MEASUREMENT);
      await options.sealed(sessionId, exitCode);
      return { sessionId, exitCode, measurement: MEASUREMENT };
    } finally {
      await prepared.close();
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.launch.mockReset();
  mocks.bridge.mockReset();
  mocks.bridge.mockImplementation(async () => ({
    close: vi.fn(async () => undefined),
  }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("containedLaunchEndpoint", () => {
  it("is the ingest endpoint's sibling under /tacho", () => {
    expect(
      containedLaunchEndpoint({
        endpoints: {
          ingest: "https://api.example.test/v1/tacho/events",
          bundle: "https://api.example.test/v1/tacho/bundle",
          commands: "https://api.example.test/v1/tacho/commands",
        },
      }),
    ).toBe("https://api.example.test/v1/tacho/contained-launch");
  });

  it("follows a host enrolled against a local or staging API, port and prefix included", () => {
    expect(
      containedLaunchEndpoint({
        endpoints: {
          ingest: "http://localhost:4000/api/v1/tacho/events?trace=1",
          bundle: "http://localhost:4000/api/v1/tacho/bundle",
          commands: "http://localhost:4000/api/v1/tacho/commands",
        },
      }),
    ).toBe("http://localhost:4000/api/v1/tacho/contained-launch");
  });

  it.each([
    "https://api.example.test/v1/tacho/bundle",
    "https://api.example.test/v1/tacho/events/",
    "https://api.example.test/v1/acme/core/events",
    "https://api.example.test/",
  ])(
    "refuses an ingest endpoint that is not the Tacho events route: %s",
    (ingest) => {
      expect(() =>
        containedLaunchEndpoint({
          endpoints: { ingest, bundle: ingest, commands: ingest },
        }),
      ).toThrow(/re-enroll this runner/);
    },
  );
});

describe("the contained runner refuses before any launch", () => {
  it.each([
    ["a paused host", { host_status: "paused" as const }],
    ["a suspended host", { host_status: "suspended" as const }],
    ["a revoked enrollment", { revoked_at: "2026-09-09T00:00:00.000Z" }],
    ["an expired enrollment", { expires_at: "2026-09-10T11:59:59.000Z" }],
  ])("for %s", async (_label, host) => {
    const { contained, credential, hook } = runner({ host });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "This enrollment cannot start a contained run",
    );
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("for an enrollment whose expiry is exactly now", async () => {
    const { contained } = runner({
      host: { expires_at: new Date(NOW).toISOString() },
    });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "This enrollment cannot start a contained run",
    );
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("for a host with no daemon gateway credential", async () => {
    const { contained, credential } = runner({
      host: { gateway_api_key: undefined },
    });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      /Re-enroll this runner to obtain a daemon gateway credential/,
    );
    expect(credential).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("when the daemon holds no model credential for the harness", async () => {
    const { contained, credential, calls } = runner({
      credential: {
        status: 403,
        body: { error: "no custody", code: "credential_unavailable" },
      },
    });
    await expect(
      contained.run(
        { ...REQUEST, github: { repository: "acme/app", token: TOKEN } },
        vi.fn(),
      ),
    ).rejects.toThrow(/must hold this harness's model credential/);
    expect(credential).toHaveBeenCalledWith("claude-code");
    expect(mocks.launch).not.toHaveBeenCalled();
    // Refused before the GitHub check, so GitHub is never asked which
    // repositories the token reaches. The token still ends with the run
    // that never started: it is revoked, not left for GitHub's hour.
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "DELETE https://api.github.com/installation/token",
    ]);
  });

  it.each([
    [
      "GitHub refuses the token",
      { status: 401, body: { message: "Bad credentials" } },
      /GitHub refused the run's installation token \(401\)/,
    ],
    [
      "the token reaches a second repository",
      {
        status: 200,
        body: {
          total_count: 2,
          repositories: [
            { full_name: "acme/app" },
            { full_name: "acme/infra" },
          ],
        },
      },
      /must reach acme\/app and no other repository/,
    ],
    [
      "the token reaches a different repository",
      {
        status: 200,
        body: { total_count: 1, repositories: [{ full_name: "acme/infra" }] },
      },
      /must reach acme\/app and no other repository/,
    ],
  ])("when %s", async (_label, verify, message) => {
    const net = network({ verify });
    const { contained, hook } = runner({ fetch: net.fetch });
    await expect(
      contained.run(
        { ...REQUEST, github: { repository: "acme/app", token: TOKEN } },
        vi.fn(),
      ),
    ).rejects.toThrow(message);
    expect(mocks.launch).not.toHaveBeenCalled();
    // No session starts, so a refusal leaves nothing in the record.
    expect(hook).not.toHaveBeenCalled();
    // The refused token is revoked, the over-broad one included.
    expect(net.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/installation/repositories?per_page=2",
      "DELETE https://api.github.com/installation/token",
    ]);
  });

  it.each([
    ["an unknown harness", { harness: "cursor" }],
    ["an image reference with a shell metacharacter", { image: "img;rm" }],
    ["an extra field", { extra: true }],
    [
      "a personal access token",
      { github: { repository: "acme/app", token: "ghp_x" } },
    ],
  ])("for a request with %s", async (_label, change) => {
    const { contained, credential } = runner();
    await expect(
      contained.run({ ...REQUEST, ...change }, vi.fn()),
    ).rejects.toThrow();
    expect(credential).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe("a contained run's lifecycle", () => {
  it("marks the session launched before its start hook and clears it after", async () => {
    mocks.launch.mockImplementation(launcherWalks(undefined, 3));
    const { contained, hooks, seenLaunched } = runner();
    const result = await contained.run(REQUEST, vi.fn());
    expect(result).toMatchObject({ sessionId: "contained-0123", exitCode: 3 });
    // The start hook already sees the session as launched, which is what
    // lets a mandate that requires containment admit it.
    expect(hooks.map(eventName)).toEqual(["SessionStart", "SessionEnd"]);
    expect(seenLaunched[0]).toBe(true);
    expect(hooks[0]).toEqual({
      harness: "claude-code",
      payload: {
        hook_event_name: "SessionStart",
        session_id: "contained-0123",
        cwd: "/work/repo",
        source: "startup",
      },
    });
    expect(hooks[1]?.payload).toMatchObject({
      hook_event_name: "SessionEnd",
      session_id: "contained-0123",
      exit_code: 3,
    });
    expect(contained.launched("contained-0123")).toBe(false);
  });

  it("clears the launched mark when the launch throws", async () => {
    mocks.launch.mockImplementation(launcherWalks("prepare"));
    const { contained, seenLaunched } = runner();
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "prepare stopped here",
    );
    expect(seenLaunched).toEqual([true]);
    expect(contained.launched("contained-0123")).toBe(false);
  });

  it("refuses to continue when the start hook recorded no session", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const { contained } = runner({ recorded: false });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "Contained session was not recorded",
    );
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(contained.launched("contained-0123")).toBe(false);
  });

  it("registers the launch with the gateway credential before the agent starts", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const net = network({ register: 201 });
    const { contained, records } = runner({ fetch: net.fetch });
    await contained.run(REQUEST, vi.fn());
    const registration = net.calls.find((call) =>
      call.url.endsWith("/contained-launch"),
    );
    expect(registration).toMatchObject({
      url: "https://api.example.test/v1/tacho/contained-launch",
      method: "POST",
      headers: { authorization: "Bearer oxa_test_gateway_key" },
    });
    expect(JSON.parse(registration?.body ?? "{}")).toEqual({
      host_enrollment_id: "tch_0123456789abcdefghjkmn",
      session_uuid: SESSION_UUID,
      genesis_hash: "sha256:genesis",
      measurement: MEASUREMENT,
    });
    expect(records.flat()).toContainEqual(
      expect.objectContaining({
        kind: "policy_decision",
        body: expect.objectContaining({
          policy_decision: "allow",
          policy_source: "kernel",
          policy_reason: "contained_launch_registered",
        }),
      }),
    );
  });

  it("stops the launch when the control plane refuses the registration", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const net = network({ register: 403 });
    const { contained, records, hooks } = runner({ fetch: net.fetch });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "Contained launch registration failed (403); the agent was not started",
    );
    expect(records.flat()).not.toContainEqual(
      expect.objectContaining({ kind: "policy_decision" }),
    );
    // The launcher double never reached `sealed`, as the real one would not
    // for a run that was never admitted.
    expect(hooks.map(eventName)).toEqual(["SessionStart"]);
  });

  it("stops the launch when the session has no recorded genesis", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const net = network({});
    const { contained } = runner({ fetch: net.fetch, genesis: undefined });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "Contained session has no recorded genesis",
    );
    expect(net.calls).toEqual([]);
  });

  it("hands the bridge the session's socket and a credential that fails closed", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const { contained, credential } = runner();
    await contained.run(REQUEST, vi.fn());
    const options = mocks.bridge.mock.calls[0]?.[0] as ContainedBridgeOptions;
    expect(options).toMatchObject({
      socketPath: "/tmp/oxagen-contained-x/bridge.sock",
      sessionId: "contained-0123",
      workspace: "/work/repo",
      harness: "claude-code",
      modelPort: 47100,
    });
    expect(options).not.toHaveProperty("github");
    expect(options.issueCredential()).toBe("oxrt_run_token");
    credential.mockReturnValue({
      status: 403,
      body: { error: "gone", code: "credential_unavailable" },
    });
    expect(() => options.issueCredential()).toThrow(
      "Credential custody unavailable",
    );
  });

  it("records what the bridge forwarded and what it refused", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const { contained, records } = runner();
    await contained.run(REQUEST, vi.fn());
    const options = mocks.bridge.mock.calls[0]?.[0] as ContainedBridgeOptions;
    records.length = 0;
    options.forwarded?.("GET", "/github/api/repos/acme/app/pulls?state=open");
    options.refused("/elsewhere?secret=1");
    expect(records.flat()).toEqual([
      expect.objectContaining({
        body: {
          policy_decision: "allow",
          policy_source: "bundle",
          policy_reason: "contained_github_route",
          tool_name: "GET /github/api/repos/acme/app/pulls",
        },
      }),
      expect.objectContaining({
        body: {
          policy_decision: "deny",
          policy_source: "bundle",
          policy_reason: "contained_gateway_route",
          tool_name: "/elsewhere",
        },
      }),
    ]);
  });

  it("aborts the launch signal on stop(sessionUuid) and on the caller's signal", async () => {
    let seen: AbortSignal | undefined;
    let release: () => void = () => undefined;
    mocks.launch.mockImplementation(
      async (options: ContainedLauncherOptions) => {
        await options.prepare({
          sessionId: "contained-0123",
          directory: "/tmp/d",
          workspace: "/work/repo",
        });
        seen = options.signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { sessionId: "contained-0123", exitCode: 0 };
      },
    );
    const { contained } = runner();
    const running = contained.run(REQUEST, vi.fn());
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    contained.stop(SESSION_UUID);
    expect(seen?.aborted).toBe(true);
    release();
    await running;

    const caller = new AbortController();
    seen = undefined;
    const second = contained.run(REQUEST, vi.fn(), caller.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    caller.abort();
    // `seen` is reassigned inside the launcher stand-in, which TypeScript's
    // narrowing after `seen = undefined` above cannot see.
    expect((seen as AbortSignal | undefined)?.aborted).toBe(true);
    release();
    await second;
  });

  it("starts already aborted when the caller's signal is", async () => {
    let seen: AbortSignal | undefined;
    mocks.launch.mockImplementation(
      async (options: ContainedLauncherOptions) => {
        seen = options.signal;
        return { sessionId: "contained-0123", exitCode: 0 };
      },
    );
    const { contained } = runner();
    const caller = new AbortController();
    caller.abort();
    await contained.run(REQUEST, vi.fn(), caller.signal);
    expect(seen?.aborted).toBe(true);
  });
});

describe("a contained run's GitHub grant", () => {
  const GITHUB = { repository: "acme/app", token: TOKEN };

  it("verifies before launch, passes the grant to the bridge, and revokes at seal", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const net = network({ revoke: 204 });
    const { contained, log } = runner({ fetch: net.fetch });
    await contained.run({ ...REQUEST, github: GITHUB }, vi.fn());
    expect(net.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/installation/repositories?per_page=2",
      "POST https://api.example.test/v1/tacho/contained-launch",
      "DELETE https://api.github.com/installation/token",
    ]);
    expect(net.calls.at(-1)?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    const options = mocks.bridge.mock.calls[0]?.[0] as ContainedBridgeOptions;
    expect(options.github).toEqual(GITHUB);
    expect(log).toHaveBeenCalledWith("Contained run GitHub token revoked");
  });

  it("revokes the token even when the launch throws", async () => {
    mocks.launch.mockRejectedValue(
      new Error("Docker cannot provide the Linux containment profile"),
    );
    const net = network({ revoke: 204 });
    const { contained } = runner({ fetch: net.fetch });
    await expect(
      contained.run({ ...REQUEST, github: GITHUB }, vi.fn()),
    ).rejects.toThrow("Docker cannot provide the Linux containment profile");
    expect(net.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.github.com/installation/token",
    });
  });

  it("reports a token GitHub already invalidated as such", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const net = network({ revoke: 401 });
    const { contained, log } = runner({ fetch: net.fetch });
    await contained.run({ ...REQUEST, github: GITHUB }, vi.fn());
    expect(log).toHaveBeenCalledWith(
      "Contained run GitHub token already_invalid",
    );
  });

  it.each([
    [500, /GitHub did not revoke the run's token \(500\)/],
    [new Error("socket hang up"), /socket hang up/],
  ])(
    "logs a failed revoke without failing a finished run: %s",
    async (revoke, message) => {
      mocks.launch.mockImplementation(launcherWalks(undefined, 0));
      const net = network({ revoke });
      const { contained, log } = runner({ fetch: net.fetch });
      await expect(
        contained.run({ ...REQUEST, github: GITHUB }, vi.fn()),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Contained run GitHub token was not revoked: /),
      );
      expect(log).toHaveBeenCalledWith(expect.stringMatching(message));
    },
  );

  it("keeps the launch's own error when the revoke fails too", async () => {
    mocks.launch.mockRejectedValue(new Error("the launch's own error"));
    const net = network({ revoke: 500 });
    const { contained, log } = runner({ fetch: net.fetch });
    await expect(
      contained.run({ ...REQUEST, github: GITHUB }, vi.fn()),
    ).rejects.toThrow("the launch's own error");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/was not revoked/));
  });

  it("never calls GitHub for a run without a grant", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const net = network({});
    const { contained } = runner({ fetch: net.fetch });
    await contained.run(REQUEST, vi.fn());
    expect(net.calls.some((call) => call.url.includes("github.com"))).toBe(
      false,
    );
  });
});
