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
import type { DiscoveryScope, DiscoveryTrigger } from "./types";

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

/** The production commit every read in a run is pinned to. */
const STEERING_COMMIT = "9f1c2e4b7a0d3f6e8c5b2a1d4e7f0c3b6a9d2e5f";
/** The head of an open sync PR's branch, which a commit onto it is pinned to. */
const PR_HEAD = "4c7e1a90b2d5f83e6017c4b9a2d8e5f30c6b1a94";

/** The production branch as a map of paths, read at the time of each read. */
function fakeSteering(files: Record<string, string>) {
  const tree = new Map(Object.entries(files));
  const prs = new Map<
    number,
    { open: boolean; merged: boolean; headSha: string | null }
  >();
  const pullRequest = vi.fn<SteeringCheckout["pullRequest"]>((number) =>
    Promise.resolve(
      prs.get(number) ?? { open: true, merged: false, headSha: PR_HEAD },
    ),
  );
  const checkout: SteeringCheckout = {
    commit: STEERING_COMMIT,
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
    prs.set(number, { open: false, merged: true, headSha: PR_HEAD });
  };
  return { tree, prs, pullRequest, open, land };
}

/** What the fake MCP server answers. Change it between runs. */
interface Upstream {
  tools: readonly RawTool[];
  version?: string;
  fail?: Error;
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

// ── What each write is pinned to ─────────────────────────────────────────────

describe("runDiscovery pins the steering PR's commit", () => {
  /** A prior row whose sync PR #41 is still open on its branch. */
  function priorWithOpenPr(): DiscoveryRow {
    return row({
      outcome: "pr_opened",
      pr: { number: 41, url: PR_URL, branch: "tools/sync-stripe-earlier" },
    });
  }

  it("starts a new branch at the production commit it read the files from", async () => {
    const h = harness({ tools: [REFUND_NEEDS_CURRENCY, LIST_CHARGES] });

    await h.run("manual");

    expect(h.pr.open).toHaveBeenCalledTimes(1);
    const input = h.pr.open.mock.calls[0]?.[1];
    // Without this, the opener starts the branch at whatever production is
    // now, and the whole-file writes revert anything merged in between.
    expect(input?.at).toBe(STEERING_COMMIT);
    expect(input?.existing).toBeUndefined();
  });

  it("pins a commit onto an open PR to that branch's head", async () => {
    const h = harness({
      tools: [REFUND_NEEDS_CURRENCY, LIST_CHARGES],
      prior: priorWithOpenPr(),
    });

    await h.run("manual");

    expect(h.pr.open).toHaveBeenCalledTimes(1);
    const input = h.pr.open.mock.calls[0]?.[1];
    // The branch's head, not the production commit: the opener's guard
    // compares this against the head of the branch it commits to.
    expect(input?.at).toBe(PR_HEAD);
    expect(input?.existing).toEqual({ number: 41 });
  });

  it("sends no pin for an open PR whose branch head the host does not know", async () => {
    const h = harness({
      tools: [REFUND_NEEDS_CURRENCY, LIST_CHARGES],
      prior: priorWithOpenPr(),
    });
    h.steering.prs.set(41, { open: true, merged: false, headSha: null });

    await h.run("manual");

    // Fail open: the commit goes unpinned, as every commit did before the
    // head was read, rather than refusing the update.
    expect(h.pr.open).toHaveBeenCalledTimes(1);
    const input = h.pr.open.mock.calls[0]?.[1];
    expect(input?.existing).toEqual({ number: 41 });
    expect(input?.at).toBeUndefined();
  });
});

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
