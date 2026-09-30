import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Sha256Digest } from "../../digest";
import {
  abortableSleep,
  cloudUnreachable,
  createCloudLink,
  createLocalServers,
  createNonceLedger,
  deadlinePassed,
  DEFAULT_BACKOFF_INITIAL_MS,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_CONCURRENT,
  digestMismatch,
  envelopeExpired,
  envelopeReplayed,
  LOCAL_SERVERS_NEXT_PATH,
  LOCAL_SERVERS_REPLY_PATH,
  LocalServerError,
  refusalText,
  refusedReplySchema,
  resultReplySchema,
  serverFailed,
  toolsReplySchema,
  wrongMachine,
  type CloudFetch,
  type CloudLink,
  type CloudResponse,
  type DiscoverDelivery,
  type LaunchPackage,
  type LaunchSpec,
  type LocalServers,
  type LocalServersOptions,
  type PackageDigester,
} from "./index";
import {
  callDelivery,
  fakeSpawn,
  MACHINE,
  mcpServer,
  newNonce,
  NOW,
  NPM_DIGEST,
  npmLaunch,
  signingKey,
  type FakeSpawn,
  type McpServerBehaviour,
  type RpcAnswer,
  type SigningKey,
} from "./test-support";

const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const TOOLS = [{ name: "read_file", inputSchema: { type: "object" } }];

/** The environment the local gateway started with, decoy secret included. */
const ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  WORK_DIR: "/Users/dev/notes",
  AWS_SECRET_ACCESS_KEY: "decoy-secret",
};

/** M0's lock for the files server, read from disk so this test does not import mcp-studio. */
const LOCK_PATH = fileURLToPath(new URL("../../../../mcp-studio/fixtures/servers/files/tools.lock.json", import.meta.url));

interface ToolsLock {
  server: string;
  source: { command: string; args: string[]; package: LaunchPackage };
}

/** The launch the cloud gateway sends for M0's lock. */
function lockLaunch(): LaunchSpec {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as ToolsLock;
  return {
    server: lock.server,
    command: lock.source.command,
    args: lock.source.args,
    // The lock names no env. The server.toml beside it lists WORK_DIR, the one variable its args use.
    env: ["WORK_DIR"],
    package: lock.source.package,
  };
}

function behaviour(overrides?: Partial<McpServerBehaviour>): McpServerBehaviour {
  return {
    serverInfo: { name: "files", version: "2026.8.1" },
    tools: TOOLS,
    call: () => ({ content: [{ type: "text", text: "notes" }] }),
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Let every queued callback and microtask run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A long-poll that never answers. It rejects when the gateway stops, as the cloud link does. */
function parkUntilAbort(signal?: AbortSignal): Promise<undefined> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("the long-poll was aborted")), { once: true });
  });
}

/** The error the cloud link throws when a request fails: cloud_unreachable, with the detail as its cause. */
function unreachable(detail: string): LocalServerError {
  const error = new LocalServerError(cloudUnreachable());
  error.cause = detail;
  return error;
}

interface Rig {
  servers: LocalServers;
  key: SigningKey;
  fake: FakeSpawn;
  digester: { digest: Mock<PackageDigester["digest"]> };
  log: Mock<(line: string) => void>;
  link: { next: Mock<CloudLink["next"]>; reply: Mock<CloudLink["reply"]> };
  /** Settles when the pull loop reaches a long-poll that waits for stop. */
  parked: Promise<void>;
}

function rig(overrides: Partial<LocalServersOptions> = {}, answer: RpcAnswer = mcpServer(behaviour())): Rig {
  const key = signingKey();
  const fake = fakeSpawn(answer);
  const digester = { digest: vi.fn<PackageDigester["digest"]>(() => Promise.resolve(NPM_DIGEST)) };
  const log = vi.fn<(line: string) => void>();
  const parked = deferred();
  const link = {
    next: vi.fn<CloudLink["next"]>((signal) => {
      parked.resolve();
      return parkUntilAbort(signal);
    }),
    reply: vi.fn<CloudLink["reply"]>(() => Promise.resolve()),
  };
  const servers = createLocalServers({
    machine: MACHINE,
    publicKeyPem: key.publicKeyPem,
    link,
    spawn: fake.spawn,
    env: ENV,
    digester,
    log,
    now: () => NOW,
    ...overrides,
  });
  return { servers, key, fake, digester, log, link, parked: parked.promise };
}

function discoverDelivery(overrides?: Partial<DiscoverDelivery>): DiscoverDelivery {
  return { kind: "discover", id: newNonce(), launch: npmLaunch(), deadline_ms: 30_000, ...overrides };
}

function response(status: number, text = ""): CloudResponse {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createLocalServers: calls", () => {
  it("runs a signed call end to end and screens the result before it leaves the machine", async () => {
    const answer = mcpServer(
      behaviour({ call: (params) => ({ content: [{ type: "text", text: `${String(params.name)} read ${AWS_KEY}` }] }) }),
    );
    const r = rig({}, answer);
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: { path: "notes.md" } });

    const reply = await r.servers.handle(delivery);

    expect(reply).toEqual({
      kind: "result",
      id: delivery.envelope.nonce,
      machine: MACHINE,
      result: { content: [{ type: "text", text: "read_file read [redacted:aws_access_key]" }] },
      redactions: 1,
    });
    expect(resultReplySchema.safeParse(reply).success).toBe(true);
    expect(r.fake.started[0]?.child.received.at(-1)).toEqual(
      expect.objectContaining({ method: "tools/call", params: { name: "read_file", arguments: { path: "notes.md" } } }),
    );
    expect(r.log).not.toHaveBeenCalled();
  });

  it("tells Oxagen when the server's tools changed during the call (#4772)", async () => {
    const base = mcpServer(behaviour());
    const answer: RpcAnswer = (message, child) => {
      if (message.method === "tools/call") child.send({ method: "notifications/tools/list_changed" });
      base(message, child);
    };
    const r = rig({}, answer);
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: { path: "notes.md" } });

    const reply = await r.servers.handle(delivery);

    expect(reply).toMatchObject({ kind: "result", id: delivery.envelope.nonce, tools_changed: true });
    expect(resultReplySchema.safeParse(reply).success).toBe(true);
  });

  it("keeps the change notice when the call then fails, as a call to a removed tool does (#4772)", async () => {
    const base = mcpServer(behaviour());
    const answer: RpcAnswer = (message, child) => {
      if (message.method === "tools/call") {
        child.send({ method: "notifications/tools/list_changed" });
        child.send({ id: message.id, error: { code: -32602, message: "Unknown tool: read_file" } });
        return;
      }
      base(message, child);
    };
    const r = rig({}, answer);
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: { path: "notes.md" } });

    const reply = await r.servers.handle(delivery);

    expect(reply).toMatchObject({ kind: "refused", id: delivery.envelope.nonce, tools_changed: true });
    expect(refusedReplySchema.safeParse(reply).success).toBe(true);
  });

  it("launches M0's lock with WORK_DIR filled from this machine's env", async () => {
    const launch = lockLaunch();
    const r = rig();
    r.digester.digest.mockResolvedValue(launch.package.digest as Sha256Digest);
    const delivery = callDelivery({ key: r.key, launch, arguments: { path: "notes.md" } });

    expect((await r.servers.handle(delivery)).kind).toBe("result");

    const filled = ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "/Users/dev/notes"];
    expect(r.fake.started).toHaveLength(1);
    expect(r.fake.started[0]?.command).toBe("npx");
    expect(r.fake.started[0]?.args).toEqual(filled);
    expect(r.digester.digest).toHaveBeenCalledWith(
      launch.package,
      expect.objectContaining({ command: "npx", args: filled }),
      undefined,
    );
  });

  it("does not pass a decoy AWS_SECRET_ACCESS_KEY to the child", async () => {
    const r = rig();
    await r.servers.handle(callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} }));

    const env = r.fake.started[0]?.options.env;
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/dev", WORK_DIR: "/Users/dev/notes" });
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("refuses a launch that needs WORK_DIR when this machine does not set it", async () => {
    const r = rig({ env: { PATH: "/usr/bin" } });
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} });
    const id = delivery.envelope.nonce;

    expect(await r.servers.handle(delivery)).toEqual({
      kind: "refused",
      id,
      machine: MACHINE,
      refusal: {
        code: "missing_variable",
        message: "The package needs WORK_DIR, and this machine does not set it.",
        fix: "Set it where the local gateway starts, then retry.",
      },
    });
    expect(r.log).toHaveBeenCalledWith(
      `The local gateway refused ${id}. The package needs WORK_DIR, and this machine does not set it. Set it where the local gateway starts, then retry.`,
    );
    expect(r.digester.digest).not.toHaveBeenCalled();
    expect(r.fake.started).toHaveLength(0);
  });

  it("refuses a package whose digest on this machine differs from the lock", async () => {
    const r = rig();
    r.digester.digest.mockResolvedValue(`sha256:${"c".repeat(64)}`);
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} });

    expect(await r.servers.handle(delivery)).toEqual({
      kind: "refused",
      id: delivery.envelope.nonce,
      machine: MACHINE,
      refusal: digestMismatch(),
    });
    expect(r.fake.started).toHaveLength(0);
  });

  it("refuses an envelope for another machine", async () => {
    const other = "tch_zyxwvutsrqponmlkjihgfe";
    const r = rig();
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {}, envelope: { machine: other } });

    expect(await r.servers.handle(delivery)).toEqual({
      kind: "refused",
      id: delivery.envelope.nonce,
      machine: MACHINE,
      refusal: wrongMachine(other),
    });
    expect(r.digester.digest).not.toHaveBeenCalled();
    expect(r.fake.started).toHaveLength(0);
  });

  const lateClocks: [string, Partial<LocalServersOptions>][] = [
    ["past the default skew", { now: () => NOW + 20_000 + DEFAULT_CLOCK_SKEW_MS + 1 }],
    ["past a skew the options set", { now: () => NOW + 20_001, skewMs: 0 }],
  ];
  it.each(lateClocks)("refuses an expired envelope when the clock reads %s", async (_name, overrides) => {
    const r = rig(overrides);
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} });

    expect(await r.servers.handle(delivery)).toEqual({
      kind: "refused",
      id: delivery.envelope.nonce,
      machine: MACHINE,
      refusal: envelopeExpired(new Date(NOW + 20_000).toISOString()),
    });
    expect(r.fake.started).toHaveLength(0);
  });

  it("refuses a replayed envelope and keeps its nonce in the ledger it was given", async () => {
    const nonces = createNonceLedger({ skewMs: DEFAULT_CLOCK_SKEW_MS });
    const r = rig({ nonces });
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} });

    expect((await r.servers.handle(delivery)).kind).toBe("result");
    expect(await r.servers.handle(delivery)).toEqual({
      kind: "refused",
      id: delivery.envelope.nonce,
      machine: MACHINE,
      refusal: envelopeReplayed(),
    });
    expect(r.fake.started).toHaveLength(1);
    expect(nonces.size()).toBe(1);
  });

  const deadlines: [string, { deadline_ms?: number }, number][] = [
    ["the envelope's deadline_ms", { deadline_ms: 250 }, 250],
    ["the default deadline", {}, DEFAULT_DEADLINE_MS],
  ];
  it.each(deadlines)("stops a call that runs past %s", async (_name, envelope, deadlineMs) => {
    vi.useFakeTimers();
    const server = mcpServer(behaviour());
    const silent: RpcAnswer = (message, child) => {
      if (message.method !== "tools/call") server(message, child);
    };
    const r = rig({}, silent);
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {}, envelope });

    const reply = r.servers.handle(delivery);
    await vi.advanceTimersByTimeAsync(deadlineMs);

    expect(await reply).toEqual({
      kind: "refused",
      id: delivery.envelope.nonce,
      machine: MACHINE,
      refusal: deadlinePassed("files", deadlineMs),
    });
  });

  it("reads the clock from Date.now when the options give none", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // An undefined now makes the gateway fall back to Date.now.
    const r = rig({ now: undefined });

    const call = await r.servers.handle(callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} }));
    const tools = await r.servers.handle(discoverDelivery());

    expect(call.kind).toBe("result");
    expect(tools).toEqual(expect.objectContaining({ reported_at: new Date(NOW).toISOString() }));
  });
});

describe("createLocalServers: discovery and errors", () => {
  it("reports the server's tools in a reply that names this machine", async () => {
    const r = rig();
    const delivery = discoverDelivery();

    const reply = await r.servers.handle(delivery);

    expect(reply).toEqual({
      kind: "tools",
      id: delivery.id,
      machine: MACHINE,
      server: "files",
      server_version: "2026.8.1",
      tools: TOOLS,
      reported_at: "2026-09-27T12:00:00.000Z",
    });
    expect(toolsReplySchema.safeParse(reply).success).toBe(true);
    expect(r.fake.started[0]?.args).toEqual([
      "--yes",
      "@modelcontextprotocol/server-filesystem@2026.8.1",
      "/Users/dev/notes",
    ]);
  });

  it("leaves out server_version when the server reports none", async () => {
    const r = rig({}, mcpServer(behaviour({ serverInfo: { name: "files" } })));

    const reply = await r.servers.handle(discoverDelivery());

    expect(reply.kind).toBe("tools");
    expect("server_version" in reply).toBe(false);
  });

  const unexpected: [string, unknown, string][] = [
    ["an Error", new Error("disk gone"), "disk gone"],
    ["a thrown string", "EACCES", "EACCES"],
  ];
  it.each(unexpected)("refuses with server_failed when the digester throws %s", async (_name, thrown, text) => {
    const r = rig();
    r.digester.digest.mockRejectedValue(thrown);
    const delivery = discoverDelivery();

    expect(await r.servers.handle(delivery)).toEqual({
      kind: "refused",
      id: delivery.id,
      machine: MACHINE,
      refusal: serverFailed("files", `the local gateway hit an unexpected error (${text})`),
    });
  });

  it("clips a refusal message to the length the reply schema holds", async () => {
    const long = serverFailed("files", "x".repeat(3_000));
    const r = rig();
    r.digester.digest.mockRejectedValue(new LocalServerError(long));
    const delivery = discoverDelivery();

    const reply = await r.servers.handle(delivery);

    expect(reply).toEqual({
      kind: "refused",
      id: delivery.id,
      machine: MACHINE,
      refusal: { ...long, message: long.message.slice(0, 2048) },
    });
    expect(refusedReplySchema.safeParse(reply).success).toBe(true);
    expect(r.log).toHaveBeenCalledWith(`The local gateway refused ${delivery.id}. ${refusalText(long)}`);
  });
});

describe("createLocalServers: the pull loop", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
    expect(DEFAULT_BACKOFF_INITIAL_MS).toBe(1_000);
    expect(DEFAULT_BACKOFF_MAX_MS).toBe(60_000);
  });

  it("pulls a call, runs it, and posts the reply", async () => {
    const r = rig();
    const delivery = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} });
    r.link.next.mockResolvedValueOnce(delivery);
    const posted = deferred();
    r.link.reply.mockImplementationOnce(() => {
      posted.resolve();
      return Promise.resolve();
    });

    r.servers.start();
    await posted.promise;
    await r.servers.stop();

    expect(r.link.next).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(r.link.reply).toHaveBeenCalledTimes(1);
    expect(r.link.reply).toHaveBeenCalledWith(expect.objectContaining({ kind: "result", id: delivery.envelope.nonce }));
    expect(r.log).not.toHaveBeenCalled();
  });

  it("runs nothing while the cloud is unreachable, logs the spec's sentence, and backs off", async () => {
    const waits: number[] = [];
    const r = rig({
      backoff: { initialMs: 100, maxMs: 250 },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const status = `it answered GET ${LOCAL_SERVERS_NEXT_PATH} with 503`;
    r.link.next
      .mockRejectedValueOnce(unreachable(status))
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockRejectedValueOnce("offline")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(unreachable(status));

    r.servers.start();
    await r.parked;
    await r.servers.stop();

    const sentence = refusalText(cloudUnreachable());
    expect(r.log.mock.calls).toEqual([
      [`${sentence} The pull failed (${status}).`],
      [`${sentence} The pull failed (socket closed).`],
      [`${sentence} The pull failed (offline).`],
      [`${sentence} The pull failed (${status}).`],
    ]);
    // Each failure doubles the wait up to the cap, and a pull that succeeds starts the count again.
    expect(waits).toEqual([100, 200, 250, 100]);
    expect(r.digester.digest).not.toHaveBeenCalled();
    expect(r.fake.started).toHaveLength(0);
    expect(r.link.reply).not.toHaveBeenCalled();
  });

  it("drops a reply the cloud does not take, logs why, and does not retry it", async () => {
    const key = signingKey();
    const delivery = callDelivery({ key, launch: npmLaunch(), arguments: {} });
    const posted = deferred();
    let gets = 0;
    const fetch = vi.fn<CloudFetch>((_url, init) => {
      if (init.method === "POST") {
        posted.resolve();
        return Promise.resolve(response(500));
      }
      gets += 1;
      if (gets === 1) return Promise.resolve(response(200, JSON.stringify(delivery)));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("the long-poll was aborted")), { once: true });
      });
    });
    const link = createCloudLink({ baseUrl: "https://api.oxagen.test", apiKey: "machine-api-key", machine: MACHINE, fetch });
    const r = rig({ publicKeyPem: key.publicKeyPem, link });

    r.servers.start();
    await posted.promise;
    await r.servers.stop();

    expect(r.log.mock.calls).toEqual([
      [
        `${refusalText(cloudUnreachable())} The local gateway dropped its reply to ${delivery.envelope.nonce} (it answered POST ${LOCAL_SERVERS_REPLY_PATH} with 500).`,
      ],
    ]);
    expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(r.fake.started).toHaveLength(1);
  });

  it("holds the next pull while maxConcurrent deliveries run, and floors the limit at one", async () => {
    // A limit of 0 would hang the loop on an empty race, so the gateway treats it as 1.
    const r = rig({ maxConcurrent: 0 });
    const first = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} });
    const second = callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} });
    r.link.next.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const posted = deferred();
    const release = deferred();
    r.link.reply.mockImplementationOnce(() => {
      posted.resolve();
      return release.promise;
    });

    r.servers.start();
    await posted.promise;
    await flush();
    expect(r.link.next).toHaveBeenCalledTimes(1);

    release.resolve();
    await r.parked;
    await r.servers.stop();

    expect(r.link.next).toHaveBeenCalledTimes(3);
    expect(r.link.reply.mock.calls.map(([reply]) => reply.id)).toEqual([first.envelope.nonce, second.envelope.nonce]);
  });

  it("waits for each delivery in flight before stop resolves", async () => {
    const r = rig();
    r.link.next.mockResolvedValueOnce(callDelivery({ key: r.key, launch: npmLaunch(), arguments: {} }));
    const posted = deferred();
    const release = deferred();
    r.link.reply.mockImplementationOnce(() => {
      posted.resolve();
      return release.promise;
    });

    r.servers.start();
    await posted.promise;
    let stopped = false;
    const stopping = r.servers.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    release.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("ignores a second start and a stop when nothing runs, and starts again after a stop", async () => {
    const r = rig();

    await r.servers.stop();
    r.servers.start();
    r.servers.start();
    expect(r.link.next).toHaveBeenCalledTimes(1);

    await r.servers.stop();
    await r.servers.stop();
    r.servers.start();
    expect(r.link.next).toHaveBeenCalledTimes(2);
    await r.servers.stop();
  });

  it("waits the default backoff after a failed pull, and stop wakes the wait", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.link.next.mockRejectedValue(new Error("socket closed"));

    r.servers.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_BACKOFF_INITIAL_MS - 1);
    expect(r.link.next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.link.next).toHaveBeenCalledTimes(2);

    // The second failure waits twice as long. Stop ends that wait at once.
    await r.servers.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(r.log).toHaveBeenCalledTimes(2);
  });
});

describe("abortableSleep", () => {
  it("resolves at once when the signal has already aborted", async () => {
    vi.useFakeTimers();
    await abortableSleep(1_000, AbortSignal.abort());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves when the time passes", async () => {
    vi.useFakeTimers();
    let woke = false;
    const sleeping = abortableSleep(500, new AbortController().signal).then(() => {
      woke = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(woke).toBe(true);
  });

  it("resolves early and clears its timer when the signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);

    controller.abort();
    await sleeping;
    expect(vi.getTimerCount()).toBe(0);
  });
});
