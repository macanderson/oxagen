/**
 * The daemon side of `oxagen agent run --contained` (ADR-152): what the runner
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
import { KIND_BODIES, type TachoEvent } from "../envelope";
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
 * One fake network for the Oxagen API. Each route answers with a status; the
 * calls are kept in order so a test can say what was never asked. Any other
 * URL, GitHub's included, throws.
 */
function network(routes: { register?: number }) {
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
    /** What the daemon answers the start hook. */
    startAnswer?: Record<string, unknown>;
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
  const custody = {
    issueForSession: vi.fn(() => ({
      status: 200,
      body: { token: "oxgit_lease", expires_at: "2026-09-10T12:15:00.000Z" },
    })),
    handle: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  const hook = vi.fn(
    async (envelope: HookEnvelope): Promise<Record<string, unknown>> => {
      hooks.push(envelope);
      const id = (envelope.payload as { session_id: string }).session_id;
      seenLaunched.push(contained.launched(id));
      return eventName(envelope) === "SessionStart"
        ? (overrides.startAnswer ?? {})
        : {};
    },
  );
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
    github: custody,
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
    custody,
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
    const { contained, credential, custody, calls } = runner({
      credential: {
        status: 403,
        body: { error: "no custody", code: "credential_unavailable" },
      },
    });
    await expect(
      contained.run(
        { ...REQUEST, github: { repository: "acme/app" } },
        vi.fn(),
      ),
    ).rejects.toThrow(/must hold this harness's model credential/);
    expect(credential).toHaveBeenCalledWith("claude-code");
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(custody.issueForSession).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([
    ["an unknown harness", { harness: "cursor" }],
    ["an image reference with a shell metacharacter", { image: "img;rm" }],
    ["an extra field", { extra: true }],
    // An operator-minted token is no longer accepted (ADR-254), so an
    // older CLI that still sends one is refused rather than ignored.
    [
      "a GitHub installation token",
      { github: { repository: "acme/app", token: TOKEN } },
    ],
    ["a repository with no owner", { github: { repository: "app" } }],
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
    // The env names, as a host path, where the harness inside the container
    // reads its skills, so the daemon places them there.
    expect(hooks[0]).toEqual({
      harness: "claude-code",
      env: { CLAUDE_CONFIG_DIR: "/work/repo/.oxagen-contained/home/.claude" },
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
      reason: "other",
      exit_code: 3,
    });
    expect(hooks[1]?.env).toEqual({
      CLAUDE_CONFIG_DIR: "/work/repo/.oxagen-contained/home/.claude",
    });
    expect(contained.launched("contained-0123")).toBe(false);
  });

  it("ends the session and clears the launched mark when the launch throws after the start", async () => {
    mocks.launch.mockImplementation(launcherWalks("prepare"));
    const { contained, hooks, seenLaunched } = runner();
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "prepare stopped here",
    );
    // The end goes out while the session is still marked launched, as a
    // normal end does. Left open, the session would be swept as crashed.
    expect(hooks.map(eventName)).toEqual(["SessionStart", "SessionEnd"]);
    expect(hooks[1]).toEqual({
      harness: "claude-code",
      env: { CLAUDE_CONFIG_DIR: "/work/repo/.oxagen-contained/home/.claude" },
      payload: {
        hook_event_name: "SessionEnd",
        session_id: "contained-0123",
        cwd: "/work/repo",
        reason: "contained_launch_failed",
      },
    });
    expect(seenLaunched).toEqual([true, true]);
    expect(contained.launched("contained-0123")).toBe(false);
  });

  it("ends the session when the bridge fails to start", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    mocks.bridge.mockRejectedValue(new Error("EADDRINUSE"));
    const { contained, hooks } = runner();
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "EADDRINUSE",
    );
    expect(hooks.map(eventName)).toEqual(["SessionStart", "SessionEnd"]);
    expect(hooks[1]?.payload).toMatchObject({
      reason: "contained_launch_failed",
    });
  });

  it("logs an end that fails and still reports why the launch failed", async () => {
    mocks.launch.mockImplementation(launcherWalks("prepare"));
    const { contained, hook, log } = runner();
    hook.mockImplementation(async (envelope: HookEnvelope) => {
      if (eventName(envelope) === "SessionEnd")
        throw new Error("daemon stopping");
      return {};
    });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "prepare stopped here",
    );
    expect(log).toHaveBeenCalledWith(
      "contained: session contained-0123 stays open after its launch failed, because ending it failed: daemon stopping",
    );
    expect(contained.launched("contained-0123")).toBe(false);
  });

  it("refuses to continue when the start hook recorded no session", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const { contained, hooks } = runner({ recorded: false });
    await expect(contained.run(REQUEST, vi.fn())).rejects.toThrow(
      "Contained session was not recorded",
    );
    expect(mocks.bridge).not.toHaveBeenCalled();
    // No record to end: an end would make the daemon open one.
    expect(hooks.map(eventName)).toEqual(["SessionStart"]);
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
          policy_reason_code: "contained_launch_registered",
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
    // for a run that was never admitted. The runner ends the session itself,
    // so a refused launch reads as aborted, not crashed.
    expect(hooks.map(eventName)).toEqual(["SessionStart", "SessionEnd"]);
    expect(hooks[1]?.payload).toMatchObject({
      hook_event_name: "SessionEnd",
      session_id: "contained-0123",
      reason: "contained_launch_failed",
    });
    expect(hooks[1]?.payload).not.toHaveProperty("exit_code");
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

  it.each([
    [
      "claude-code",
      { CLAUDE_CONFIG_DIR: "/work/repo/.oxagen-contained/home/.claude" },
    ],
    ["codex", { CODEX_HOME: "/work/repo/.oxagen-contained/home/.codex" }],
  ])(
    "hands the %s bridge the start's answer and the skills env",
    async (harness, env) => {
      mocks.launch.mockImplementation(launcherWalks());
      const answer = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "Follow the workspace's steering.",
        },
      };
      const { contained, hooks } = runner({ startAnswer: answer });
      await contained.run({ ...REQUEST, harness }, vi.fn());
      const options = mocks.bridge.mock.calls[0]?.[0] as ContainedBridgeOptions;
      // The harness's own first start gets this answer, so the run records
      // one start, not a start and then a resume.
      expect(options.opening).toEqual(answer);
      expect(options.env).toEqual(env);
      expect(hooks[0]?.env).toEqual(env);
    },
  );

  it("records what the bridge refused", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const { contained, records } = runner();
    await contained.run(REQUEST, vi.fn());
    const options = mocks.bridge.mock.calls[0]?.[0] as ContainedBridgeOptions;
    records.length = 0;
    options.githubRefused?.(
      "/github/git/acme/app.git/info/refs?service=git-upload-pack",
    );
    options.refused("/elsewhere?secret=1");
    expect(records.flat()).toEqual([
      expect.objectContaining({
        body: {
          policy_decision: "deny",
          policy_source: "kernel",
          policy_reason_code: "contained_github_custody",
          tool_name: "/github/git/acme/app.git/info/refs",
        },
      }),
      expect.objectContaining({
        body: {
          policy_decision: "deny",
          policy_source: "bundle",
          policy_reason_code: "contained_gateway_route",
          tool_name: "/elsewhere",
        },
      }),
    ]);
    // Every member is one the strict envelope declares. An undeclared
    // `policy_reason` was moved into `attrs` by the recorder, where no
    // reader of the decision looked.
    for (const event of records.flat())
      expect(KIND_BODIES.policy_decision.safeParse(event.body).success).toBe(
        true,
      );
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

describe("a contained run's GitHub custody", () => {
  it("hands the bridge a lease keyed by the launched session and calls no GitHub API", async () => {
    const net = network({});
    const { contained, custody } = runner({ fetch: net.fetch });
    let files: Record<string, string> | undefined;
    let named: string | undefined;
    mocks.launch.mockImplementation(
      async (options: ContainedLauncherOptions) => {
        const prepared = await options.prepare({
          sessionId: "contained-0123",
          directory: "/tmp/oxagen-contained-x",
          workspace: options.request.workspace,
        });
        files = prepared.files;
        // What the daemon's push record reads while the run is live.
        named = contained.githubRepository("contained-0123");
        await options.measured("contained-0123", MEASUREMENT);
        await prepared.close();
        return { sessionId: "contained-0123", exitCode: 0 };
      },
    );
    await contained.run(
      { ...REQUEST, github: { repository: "acme/app" } },
      vi.fn(),
    );
    // The only network call is the launch registration. No token is
    // checked or revoked here: the custody proxy mints one per request.
    expect(net.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.example.test/v1/tacho/contained-launch",
    ]);
    const options = mocks.bridge.mock.calls[0]?.[0] as ContainedBridgeOptions;
    expect(options.github?.repository).toBe("acme/app");
    expect(options.github?.lease()).toEqual({
      status: 200,
      body: { token: "oxgit_lease", expires_at: "2026-09-10T12:15:00.000Z" },
    });
    // Keyed by the session the launcher started, never by a directory.
    expect(custody.issueForSession).toHaveBeenCalledWith({
      session: SESSION_UUID,
      repository: "acme/app",
    });
    expect(options.github?.handle).toBe(custody.handle);
    expect(options.github?.release).toBe(custody.release);
    // The measured configuration names the repository and carries no
    // credential.
    expect(files?.["github.json"]).toBe(
      JSON.stringify({ repository: "acme/app" }),
    );
    expect(JSON.stringify(files)).not.toContain("oxgit_");
    expect(named).toBe("acme/app");
    expect(contained.githubRepository("contained-0123")).toBeUndefined();
  });

  it("gives the bridge no GitHub route for a run that names no repository", async () => {
    mocks.launch.mockImplementation(launcherWalks());
    const net = network({});
    const { contained, custody } = runner({ fetch: net.fetch });
    await contained.run(REQUEST, vi.fn());
    const options = mocks.bridge.mock.calls[0]?.[0] as ContainedBridgeOptions;
    expect(options).not.toHaveProperty("github");
    expect(custody.issueForSession).not.toHaveBeenCalled();
    expect(net.calls.some((call) => call.url.includes("github.com"))).toBe(
      false,
    );
  });
});
