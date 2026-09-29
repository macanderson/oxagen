// sync.test.ts: one discovery run, from the steering files to the sync
// steering PR (lane M10, #4682). Every seam is a fake: the steering
// checkout, the credential source, the Transport, the registry catalog, the
// local reporter, and the opener. The store records each call and the logger
// is mocked, so each case checks what the run wrote, logged, and sent, and
// that no credential reached any of it.
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  compile,
  formatJson,
  lock,
  mcpToolSchema,
  parseServerToml,
  parseToolsToml,
  toManifestServer,
  TransportError,
  upstreamFromMcpTool,
  type CredentialSource,
  type HeaderEntry,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type ManifestServer,
  type McpLockSource,
  type McpToolsLock,
  type ReadResult,
  type RegistryEntry,
  type ResolvedCredential,
  type Transport,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import {
  serverTomlPath,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo";
import { REDACTED } from "./scrub";
import {
  noGrpcDiscovery,
  noToolsPullRequestOpener,
  type DiscoveryCredentials,
  type DiscoverySeams,
  type LocalToolsReporter,
  type RegistryCatalog,
  type SteeringCheckout,
  type SteeringFiles,
  type ToolsPullRequestInput,
  type ToolsPullRequestOpener,
} from "./seams";
import type { DiscoveryFinish, DiscoveryRow, DiscoveryStore } from "./store";
import { runDiscovery } from "./sync";
import {
  RetriableDiscoveryFailure,
  type DiscoveryScope,
  type DiscoveryTrigger,
} from "./types";

const logs = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../logger", () => ({ logger: logs }));
vi.mock("./store", () => ({ postgresDiscoveryStore: {} }));

// ── Builders ─────────────────────────────────────────────────────────────────

const ORG = "0191d0a0-0000-7000-8000-000000000001";
const WS = "0191d0a0-0000-7000-8000-000000000002";
const SCOPE: DiscoveryScope = { orgId: ORG, workspaceId: WS };
const NOW = new Date("2026-09-28T15:00:12Z");
const PR_URL = "https://github.com/a-intel/steering/pull/41";
const HEAD_SHA = "3e1f0a9c7b5d2e4f6a8c0b1d3e5f7a9c2b4d6e8f";

/** The service token the fake vault returns. Every run must scrub it. */
const SECRET = "sk_test/4f9a+2c7e1b";
const SECRET_FORMS = [
  SECRET,
  encodeURIComponent(SECRET),
  Buffer.from(SECRET, "utf8").toString("base64"),
];

const NO_OPENER =
  "No tools steering PR opener is installed, so discovery cannot open the sync steering PR.";

/** A tool as an MCP server lists it in tools/list. */
interface RawTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const CREATE_REFUND: RawTool = {
  name: "create_refund",
  description: "Create a refund for a charge.",
  inputSchema: {
    type: "object",
    properties: { amount: { type: "integer" }, charge: { type: "string" } },
    required: ["charge"],
  },
  annotations: { destructiveHint: true },
};

const LIST_CHARGES: RawTool = {
  name: "list_charges",
  description: "List charges, newest first.",
  inputSchema: {
    type: "object",
    properties: { customer: { type: "string" }, limit: { type: "integer" } },
  },
  annotations: { readOnlyHint: true },
};

const CREATE_CUSTOMER: RawTool = {
  name: "create_customer",
  description: "Create a customer.",
  inputSchema: { type: "object", properties: { email: { type: "string" } } },
};

/** create_refund with a new required input: a breaking change. */
const REFUND_NEEDS_CURRENCY: RawTool = {
  ...CREATE_REFUND,
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "integer" },
      charge: { type: "string" },
      currency: { type: "string" },
    },
    required: ["charge", "currency"],
  },
};

const STRIPE_UPSTREAM: readonly RawTool[] = [
  CREATE_REFUND,
  LIST_CHARGES,
  CREATE_CUSTOMER,
];

const STRIPE_SERVER = [
  "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
  'schema = "mcp-server/v1"',
  'name = "stripe"',
  'label = "Stripe"',
  'description = "Payments and refunds in the a-intel Stripe account."',
  "",
  "[source]",
  'type = "remote"',
  'url = "https://mcp.stripe.com"',
  'transport = "http"',
  "",
  "[auth]",
  'mode = "service"',
  'scheme = "oauth"',
  "",
  "[environments.test]",
  "sandbox = true",
  'credential = "oxagen:credential/stripe-test"',
  "",
  "[environments.live]",
  'credential = "oxagen:credential/stripe-live"',
  "",
  "[exposure]",
  'mode = "direct"',
  "definition_budget = 8000",
  "",
  "[sync]",
  'schedule = "daily"',
  "",
].join("\n");

const STRIPE_TOOLS = [
  "#:schema https://oxagen.sh/schemas/mcp-tools/v1.json",
  'schema = "mcp-tools/v1"',
  "",
  "[defaults]",
  "max_result_bytes = 16384",
  "",
  "[tools.list_charges]",
  'risk = "low"',
  'side_effect = "read"',
  'egress = "third_party"',
  "",
  "[tools.create_refund]",
  'description = "Refund part or all of a captured charge. In cents."',
  'risk = "high"',
  'side_effect = "irreversible"',
  'egress = "third_party"',
  'impacts = ["moves_money"]',
  "",
].join("\n");

const STRIPE_SOURCE: McpLockSource = {
  type: "remote",
  url: "https://mcp.stripe.com",
  server_version: "2026.09.1",
};

function must<T>(result: ReadResult<T>): T {
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.value;
}

function upstreamOf(tools: readonly RawTool[]): UpstreamTool[] {
  return tools.map((tool) => upstreamFromMcpTool(mcpToolSchema.parse(tool)));
}

/** A compiled server and its lock, as the production branch holds them. */
interface Side {
  lock: McpToolsLock;
  server: ManifestServer;
}

function compiledSide(input: {
  serverText: string;
  toolsText: string;
  tools: readonly RawTool[];
  source: McpLockSource;
  previous?: McpToolsLock | undefined;
}): Side {
  const compiled = compile({
    server: must(parseServerToml(input.serverText)),
    tools: must(parseToolsToml(input.toolsText)),
    upstream: upstreamOf(input.tools),
    security_schemes: {},
    descriptor_set: undefined,
  });
  const locked = lock({
    compiled,
    source: input.source,
    previous: input.previous,
  });
  return { lock: locked, server: toManifestServer(compiled, locked) };
}

function stripeSide(
  tools: readonly RawTool[],
  previous?: McpToolsLock,
  toolsText: string = STRIPE_TOOLS,
): Side {
  return compiledSide({
    serverText: STRIPE_SERVER,
    toolsText,
    tools,
    source: STRIPE_SOURCE,
    previous,
  });
}

/** The stripe folder on the production branch, locked to STRIPE_UPSTREAM. */
function stripeTree(
  options: { folder?: string; server?: string } = {},
): Record<string, string> {
  const folder = options.folder ?? "stripe";
  return {
    [serverTomlPath(folder)]: options.server ?? STRIPE_SERVER,
    [toolsTomlPath(folder)]: STRIPE_TOOLS,
    [toolsLockPath(folder)]: formatJson(stripeSide(STRIPE_UPSTREAM).lock),
  };
}

/** A row in mcp.server_discoveries after a finished run. */
function row(overrides: Partial<DiscoveryRow> = {}): DiscoveryRow {
  return {
    server: "stripe",
    mcpServerId: "srv-1",
    status: "succeeded",
    trigger: "schedule",
    requestedAt: NOW,
    requestedBy: null,
    startedAt: NOW,
    finishedAt: NOW,
    error: null,
    outcome: "unchanged",
    toolCount: 3,
    machine: null,
    sourceKind: "remote",
    sourceRepo: null,
    sourcePath: null,
    sourceRef: null,
    schedule: "daily",
    upstreamDigest: null,
    latestVersion: null,
    pr: null,
    withheld: [],
    ...overrides,
  };
}

/** An in-memory store that keeps one row, so runs can follow each other. */
function fakeStore(
  options: {
    prior?: DiscoveryRow | null;
    serverId?: string | null | Error;
  } = {},
) {
  const state: { row: DiscoveryRow | null } = { row: options.prior ?? null };
  const serverId = options.serverId === undefined ? "srv-1" : options.serverId;
  const fns = {
    request: vi.fn<DiscoveryStore["request"]>(() => Promise.resolve()),
    begin: vi.fn<DiscoveryStore["begin"]>(
      (_scope, server, trigger, requestedBy, now) => {
        const before = state.row;
        const base =
          before ??
          row({
            server,
            startedAt: null,
            finishedAt: null,
            outcome: null,
            toolCount: null,
          });
        state.row = {
          ...base,
          status: "running",
          trigger,
          requestedBy: requestedBy ?? before?.requestedBy ?? null,
          startedAt: now,
        };
        return Promise.resolve(before);
      },
    ),
    recordSource: vi.fn<DiscoveryStore["recordSource"]>(() =>
      Promise.resolve(),
    ),
    finish: vi.fn<DiscoveryStore["finish"]>((_scope, server, finish, now) => {
      state.row = {
        ...(state.row ?? row({ server })),
        status: finish.status,
        outcome: finish.outcome,
        error: finish.error,
        toolCount: finish.toolCount,
        machine: finish.machine,
        upstreamDigest: finish.upstreamDigest,
        latestVersion: finish.latestVersion,
        pr: finish.pr,
        withheld: finish.withheld,
        finishedAt: now,
      };
      return Promise.resolve();
    }),
    read: vi.fn<DiscoveryStore["read"]>(() => Promise.resolve(state.row)),
    list: vi.fn<DiscoveryStore["list"]>(() =>
      Promise.resolve(state.row === null ? [] : [state.row]),
    ),
    steeringServerId: vi.fn<DiscoveryStore["steeringServerId"]>(() =>
      serverId instanceof Error
        ? Promise.reject(serverId)
        : Promise.resolve(serverId),
    ),
    captureSnapshots: vi.fn<DiscoveryStore["captureSnapshots"]>(
      (_scope, _id, descriptors) => Promise.resolve(descriptors.length),
    ),
  };
  const store: DiscoveryStore = { ...fns };
  return { fns, state, store };
}

type StoreFns = ReturnType<typeof fakeStore>["fns"];

/** The production branch as a map of paths, read at the time of each read. */
function fakeSteering(files: Record<string, string>) {
  const tree = new Map(Object.entries(files));
  const prs = new Map<number, { open: boolean; merged: boolean }>();
  const pullRequest = vi.fn<SteeringCheckout["pullRequest"]>((number) =>
    Promise.resolve(prs.get(number) ?? { open: true, merged: false }),
  );
  const checkout: SteeringCheckout = {
    commit: "9f1c2e4b7a0d3f6e8c5b2a1d4e7f0c3b6a9d2e5f",
    read: (path) => Promise.resolve(tree.get(path) ?? null),
    list: (dir) =>
      Promise.resolve(
        [...tree.keys()].filter((path) => path.startsWith(`${dir}/`)),
      ),
    pullRequest,
  };
  const open = vi.fn<SteeringFiles["open"]>(() => Promise.resolve(checkout));
  /** Merge a steering PR: write its files, and mark it merged. */
  const land = (input: ToolsPullRequestInput, number = 41): void => {
    for (const file of input.files) {
      if (file.content === null) tree.delete(file.path);
      else tree.set(file.path, file.content);
    }
    prs.set(number, { open: false, merged: true });
  };
  return { tree, prs, pullRequest, open, land };
}

/** What the fake MCP server answers. Change it between runs. */
interface Upstream {
  tools: readonly RawTool[];
  version?: string;
  fail?: Error;
  /** Every request gets this HTTP status and no body. */
  status?: number;
}

/** One request the fake Transport received. */
interface Sent {
  host: string;
  path: string;
  rpc: string | undefined;
  authorization: string | undefined;
}

interface RpcRequest {
  id?: number;
  method: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function answer(status: number, value?: unknown): HttpTransportResponse {
  const chunks =
    value === undefined ? [] : [encoder.encode(JSON.stringify(value))];
  const headers: HeaderEntry[] =
    value === undefined ? [] : [["Content-Type", "application/json"]];
  return {
    status,
    headers,
    body: {
      [Symbol.asyncIterator]() {
        let at = 0;
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            const chunk = chunks[at];
            at += 1;
            if (chunk === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: false, value: chunk });
          },
        };
      },
    },
    cancel: () => undefined,
  };
}

/** A Transport in front of one MCP server with no session id. */
function fakeTransport(upstream: Upstream) {
  const sent: Sent[] = [];
  const http = vi.fn<Transport["http"]>((request: HttpTransportRequest) => {
    const rpc =
      request.body.byteLength === 0
        ? undefined
        : (JSON.parse(decoder.decode(request.body)) as RpcRequest);
    sent.push({
      host: request.target.host,
      path: request.target.path,
      rpc: rpc?.method,
      authorization: request.headers.find(
        ([name]) => name === "Authorization",
      )?.[1],
    });
    if (upstream.fail !== undefined) return Promise.reject(upstream.fail);
    if (upstream.status !== undefined) {
      return Promise.resolve(answer(upstream.status));
    }
    if (rpc?.method === "initialize") {
      return Promise.resolve(
        answer(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: {
              name: "upstream",
              version: upstream.version ?? "2026.09.1",
            },
          },
        }),
      );
    }
    if (rpc?.method === "tools/list") {
      return Promise.resolve(
        answer(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { tools: upstream.tools },
        }),
      );
    }
    return Promise.resolve(answer(202));
  });
  const transport: Transport = {
    http,
    grpc: () => Promise.reject(new Error("Discovery sends no gRPC call.")),
    local: () => Promise.reject(new Error("Discovery runs no local call.")),
  };
  return { http, sent, transport };
}

function fakeCredentials(
  answer: ResolvedCredential = { type: "bearer", token: SECRET },
) {
  const resolve = vi.fn<CredentialSource["resolve"]>(() =>
    Promise.resolve(answer),
  );
  const credentials: DiscoveryCredentials = () => ({ resolve });
  return { resolve, credentials };
}

function fakeOpener(fail?: Error) {
  const open = vi.fn<ToolsPullRequestOpener["open"]>((_scope, input) =>
    fail === undefined
      ? Promise.resolve({
          number: 41,
          url: PR_URL,
          branch: input.branch,
          headSha: HEAD_SHA,
        })
      : Promise.reject(fail),
  );
  return { open, opener: { open } };
}

interface HarnessOptions {
  server?: string;
  files?: Record<string, string>;
  tools?: readonly RawTool[];
  prior?: DiscoveryRow | null;
  serverId?: string | null | Error;
  credential?: ResolvedCredential;
  credentials?: DiscoveryCredentials;
  entry?: RegistryEntry;
  opener?: ToolsPullRequestOpener;
  openerFails?: Error;
}

/** Every fake wired into one set of seams, and a run() over them. */
function harness(options: HarnessOptions = {}) {
  const upstream: Upstream = { tools: options.tools ?? STRIPE_UPSTREAM };
  const steering = fakeSteering(options.files ?? stripeTree());
  const creds = fakeCredentials(options.credential);
  const wire = fakeTransport(upstream);
  const entry = options.entry;
  const catalog = vi.fn<RegistryCatalog["entry"]>(() =>
    entry === undefined
      ? Promise.reject(new Error("This case has no catalog."))
      : Promise.resolve(entry),
  );
  const report = vi.fn<LocalToolsReporter["report"]>(() =>
    Promise.resolve({
      machine: "mac-01",
      server_version: "2026.8.1",
      tools: [],
    }),
  );
  const pr = fakeOpener(options.openerFails);
  const clock = { now: NOW };
  const db = fakeStore({
    prior: options.prior ?? null,
    serverId: options.serverId,
  });
  const seams: DiscoverySeams = {
    steering: { open: steering.open },
    credentials: options.credentials ?? creds.credentials,
    transport: () => wire.transport,
    local: { report },
    grpc: noGrpcDiscovery,
    definitions: {
      read: () => Promise.reject(new Error("This case reads no definition.")),
    },
    catalog: { entry: catalog },
    opener: options.opener ?? pr.opener,
    now: () => clock.now,
  };
  const server = options.server ?? "stripe";
  const run = (
    trigger: DiscoveryTrigger,
    input: { requestedBy?: string; signal?: AbortSignal } = {},
  ) =>
    runDiscovery(
      { scope: SCOPE, server, trigger, ...input },
      { seams, store: db.store },
    );
  return {
    upstream,
    steering,
    creds,
    wire,
    catalog,
    report,
    pr,
    clock,
    db,
    seams,
    run,
  };
}

/** The finish of the last run. */
function lastFinish(fns: StoreFns): DiscoveryFinish {
  const call = fns.finish.mock.calls.at(-1);
  if (call === undefined) throw new Error("The run never called finish.");
  return call[2];
}

function snapshotNames(fns: StoreFns): string[] {
  return fns.captureSnapshots.mock.calls.flatMap(([, , descriptors]) =>
    descriptors.map((descriptor) => descriptor.name),
  );
}

/** What the run threw. Fails the case when the run resolves. */
async function thrownBy(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`The run threw something that is not an Error: ${String(error)}`);
  }
  throw new Error("The run resolved, and it should have thrown.");
}

/** The forms of SECRET that appear anywhere in the values. */
function leaks(...values: unknown[]): string[] {
  const text = JSON.stringify(values);
  return SECRET_FORMS.filter((form) => text.includes(form));
}

/** Every call the run made to the store, the logger, and the opener. */
function recorded(
  fns: StoreFns,
  open: Mock<ToolsPullRequestOpener["open"]>,
): unknown[] {
  return [
    ...Object.values(fns).map((fn) => fn.mock.calls),
    logs.warn.mock.calls,
    logs.error.mock.calls,
    logs.info.mock.calls,
    logs.debug.mock.calls,
    open.mock.calls,
  ];
}

// ── A run with no opener ─────────────────────────────────────────────────────

describe("runDiscovery with no opener installed", () => {
  it("fails with no_opener and keeps the changed tool withheld", async () => {
    const h = harness({
      tools: [REFUND_NEEDS_CURRENCY, LIST_CHARGES, CREATE_CUSTOMER],
      opener: noToolsPullRequestOpener,
    });

    const result = await h.run("manual");

    expect(result).toEqual({
      server: "stripe",
      status: "failed",
      outcome: null,
      toolCount: 3,
      withheld: ["stripe__create_refund"],
      pr: null,
      error: NO_OPENER,
    });
    expect(h.db.fns.finish).toHaveBeenCalledTimes(1);
    expect(lastFinish(h.db.fns)).toMatchObject({
      status: "failed",
      outcome: null,
      error: NO_OPENER,
      pr: null,
      withheld: ["stripe__create_refund"],
      withheldUpstream: ["create_refund"],
      offered: ["create_refund", "list_charges", "create_customer"],
    });
    expect(h.db.fns.captureSnapshots).toHaveBeenCalledWith(
      SCOPE,
      "srv-1",
      expect.any(Array),
    );
    expect(snapshotNames(h.db.fns)).toEqual([
      "create_refund",
      "list_charges",
      "create_customer",
    ]);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        workspaceId: WS,
        server: "stripe",
        trigger: "manual",
        error: NO_OPENER,
        code: "no_opener",
      }),
      "MCP discovery refused",
    );
    expect(logs.error).not.toHaveBeenCalled();
    expect(leaks(recorded(h.db.fns, h.pr.open))).toEqual([]);
  });
});

// ── Failures a retry can pass ────────────────────────────────────────────────

describe("runDiscovery when a retry can pass", () => {
  it.each<[string, Partial<Upstream>, string]>([
    [
      "a connection that failed before the request left",
      {
        fail: new TransportError(
          "not_sent",
          `connect ECONNREFUSED, sent Bearer ${SECRET}`,
          false,
        ),
      },
      `The request to mcp.stripe.com failed: connect ECONNREFUSED, sent Bearer ${REDACTED}`,
    ],
    [
      "an HTTP 503",
      { status: 503 },
      "mcp.stripe.com answered initialize with HTTP 503.",
    ],
    [
      "an HTTP 429",
      { status: 429 },
      "mcp.stripe.com answered initialize with HTTP 429.",
    ],
    [
      "an error the transport did not expect",
      { fail: new Error("socket hang up") },
      "The request to mcp.stripe.com failed: socket hang up",
    ],
  ])(
    "records %s on the row, then throws so the function retries",
    async (_label, reply, error) => {
      const h = harness();
      Object.assign(h.upstream, reply);

      const thrown = await thrownBy(h.run("schedule"));

      expect(thrown).toBeInstanceOf(RetriableDiscoveryFailure);
      expect(thrown.message).toBe(`MCP discovery of stripe failed: ${error}`);
      expect(h.db.fns.finish).toHaveBeenCalledTimes(1);
      expect(lastFinish(h.db.fns)).toMatchObject({
        status: "failed",
        outcome: null,
        error,
        pr: null,
      });
      expect(h.db.state.row?.status).toBe("failed");
      expect(logs.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: "stripe", code: "source", error }),
        "MCP discovery refused",
      );
      expect(h.pr.open).not.toHaveBeenCalled();
      expect(leaks(thrown.message, recorded(h.db.fns, h.pr.open))).toEqual([]);
    },
  );

  it("records a sync steering PR that did not open, then throws so the function retries", async () => {
    const h = harness({
      tools: [REFUND_NEEDS_CURRENCY, LIST_CHARGES, CREATE_CUSTOMER],
      openerFails: new Error(`GitHub answered HTTP 502 to Bearer ${SECRET}`),
    });
    const error = `The sync steering PR for stripe did not open: GitHub answered HTTP 502 to Bearer ${REDACTED}`;

    const thrown = await thrownBy(h.run("list_changed"));

    expect(thrown).toBeInstanceOf(RetriableDiscoveryFailure);
    expect(thrown.message).toBe(`MCP discovery of stripe failed: ${error}`);
    expect(h.pr.open).toHaveBeenCalledTimes(1);
    expect(lastFinish(h.db.fns)).toMatchObject({
      status: "failed",
      outcome: null,
      error,
      pr: null,
      withheld: ["stripe__create_refund"],
      withheldUpstream: ["create_refund"],
    });
    expect(snapshotNames(h.db.fns)).toEqual([
      "create_refund",
      "list_charges",
      "create_customer",
    ]);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "opener", error }),
      "MCP discovery refused",
    );
    expect(leaks(thrown.message, recorded(h.db.fns, h.pr.open))).toEqual([]);
  });
});

// ── Failures a retry cannot pass ─────────────────────────────────────────────

describe("runDiscovery when a retry fails the same way", () => {
  it.each<[string, Partial<Upstream>, string]>([
    [
      "an HTTP 401",
      { status: 401 },
      "mcp.stripe.com answered initialize with HTTP 401.",
    ],
    [
      "an HTTP 404",
      { status: 404 },
      "mcp.stripe.com answered initialize with HTTP 404.",
    ],
    [
      "a private address",
      {
        fail: new TransportError(
          "refused_address",
          "mcp.stripe.com resolves to a private address.",
          false,
        ),
      },
      "The request to mcp.stripe.com failed: mcp.stripe.com resolves to a private address.",
    ],
  ])("resolves %s as a failed discovery", async (_label, reply, error) => {
    const h = harness();
    Object.assign(h.upstream, reply);

    const result = await h.run("schedule");

    expect(result).toEqual({
      server: "stripe",
      status: "failed",
      outcome: null,
      toolCount: null,
      withheld: [],
      pr: null,
      error,
    });
    expect(h.db.state.row?.status).toBe("failed");
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("resolves a credential it cannot place", async () => {
    const h = harness({ credential: { type: "bearer", token: "abc" } });

    const result = await h.run("manual");

    expect(result).toMatchObject({ status: "failed", outcome: null });
    expect(result.error).toBe(
      "The access token is shorter than 4 characters, so discovery cannot keep it out of what it writes.",
    );
    expect(h.wire.http).not.toHaveBeenCalled();
  });
});
