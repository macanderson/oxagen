// sources.test.ts: discover() for each kind of source, and the helpers sync
// uses beside it (lane M10, #4682). Every seam is a fake: the Transport, the
// credential source, the steering checkout, the definition reader, the
// registry catalog, the local reporter, and the gRPC importer. Each case that
// places a credential checks that no form of the secret appears in what
// discover returns or in the refusal it throws.
import { describe, expect, it, vi } from "vitest";
import {
  documentHash,
  upstreamFromMcpTool,
  type CredentialSource,
  type HeaderEntry,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type ImportResult,
  type ManifestAuth,
  type ManifestServer,
  type McpLockSource,
  type McpServer,
  type McpTool,
  type RegistryEntry,
  type ResolvedCredential,
  type ServerSource,
  type Transport,
} from "@oxagen/mcp-studio";
import { createScrubber, REDACTED, scrubValue } from "./scrub";
import {
  noLocalReporter,
  noToolsPullRequestOpener,
  type DefinitionReader,
  type DiscoveryCredentials,
  type DiscoverySeams,
  type GrpcImporter,
  type LocalToolsReport,
  type LocalToolsReporter,
  type RegistryCatalog,
  type SteeringCheckout,
} from "./seams";
import {
  discover,
  NeedsDigest,
  servedDescriptorSet,
  snapshotsOf,
  utc,
  withServerVersion,
  type SourceContext,
} from "./sources";
import {
  DiscoveryRefused,
  type DiscoveryScope,
  type DiscoveryTrigger,
} from "./types";

// ── Builders ─────────────────────────────────────────────────────────────────

const ORG = "0191d0a0-0000-7000-8000-000000000001";
const WS = "0191d0a0-0000-7000-8000-000000000002";
const SCOPE: DiscoveryScope = { orgId: ORG, workspaceId: WS };
const NOW = new Date("2026-09-28T15:00:12Z");
/** NOW as the diff header prints it. */
const STAMP = "2026-09-28 15:00 UTC";
/** The steering checkout's commit. */
const COMMIT = "9f1c2e4b7a0d3f6e8c5b2a1d4e7f0c3b6a9d2e5f";

/** The service token the fake vault returns. */
const SECRET = "sk_live_SECRET_123456";
/** The token of the person who asked for the run. */
const OPERATOR_TOKEN = "gho_operator_7c1e9a4f2b";

/** A secret as a request can carry it: raw, percent-encoded, and base64. */
function formsOf(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret, "utf8").toString("base64"),
  ];
}

/** Each form of the secret that appears in any of the values. */
function leaks(secret: string, ...values: unknown[]): string[] {
  const text = values
    .map((value) =>
      typeof value === "string" ? value : JSON.stringify(value),
    )
    .join("\n");
  return formsOf(secret).filter((form) => text.includes(form));
}

/** The DiscoveryRefused a pending discover rejects with. */
async function refusal(pending: Promise<unknown>): Promise<DiscoveryRefused> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof DiscoveryRefused) return error;
    throw error;
  }
  throw new Error("expected discover to reject");
}

// ── The fake Transport ───────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A reply with a body, or with none. */
function answer(
  status: number,
  body?: string,
  type = "application/json",
): HttpTransportResponse {
  const chunks = body === undefined ? [] : [encoder.encode(body)];
  const headers: HeaderEntry[] =
    body === undefined ? [] : [["Content-Type", type]];
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

function json(status: number, value: unknown): HttpTransportResponse {
  return answer(status, JSON.stringify(value));
}

interface RpcBody {
  id?: number;
  method?: string;
}

/** One request the fake Transport received. */
interface Sent {
  method: string;
  host: string;
  path: string;
  headers: HeaderEntry[];
  body: string;
  /** The JSON-RPC method, when the body names one. */
  rpc: string | undefined;
  id: number | undefined;
}

function sentOf(request: HttpTransportRequest): Sent {
  const body = decoder.decode(request.body);
  const parsed = body === "" ? undefined : (JSON.parse(body) as RpcBody);
  return {
    method: request.target.method,
    host: request.target.host,
    path: request.target.path,
    headers: [...request.headers],
    body,
    rpc: parsed?.method,
    id: parsed?.id,
  };
}

function header(sent: Sent | undefined, name: string): string | undefined {
  return sent?.headers.find(([key]) => key === name)?.[1];
}

/** The request's path and headers, as an upstream error might quote them. */
function quoted(sent: Sent | undefined): string {
  if (sent === undefined) return "";
  const headers = sent.headers.map(([key, value]) => `${key}: ${value}`);
  return `${sent.path} ${headers.join(", ")}`;
}

/** How the fake upstream answers one request. An Error rejects it. */
type Route = (sent: Sent) => HttpTransportResponse | Error;

/** A transport failure whose text quotes the request, secret and all. */
const echoFailure: Route = (sent) => new Error(`upstream saw ${quoted(sent)}`);

function fakeTransport(route: Route) {
  const sent: Sent[] = [];
  const http = vi.fn<Transport["http"]>((request: HttpTransportRequest) => {
    const one = sentOf(request);
    sent.push(one);
    const reply = route(one);
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply);
  });
  const transport: Transport = {
    http,
    grpc: () => Promise.reject(new Error("Discovery sends no gRPC call.")),
    local: () => Promise.reject(new Error("Discovery runs no local call.")),
  };
  return { sent, transport };
}

/**
 * An MCP server with no session id that lists these tools. Its initialize
 * reports version, or no version for null.
 */
function mcpServer(
  tools: readonly McpTool[],
  version: string | null = "2026.09.1",
): Route {
  return (sent) => {
    if (sent.rpc === "initialize") {
      return json(200, {
        jsonrpc: "2.0",
        id: sent.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo:
            version === null
              ? { name: "upstream" }
              : { name: "upstream", version },
        },
      });
    }
    if (sent.rpc === "tools/list") {
      return json(200, { jsonrpc: "2.0", id: sent.id, result: { tools } });
    }
    return answer(202);
  };
}

// ── Servers ──────────────────────────────────────────────────────────────────

const LIST_CHARGES: McpTool = {
  name: "list_charges",
  description: "List charges, newest first.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" } },
  },
  annotations: { readOnlyHint: true },
};

const CREATE_CUSTOMER: McpTool = {
  name: "create_customer",
  inputSchema: { type: "object" },
};

const TOOLS: readonly McpTool[] = [LIST_CHARGES, CREATE_CUSTOMER];

function offered(tools: readonly McpTool[]) {
  return tools.map((tool) => upstreamFromMcpTool(tool));
}

const SERVICE_BEARER: ManifestAuth = {
  mode: "service",
  scheme: "bearer",
  apply: { type: "http_bearer" },
};

const OPERATOR_OAUTH: ManifestAuth = {
  mode: "operator-oauth",
  scheme: "oauth",
  apply: { type: "oauth2" },
};

const STRIPE_URL = "https://mcp.stripe.com";
const TEST_URL = "https://test.mcp.stripe.com/mcp";
const LIVE_URL = "https://live.mcp.stripe.com/mcp";
const TEST_CREDENTIAL = "oxagen:credential/stripe-test";

const STRIPE: ServerSource = {
  type: "remote",
  url: STRIPE_URL,
  transport: "http",
};

const STRIPE_LOCK: McpLockSource = {
  type: "remote",
  url: STRIPE_URL,
  server_version: "2026.08.4",
};

type Environments = ManifestServer["environments"];

/** live is listed first, and test is the sandbox. */
const STRIPE_ENVS: Environments = {
  live: {
    sandbox: false,
    url: LIVE_URL,
    network: "cloud",
    credential: "oxagen:credential/stripe-live",
  },
  test: {
    sandbox: true,
    url: TEST_URL,
    network: "cloud",
    credential: TEST_CREDENTIAL,
  },
};

const BEARER: ResolvedCredential = { type: "bearer", token: SECRET };

interface Setup {
  source: ServerSource;
  server?: string;
  trigger?: DiscoveryTrigger;
  requestedBy?: string;
  /** server.toml's auth as compiled. Null for a server with none. */
  auth?: ManifestAuth | null;
  environments?: Environments;
  /** server.toml's own environments, before defaults. */
  parsedEnvironments?: McpServer["environments"];
  /** The served lock's source. */
  lock?: McpLockSource;
  route?: Route;
  credential?: ResolvedCredential;
  /** Files on the production branch, by path. */
  files?: Record<string, string>;
  seams?: Partial<DiscoverySeams>;
}

/** A SourceContext over fakes, with the fakes a case inspects. */
function setup(options: Setup) {
  const server = options.server ?? "stripe";
  const wire = fakeTransport(options.route ?? mcpServer(TOOLS));
  const resolve = vi.fn<CredentialSource["resolve"]>(() =>
    Promise.resolve(options.credential ?? BEARER),
  );
  const credentials = vi.fn<DiscoveryCredentials>(() => ({ resolve }));
  const files = new Map(Object.entries(options.files ?? {}));
  const read = vi.fn<SteeringCheckout["read"]>((path) =>
    Promise.resolve(files.get(path) ?? null),
  );
  const checkout: SteeringCheckout = {
    commit: COMMIT,
    read,
    list: () => Promise.resolve([...files.keys()]),
    pullRequest: () =>
      Promise.resolve({ open: true, merged: false, headSha: null }),
  };
  const seams: DiscoverySeams = {
    steering: { open: () => Promise.resolve(checkout) },
    credentials,
    transport: () => wire.transport,
    local: noLocalReporter,
    grpc: () => Promise.reject(new Error("This case imports no .proto files.")),
    definitions: {
      read: () => Promise.reject(new Error("This case reads no definition.")),
    },
    catalog: {
      entry: () => Promise.reject(new Error("This case reads no catalog.")),
    },
    opener: noToolsPullRequestOpener,
    now: () => NOW,
    ...options.seams,
  };
  const lock = options.lock ?? STRIPE_LOCK;
  const ctx: SourceContext = {
    scope: SCOPE,
    server,
    trigger: options.trigger ?? "schedule",
    requestedBy: options.requestedBy,
    parsed: {
      schema: "mcp-server/v1",
      name: server,
      label: "Upstream",
      description: "The server under test.",
      source: options.source,
      environments: options.parsedEnvironments,
      exposure: { mode: "direct" },
      sync: { schedule: "daily" },
    },
    served: {
      name: server,
      label: "Upstream",
      description: "The server under test.",
      source: options.source,
      pinned: lock,
      auth: options.auth === undefined ? SERVICE_BEARER : options.auth,
      environments: options.environments ?? STRIPE_ENVS,
      exposure: { mode: "direct", definition_budget: 8000 },
      tokens: { definitions: 0, request: 0 },
      search: null,
      tools: {},
    },
    servedLock: {
      schema: "mcp-tools-lock/v1",
      server,
      source: lock,
      tools: {},
    },
    checkout,
    seams,
    scrubber: createScrubber(),
    signal: new AbortController().signal,
  };
  return { ctx, sent: wire.sent, resolve, credentials, read };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

describe("utc", () => {
  it("prints the time to the minute in UTC", () => {
    expect(utc(NOW)).toBe(STAMP);
  });

  it("converts a time from another zone to UTC", () => {
    expect(utc(new Date("2026-09-28T23:59:59-05:00"))).toBe(
      "2026-09-29 04:59 UTC",
    );
  });
});

describe("snapshotsOf", () => {
  it("keeps each tool's name, description, schema, and annotations", () => {
    expect(snapshotsOf(offered([LIST_CHARGES]))).toEqual([
      {
        name: "list_charges",
        description: "List charges, newest first.",
        inputSchema: LIST_CHARGES.inputSchema,
        annotations: { readOnlyHint: true },
      },
    ]);
  });

  it("writes null for no description and leaves annotations out", () => {
    const [row] = snapshotsOf(offered([CREATE_CUSTOMER]));
    expect(row).toEqual({
      name: "create_customer",
      description: null,
      inputSchema: { type: "object" },
    });
    expect(row).not.toHaveProperty("annotations");
  });

  it("keeps the order of the tools", () => {
    const rows = snapshotsOf(offered([CREATE_CUSTOMER, LIST_CHARGES]));
    expect(rows.map((row) => row.name)).toEqual([
      "create_customer",
      "list_charges",
    ]);
  });

  it("writes no rows for no tools", () => {
    expect(snapshotsOf([])).toEqual([]);
  });
});

describe("withServerVersion", () => {
  it("records the version the server reported", () => {
    expect(withServerVersion(STRIPE_LOCK, "2026.09.1")).toEqual({
      type: "remote",
      url: STRIPE_URL,
      server_version: "2026.09.1",
    });
  });

  it("drops the pinned version when the server reports none", () => {
    const out = withServerVersion(STRIPE_LOCK, undefined);
    expect(out).toEqual({ type: "remote", url: STRIPE_URL });
    expect(out).not.toHaveProperty("server_version");
  });

  it("leaves the lock source it was given alone", () => {
    withServerVersion(STRIPE_LOCK, undefined);
    withServerVersion(STRIPE_LOCK, "2026.09.1");
    expect(STRIPE_LOCK.server_version).toBe("2026.08.4");
  });
});

describe("NeedsDigest", () => {
  it("is a needs_digest refusal that names the version and the fix", () => {
    const error = new NeedsDigest("io.github.acme/files", "1.4.0");
    expect(error).toBeInstanceOf(DiscoveryRefused);
    expect(error.name).toBe("NeedsDigest");
    expect(error.code).toBe("needs_digest");
    expect(error.latestVersion).toBe("1.4.0");
    expect(error.message).toBe(
      "io.github.acme/files 1.4.0 is in the catalog. It runs on machines, " +
        "so its lock needs the package's digest. Import the new version " +
        "in Studio.",
    );
  });
});

// ── Remote servers ───────────────────────────────────────────────────────────

describe("discover a remote server", () => {
  it("lists tools at the sandbox with the service credential", async () => {
    const { ctx, sent, resolve, credentials } = setup({ source: STRIPE });
    const found = await discover(ctx);

    expect(sent.map((one) => one.rpc)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    for (const one of sent) {
      expect(one.method).toBe("POST");
      expect(one.host).toBe("test.mcp.stripe.com");
      expect(one.path).toBe("/mcp");
      expect(header(one, "Authorization")).toBe(`Bearer ${SECRET}`);
    }
    expect(credentials).toHaveBeenCalledWith(SCOPE);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      {
        server: "stripe",
        environment: "test",
        reference: TEST_CREDENTIAL,
        auth: SERVICE_BEARER,
        operator: undefined,
      },
      ctx.signal,
    );
    expect(found).toEqual({
      offered: offered(TOOLS),
      lockSource: {
        type: "remote",
        url: STRIPE_URL,
        server_version: "2026.09.1",
      },
      securitySchemes: {},
      descriptorSet: undefined,
      version: undefined,
      latestVersion: undefined,
      files: [],
      machine: null,
      origin: `tools/list changed at ${STAMP}`,
    });
    expect(leaks(SECRET, found)).toEqual([]);
  });

  it("lists an operator-oauth server with the asker's own token", async () => {
    const { ctx, sent, resolve } = setup({
      source: STRIPE,
      auth: OPERATOR_OAUTH,
      environments: {
        test: { sandbox: true, url: TEST_URL, network: "cloud" },
      },
      requestedBy: "user-ada",
      credential: { type: "bearer", token: OPERATOR_TOKEN },
    });
    const found = await discover(ctx);

    expect(resolve).toHaveBeenCalledWith(
      {
        server: "stripe",
        environment: "test",
        reference: undefined,
        auth: OPERATOR_OAUTH,
        operator: "user-ada",
      },
      ctx.signal,
    );
    expect(header(sent[0], "Authorization")).toBe(`Bearer ${OPERATOR_TOKEN}`);
    expect(found.offered).toEqual(offered(TOOLS));
    expect(leaks(OPERATOR_TOKEN, found)).toEqual([]);
  });

  it("records no server version when initialize reports none", async () => {
    const { ctx } = setup({ source: STRIPE, route: mcpServer(TOOLS, null) });
    const found = await discover(ctx);

    expect(found.lockSource).toEqual({ type: "remote", url: STRIPE_URL });
    expect(found.lockSource).not.toHaveProperty("server_version");
  });

  it("refuses a server with no sandbox environment", async () => {
    const { ctx, sent, resolve } = setup({
      source: STRIPE,
      environments: {
        live: { sandbox: false, url: LIVE_URL, network: "cloud" },
      },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      "stripe has no sandbox environment to discover from.",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses a sandbox with no url before any credential", async () => {
    const { ctx, resolve } = setup({
      source: STRIPE,
      environments: { test: { sandbox: true, network: "cloud" } },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe("The test environment of stripe names no url.");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a sandbox on a relay network", async () => {
    const { ctx, sent } = setup({
      source: STRIPE,
      environments: {
        test: { sandbox: true, url: TEST_URL, network: "relay:office" },
      },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("unsupported");
    expect(error.message).toBe(
      "Discovery through a relay is not available yet.",
    );
    expect(sent).toEqual([]);
  });

  it("scrubs the token from a transport error that quotes it", async () => {
    const { ctx, sent } = setup({ source: STRIPE, route: echoFailure });
    const error = await refusal(discover(ctx));

    expect(quoted(sent[0])).toContain(`Authorization: Bearer ${SECRET}`);
    expect(error.code).toBe("source");
    expect(error.retriable).toBe(true);
    expect(error.message).toMatch(
      /^The request to test\.mcp\.stripe\.com failed: upstream saw /,
    );
    expect(error.message).toContain(`Authorization: Bearer ${REDACTED}`);
    expect(leaks(SECRET, error.message)).toEqual([]);
  });

  it("scrubs the token from a tools/list error that quotes it", async () => {
    const upstream = mcpServer(TOOLS);
    const { ctx } = setup({
      source: STRIPE,
      route: (sent) =>
        sent.rpc === "tools/list"
          ? json(200, {
              jsonrpc: "2.0",
              id: sent.id,
              error: {
                code: -32001,
                message: `${header(sent, "Authorization")} is revoked.`,
              },
            })
          : upstream(sent),
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      `The MCP server refused tools/list: Bearer ${REDACTED} is revoked. ` +
        "(code -32001)",
    );
    expect(leaks(SECRET, error.message)).toEqual([]);
  });

  it.each([
    { status: 401, retriable: false },
    { status: 503, retriable: true },
  ])(
    "refuses HTTP $status from initialize with retriable $retriable",
    async ({ status, retriable }) => {
      const { ctx } = setup({ source: STRIPE, route: () => answer(status) });
      const error = await refusal(discover(ctx));

      expect(error.code).toBe("source");
      expect(error.retriable).toBe(retriable);
      expect(error.message).toBe(
        `test.mcp.stripe.com answered initialize with HTTP ${status}.`,
      );
    },
  );

  // discover returns the upstream's text as the upstream sent it. sync
  // scrubs the offered tools with the run's scrubber before it builds a
  // snapshot row, so this case pins the handoff: the scrubber discover
  // filled is the one that cleans the rows.
  it("returns upstream text as sent and fills the run's scrubber", async () => {
    const echo: McpTool = {
      ...LIST_CHARGES,
      description: `Calls Stripe with ${SECRET}.`,
    };
    const { ctx } = setup({ source: STRIPE, route: mcpServer([echo]) });
    const found = await discover(ctx);

    expect(found.offered[0]?.description).toBe(`Calls Stripe with ${SECRET}.`);
    const rows = snapshotsOf(scrubValue(ctx.scrubber, found.offered));
    expect(rows[0]?.description).toBe(`Calls Stripe with ${REDACTED}.`);
    expect(leaks(SECRET, rows)).toEqual([]);
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

/** Where one kind of credential goes, and what a refusal may show of it. */
interface Placement {
  kind: string;
  auth: ManifestAuth;
  credential: ResolvedCredential;
  /** The request text that carries the secret. */
  seen: string;
  /** The same text once the refusal is scrubbed. */
  shown: string;
  /** Every string no refusal may hold. */
  hidden: string[];
}

/** The basic pair for user ops, as the Authorization header carries it. */
const PAIR = Buffer.from(`ops:${SECRET}`, "utf8").toString("base64");

const PLACEMENTS: Placement[] = [
  {
    kind: "a bearer token",
    auth: SERVICE_BEARER,
    credential: BEARER,
    seen: `Authorization: Bearer ${SECRET}`,
    shown: `Authorization: Bearer ${REDACTED}`,
    hidden: formsOf(SECRET),
  },
  {
    kind: "a basic password",
    auth: { mode: "service", scheme: "basic", apply: { type: "http_basic" } },
    credential: { type: "basic", username: "ops", password: SECRET },
    seen: `Authorization: Basic ${PAIR}`,
    shown: `Authorization: Basic ${REDACTED}`,
    hidden: [...formsOf(SECRET), PAIR],
  },
  {
    kind: "an API key in a header",
    auth: {
      mode: "service",
      scheme: "api_key",
      apply: { type: "api_key", in: "header", name: "X-Api-Key" },
    },
    credential: { type: "api_key", value: SECRET },
    seen: `X-Api-Key: ${SECRET}`,
    shown: `X-Api-Key: ${REDACTED}`,
    hidden: formsOf(SECRET),
  },
  {
    kind: "an API key in the query",
    auth: {
      mode: "service",
      scheme: "api_key",
      apply: { type: "api_key", in: "query", name: "key" },
    },
    credential: { type: "api_key", value: SECRET },
    seen: `/mcp?key=${SECRET}`,
    shown: `/mcp?key=${REDACTED}`,
    hidden: formsOf(SECRET),
  },
];

describe("discover with each kind of credential", () => {
  it("sends no credential for a server with no auth", async () => {
    const { ctx, sent, credentials } = setup({ source: STRIPE, auth: null });
    const found = await discover(ctx);

    expect(credentials).not.toHaveBeenCalled();
    expect(sent).toHaveLength(3);
    for (const one of sent) {
      expect(header(one, "Authorization")).toBeUndefined();
    }
    expect(found.offered).toEqual(offered(TOOLS));
  });

  it("refuses an operator-oauth server nobody asked about", async () => {
    const { ctx, sent, resolve } = setup({
      source: STRIPE,
      auth: OPERATOR_OAUTH,
      environments: {
        test: { sandbox: true, url: TEST_URL, network: "cloud" },
      },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("credential");
    expect(error.message).toBe(
      "stripe uses each operator's own token. Run discovery from Studio, " +
        "and it lists the tools with yours.",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("lists operator-oauth with a stored credential and no asker", async () => {
    const { ctx, resolve } = setup({ source: STRIPE, auth: OPERATOR_OAUTH });
    const found = await discover(ctx);

    expect(resolve).toHaveBeenCalledWith(
      {
        server: "stripe",
        environment: "test",
        reference: TEST_CREDENTIAL,
        auth: OPERATOR_OAUTH,
        operator: undefined,
      },
      ctx.signal,
    );
    expect(found.offered).toEqual(offered(TOOLS));
  });

  it("turns a missing credential into a credential refusal", async () => {
    const { ctx, sent } = setup({
      source: STRIPE,
      credential: {
        type: "missing",
        message: "Connect your Stripe account in Oxagen, then retry.",
        connect_url: "https://app.oxagen.sh/connect/stripe",
      },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("credential");
    expect(error.message).toBe(
      "Connect your Stripe account in Oxagen, then retry.",
    );
    expect(sent).toEqual([]);
  });

  it("passes a vault failure through as it came", async () => {
    const failure = new Error("The vault did not answer.");
    const { ctx, sent } = setup({
      source: STRIPE,
      seams: {
        credentials: () => ({ resolve: () => Promise.reject(failure) }),
      },
    });

    await expect(discover(ctx)).rejects.toBe(failure);
    expect(sent).toEqual([]);
  });

  it.each(PLACEMENTS)(
    "scrubs $kind from a refusal that quotes the request",
    async ({ auth, credential, seen, shown, hidden }) => {
      const { ctx, sent } = setup({
        source: STRIPE,
        auth,
        credential,
        route: echoFailure,
      });
      const error = await refusal(discover(ctx));

      expect(quoted(sent[0])).toContain(seen);
      expect(error.code).toBe("source");
      expect(error.message).toContain(shown);
      for (const secret of hidden) {
        expect(error.message).not.toContain(secret);
      }
    },
  );
});

// ── Registry servers with no machines ────────────────────────────────────────

const REGISTRY = "https://registry.modelcontextprotocol.io";
const GITHUB_NAME = "io.github.github/github-mcp-server";
const GITHUB_URL = "https://api.githubcopilot.com/mcp/";
const GITHUB_NEXT_URL = "https://api.githubcopilot.com/mcp/v2/";
const GITHUB_SSE_URL = "https://api.githubcopilot.com/sse";

const GITHUB: ServerSource = {
  type: "registry",
  registry: REGISTRY,
  server: GITHUB_NAME,
  version: "0.18.0",
};

const GITHUB_LOCK: McpLockSource = {
  type: "registry",
  registry: REGISTRY,
  server: GITHUB_NAME,
  version: "0.18.0",
  url: GITHUB_URL,
  transport: "http",
  server_version: "0.18.0",
};

const GITHUB_ENVS: Environments = {
  default: {
    sandbox: true,
    url: GITHUB_URL,
    network: "cloud",
    credential: "oxagen:credential/github",
  },
};

type Remote = { type: string; url: string };

const STREAMABLE: Remote[] = [{ type: "streamable-http", url: GITHUB_URL }];

/** The catalog's entry for the GitHub server at one version. */
function githubEntry(
  version: string,
  remotes: Remote[],
  name: string = GITHUB_NAME,
): RegistryEntry {
  return {
    server: {
      name,
      description: "GitHub's official MCP server.",
      version,
      remotes,
    },
  };
}

/** The GitHub server, with a catalog whose newest entry is latest. */
function github(latest: RegistryEntry, options: Partial<Setup> = {}) {
  const entry = vi.fn<RegistryCatalog["entry"]>(() =>
    Promise.resolve(latest),
  );
  const run = setup({
    server: "github",
    lock: GITHUB_LOCK,
    environments: GITHUB_ENVS,
    ...options,
    source: options.source ?? GITHUB,
    seams: { catalog: { entry }, ...options.seams },
  });
  return { ...run, entry };
}

describe("discover a registry server with no machines", () => {
  it("lists the pinned endpoint when the catalog has not moved", async () => {
    const { ctx, sent, entry } = github(githubEntry("0.18.0", STREAMABLE), {
      route: mcpServer(TOOLS, "0.18.1"),
    });
    const found = await discover(ctx);

    expect(entry).toHaveBeenCalledWith(
      REGISTRY,
      GITHUB_NAME,
      "latest",
      ctx.signal,
    );
    expect(sent.map((one) => `${one.host}${one.path}`)).toEqual([
      "api.githubcopilot.com/mcp/",
      "api.githubcopilot.com/mcp/",
      "api.githubcopilot.com/mcp/",
    ]);
    expect(found).toEqual({
      offered: offered(TOOLS),
      lockSource: { ...GITHUB_LOCK, server_version: "0.18.1" },
      securitySchemes: {},
      descriptorSet: undefined,
      version: undefined,
      latestVersion: "0.18.0",
      files: [],
      machine: null,
      origin: `tools/list changed at ${STAMP}`,
    });
    expect(leaks(SECRET, found)).toEqual([]);
  });

  it.each<DiscoveryTrigger>(["schedule", "registry_version", "manual"])(
    "reads the catalog on a %s run",
    async (trigger) => {
      const { ctx, entry } = github(githubEntry("0.18.0", STREAMABLE), {
        trigger,
      });
      const found = await discover(ctx);

      expect(entry).toHaveBeenCalledTimes(1);
      expect(found.latestVersion).toBe("0.18.0");
    },
  );

  it.each<DiscoveryTrigger>(["list_changed", "push", "lock_merged"])(
    "leaves the catalog alone on a %s run",
    async (trigger) => {
      const { ctx, entry } = github(githubEntry("0.19.0", STREAMABLE), {
        trigger,
      });
      const found = await discover(ctx);

      expect(entry).not.toHaveBeenCalled();
      expect(found.latestVersion).toBeUndefined();
      expect(found.version).toBeUndefined();
      expect(found.lockSource).toEqual({
        ...GITHUB_LOCK,
        server_version: "2026.09.1",
      });
    },
  );

  it("lists the new entry's endpoint when the catalog moved on", async () => {
    const { ctx, sent } = github(
      githubEntry("0.19.0", [
        { type: "sse", url: GITHUB_SSE_URL },
        { type: "streamable-http", url: GITHUB_NEXT_URL },
      ]),
    );
    const found = await discover(ctx);

    expect(sent).toHaveLength(3);
    for (const one of sent) {
      expect(one.path).toBe("/mcp/v2/");
      expect(header(one, "Authorization")).toBe(`Bearer ${SECRET}`);
    }
    expect(found).toEqual({
      offered: offered(TOOLS),
      lockSource: {
        type: "registry",
        registry: REGISTRY,
        server: GITHUB_NAME,
        version: "0.19.0",
        url: GITHUB_NEXT_URL,
        transport: "http",
        server_version: "2026.09.1",
      },
      securitySchemes: {},
      descriptorSet: undefined,
      version: "0.19.0",
      latestVersion: "0.19.0",
      files: [],
      machine: null,
      origin: `${GITHUB_NAME} 0.19.0 is in the catalog`,
    });
    expect(leaks(SECRET, found)).toEqual([]);
  });

  // The request goes to the environment's own url, and the lock still
  // records the url the catalog entry names.
  it("keeps an environment's own url when the catalog moved on", async () => {
    const own = "https://github.internal.example.com/mcp";
    const { ctx, sent } = github(
      githubEntry("0.19.0", [
        { type: "streamable-http", url: GITHUB_NEXT_URL },
      ]),
      { parsedEnvironments: { default: { url: own } } },
    );
    const found = await discover(ctx);

    for (const one of sent) {
      expect(`${one.host}${one.path}`).toBe("github.internal.example.com/mcp");
    }
    expect(found.lockSource).toMatchObject({
      version: "0.19.0",
      url: GITHUB_NEXT_URL,
    });
  });

  it("refuses a new version that lists only an sse remote", async () => {
    const { ctx, sent } = github(
      githubEntry("0.19.0", [{ type: "sse", url: GITHUB_SSE_URL }]),
    );
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      `${GITHUB_NAME} 0.19.0 lists an sse remote and no streamable-http ` +
        "remote, and the gateway calls streamable-http only. Name " +
        "source.machines to run its package.",
    );
    expect(sent).toEqual([]);
  });

  it("refuses a new version that lists no remote", async () => {
    const { ctx, sent } = github(githubEntry("0.19.0", []));
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      `${GITHUB_NAME} 0.19.0 lists no streamable-http remote. Name ` +
        "source.machines to run its package.",
    );
    expect(sent).toEqual([]);
  });

  it("refuses a catalog entry for another server", async () => {
    const other = "io.github.acme/other-server";
    const { ctx, sent } = github(githubEntry("0.19.0", STREAMABLE, other));
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      `The catalog entry is ${other} 0.19.0, and server.toml names ` +
        `${GITHUB_NAME} 0.19.0.`,
    );
    expect(sent).toEqual([]);
  });

  // The lock check runs before tools/list, so no request carries the
  // credential to a server whose lock is wrong.
  it("refuses a served lock that is not a registry lock", async () => {
    const { ctx, sent } = github(githubEntry("0.18.0", STREAMABLE), {
      lock: STRIPE_LOCK,
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      "The lock for github is for a remote source, and server.toml names " +
        "a registry source.",
    );
    expect(sent).toEqual([]);
  });
});

// ── Local servers and registry packages ──────────────────────────────────────

const DIGEST = `sha256:${"a1".repeat(32)}`;

const FILES: ServerSource = {
  type: "local",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem@2026.9.0", "/srv"],
  machines: ["build-hosts"],
};

const FILES_LOCK: McpLockSource = {
  type: "local",
  command: "npx",
  package: {
    name: "@modelcontextprotocol/server-filesystem",
    version: "2026.9.0",
    digest: DIGEST,
  },
  server_version: "2026.8.0",
};

/** A server the local gateway runs has one environment, on local. */
const LOCAL_ENVS: Environments = {
  default: { sandbox: true, network: "local" },
};

const REPORT: LocalToolsReport = {
  machine: "mac-ada-01",
  server_version: "2026.9.0",
  tools: [LIST_CHARGES, CREATE_CUSTOMER],
};

/** A local gateway reporter that answers with one report. */
function reporter(answered: LocalToolsReport = REPORT) {
  const report = vi.fn<LocalToolsReporter["report"]>(() =>
    Promise.resolve(answered),
  );
  return { report, local: { report } };
}

/** The filesystem server, which runs on the build-hosts machines. */
function filesServer(options: Partial<Setup> = {}) {
  return setup({
    server: "files",
    auth: null,
    environments: LOCAL_ENVS,
    lock: FILES_LOCK,
    ...options,
    source: options.source ?? FILES,
  });
}

describe("discover a local server", () => {
  it("reads the tools a machine reported", async () => {
    const { report, local } = reporter();
    const { ctx, sent, credentials } = filesServer({ seams: { local } });
    const found = await discover(ctx);

    expect(report).toHaveBeenCalledWith({
      scope: SCOPE,
      server: "files",
      source: FILES,
      lockSource: FILES_LOCK,
      signal: ctx.signal,
    });
    expect(found).toEqual({
      offered: offered(TOOLS),
      lockSource: { ...FILES_LOCK, server_version: "2026.9.0" },
      securitySchemes: {},
      descriptorSet: undefined,
      version: undefined,
      latestVersion: undefined,
      files: [],
      machine: "mac-ada-01",
      origin: `tools/list changed at ${STAMP}`,
    });
    expect(sent).toEqual([]);
    expect(credentials).not.toHaveBeenCalled();
  });

  it("drops the server version when the machine reports none", async () => {
    const { local } = reporter({ ...REPORT, server_version: undefined });
    const { ctx } = filesServer({ seams: { local } });
    const found = await discover(ctx);

    expect(found.lockSource).toMatchObject({ type: "local", command: "npx" });
    expect(found.lockSource).not.toHaveProperty("server_version");
  });

  it("refuses while no local gateway reporter is installed", async () => {
    const { ctx } = filesServer();
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("unsupported");
    expect(error.message).toBe(
      "Discovery cannot reach the local gateway yet, so a server that runs " +
        "on machines is not discovered.",
    );
  });

  it("refuses a served lock that is not a local lock", async () => {
    const { report, local } = reporter();
    const { ctx } = filesServer({ lock: STRIPE_LOCK, seams: { local } });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      "The lock for files is for a remote source, and server.toml names " +
        "a local source.",
    );
    expect(report).not.toHaveBeenCalled();
  });
});

const ACME_NAME = "io.github.acme/files";

const ACME: ServerSource = {
  type: "registry",
  registry: REGISTRY,
  server: ACME_NAME,
  version: "1.3.0",
  machines: ["build-hosts"],
  registry_type: "npm",
};

const ACME_LOCK: McpLockSource = {
  type: "registry",
  registry: REGISTRY,
  server: ACME_NAME,
  version: "1.3.0",
  package: {
    name: "@acme/files-mcp",
    version: "1.3.0",
    digest: DIGEST,
    registry_type: "npm",
  },
  command: "npx",
  args: ["-y", "@acme/files-mcp@1.3.0"],
};

function acmeEntry(version: string): RegistryEntry {
  return {
    server: {
      name: ACME_NAME,
      description: "Files on a build host.",
      version,
    },
  };
}

/** The acme package on machines, with a catalog when latest is given. */
function acmeServer(options: Partial<Setup> = {}, latest?: RegistryEntry) {
  const entry = vi.fn<RegistryCatalog["entry"]>(() =>
    latest === undefined
      ? Promise.reject(new Error("This case reads no catalog."))
      : Promise.resolve(latest),
  );
  const run = setup({
    server: "acme-files",
    auth: null,
    environments: LOCAL_ENVS,
    lock: ACME_LOCK,
    trigger: "list_changed",
    ...options,
    source: options.source ?? ACME,
    seams: { catalog: { entry }, ...options.seams },
  });
  return { ...run, entry };
}

describe("discover a registry package on machines", () => {
  it("reads a machine's report and leaves the catalog alone", async () => {
    const { report, local } = reporter();
    const { ctx, entry, sent } = acmeServer({ seams: { local } });
    const found = await discover(ctx);

    expect(entry).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      scope: SCOPE,
      server: "acme-files",
      source: ACME,
      lockSource: ACME_LOCK,
      signal: ctx.signal,
    });
    expect(found).toEqual({
      offered: offered(TOOLS),
      lockSource: { ...ACME_LOCK, server_version: "2026.9.0" },
      securitySchemes: {},
      descriptorSet: undefined,
      version: undefined,
      latestVersion: undefined,
      files: [],
      machine: "mac-ada-01",
      origin: `tools/list changed at ${STAMP}`,
    });
    expect(sent).toEqual([]);
  });

  it("records the catalog's version when it has not moved", async () => {
    const { report, local } = reporter();
    const { ctx, entry } = acmeServer(
      { trigger: "schedule", seams: { local } },
      acmeEntry("1.3.0"),
    );
    const found = await discover(ctx);

    expect(entry).toHaveBeenCalledWith(
      REGISTRY,
      ACME_NAME,
      "latest",
      ctx.signal,
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(found.latestVersion).toBe("1.3.0");
    expect(found.version).toBeUndefined();
  });

  it("stops at needs_digest when the catalog moved on", async () => {
    const { report, local } = reporter();
    const { ctx } = acmeServer(
      { trigger: "schedule", seams: { local } },
      acmeEntry("1.4.0"),
    );
    const error = await refusal(discover(ctx));

    expect(error).toBeInstanceOf(NeedsDigest);
    expect(error).toMatchObject({
      code: "needs_digest",
      latestVersion: "1.4.0",
    });
    expect(error.message).toMatch(/^io\.github\.acme\/files 1\.4\.0 is in /);
    expect(report).not.toHaveBeenCalled();
  });

  it("refuses while no local gateway reporter is installed", async () => {
    const { ctx } = acmeServer();
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("unsupported");
  });

  it("refuses a served lock that is not a registry lock", async () => {
    const { report, local } = reporter();
    const { ctx } = acmeServer({ lock: FILES_LOCK, seams: { local } });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      "The lock for acme-files is for a local source, and server.toml " +
        "names a registry source.",
    );
    expect(report).not.toHaveBeenCalled();
  });
});

// ── OpenAPI definitions ──────────────────────────────────────────────────────

/** The commit the linked repository's ref resolved to. */
const REPO_COMMIT = "4b7a0d3f6e8c5b2a1d4e7f0c3b6a9d2e5f9f1c2e";
const PETS_FOLDER = "tools/servers/pets";
const PETS_URL = "https://api.pets.dev/v1/openapi.json";
const OPENAPI_ACCEPT =
  "application/yaml, application/json;q=0.9, text/plain;q=0.5, */*;q=0.1";

const PETS_SPEC = {
  openapi: "3.1.0",
  info: { title: "Pets", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets.",
        responses: { "200": { description: "The pets." } },
      },
    },
  },
  components: {
    securitySchemes: {
      api_key: { type: "apiKey", in: "header", name: "X-API-Key" },
      "bearer auth": { type: "http", scheme: "bearer" },
    },
  },
};
const PETS_JSON = JSON.stringify(PETS_SPEC);

/** The same operation as YAML, with no security schemes. */
const PETS_YAML = [
  "openapi: 3.1.0",
  "info: { title: Pets, version: 1.0.0 }",
  "paths:",
  "  /pets:",
  "    get:",
  "      operationId: listPets",
  "      summary: List pets.",
  "      responses:",
  '        "200": { description: The pets. }',
  "",
].join("\n");

/** The scheme the lock keeps. "bearer auth" has a space, so it is cut. */
const API_KEY_SCHEME = { type: "api_key", in: "header", name: "X-API-Key" };

const OVERLAY = JSON.stringify({
  overlay: "1.0.0",
  info: { title: "Rename", version: "1" },
  actions: [
    {
      target: "$.paths['/pets'].get",
      update: { summary: "List every pet." },
    },
  ],
});

const PETS_REPO: ServerSource = {
  type: "openapi",
  from: "repository",
  repo: "acme/pets-api",
  path: "spec/openapi.json",
  ref: "main",
};

const PETS_UPLOAD: ServerSource = { type: "openapi", from: "upload" };

/** A definition reader that answers with one file. */
function definitions(text: string) {
  const read = vi.fn<DefinitionReader["read"]>(() =>
    Promise.resolve({ commit: REPO_COMMIT, text }),
  );
  return { read, reader: { read } };
}

/** The pets API, an OpenAPI definition. */
function petsServer(options: Partial<Setup> = {}) {
  return setup({
    server: "pets",
    auth: null,
    ...options,
    source: options.source ?? PETS_REPO,
  });
}

function toolNames(found: { offered: readonly { name: string }[] }) {
  return found.offered.map((tool) => tool.name);
}

describe("discover an OpenAPI definition", () => {
  it("reads a repository definition through the definitions seam", async () => {
    const { read, reader } = definitions(PETS_JSON);
    const { ctx, sent } = petsServer({ seams: { definitions: reader } });
    const found = await discover(ctx);

    expect(read).toHaveBeenCalledWith(
      SCOPE,
      { repo: "acme/pets-api", path: "spec/openapi.json", ref: "main" },
      ctx.signal,
    );
    expect(toolNames(found)).toEqual(["list_pets"]);
    expect(found.offered[0]?.description).toBe("List pets.");
    expect(found.lockSource).toEqual({
      type: "openapi",
      from: "repository",
      document_hash: documentHash(PETS_JSON),
      repo: "acme/pets-api",
      path: "spec/openapi.json",
      ref: "main",
      commit: REPO_COMMIT,
      security_schemes: { api_key: API_KEY_SCHEME },
    });
    expect(found).toMatchObject({
      securitySchemes: { api_key: API_KEY_SCHEME },
      descriptorSet: undefined,
      version: undefined,
      latestVersion: undefined,
      machine: null,
      files: [],
      origin: "openapi.json changed at pets-api@4b7a0d3",
    });
    expect(sent).toEqual([]);
  });

  it("applies overlay.yaml from the server's folder", async () => {
    const { reader } = definitions(PETS_JSON);
    const { ctx, read } = petsServer({
      seams: { definitions: reader },
      files: { [`${PETS_FOLDER}/overlay.yaml`]: OVERLAY },
    });
    const found = await discover(ctx);

    expect(read).toHaveBeenCalledWith(`${PETS_FOLDER}/overlay.yaml`);
    expect(found.offered[0]?.description).toBe("List every pet.");
    // The hash covers the document as committed, before the overlay.
    expect(found.lockSource).toMatchObject({
      document_hash: documentHash(PETS_JSON),
    });
  });

  it("refuses an overlay that is not Overlay 1.0", async () => {
    const { reader } = definitions(PETS_JSON);
    const { ctx } = petsServer({
      seams: { definitions: reader },
      files: { [`${PETS_FOLDER}/overlay.yaml`]: "overlay: 2.0.0\n" },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toMatch(
      /^The definition does not import: overlay\.yaml is not a valid /,
    );
  });

  it.each([
    { url: PETS_URL, text: PETS_JSON, type: "application/json" },
    {
      url: "https://api.pets.dev/v1/openapi.yaml",
      text: PETS_YAML,
      type: "application/yaml",
    },
  ])("fetches $url with no credential", async ({ url, text, type }) => {
    const { ctx, sent, credentials } = petsServer({
      source: { type: "openapi", from: "url", url },
      auth: SERVICE_BEARER,
      route: () => answer(200, text, type),
    });
    const found = await discover(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "GET",
      host: "api.pets.dev",
      path: new URL(url).pathname,
      body: "",
    });
    expect(header(sent[0], "Accept")).toBe(OPENAPI_ACCEPT);
    expect(header(sent[0], "Authorization")).toBeUndefined();
    expect(credentials).not.toHaveBeenCalled();
    expect(toolNames(found)).toEqual(["list_pets"]);
    expect(found.lockSource).toMatchObject({
      type: "openapi",
      from: "url",
      url,
      document_hash: documentHash(text),
    });
    expect(found.origin).toBe(`${url} changed at ${STAMP}`);
  });

  it("refuses a url that answers 404", async () => {
    const { ctx } = petsServer({
      source: { type: "openapi", from: "url", url: PETS_URL },
      route: () => answer(404),
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.retriable).toBe(false);
    expect(error.message).toBe(
      "api.pets.dev answered GET /v1/openapi.json with HTTP 404.",
    );
  });

  it("refuses a url definition on a relay network", async () => {
    const { ctx, sent } = petsServer({
      source: {
        type: "openapi",
        from: "url",
        url: PETS_URL,
        network: "relay:office",
      },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("unsupported");
    expect(error.message).toBe(
      "Discovery through a relay is not available yet.",
    );
    expect(sent).toEqual([]);
  });

  it("reads an uploaded openapi.json with no openapi.yaml", async () => {
    const { ctx, read } = petsServer({
      source: PETS_UPLOAD,
      files: { [`${PETS_FOLDER}/openapi.json`]: PETS_JSON },
    });
    const found = await discover(ctx);

    expect(read.mock.calls.map(([path]) => path)).toEqual([
      `${PETS_FOLDER}/openapi.yaml`,
      `${PETS_FOLDER}/openapi.json`,
      `${PETS_FOLDER}/overlay.yaml`,
    ]);
    expect(found.lockSource).toEqual({
      type: "openapi",
      from: "upload",
      document_hash: documentHash(PETS_JSON),
      security_schemes: { api_key: API_KEY_SCHEME },
    });
    expect(found.origin).toBe("openapi.json changed at 9f1c2e4");
  });

  it("prefers an uploaded openapi.yaml over openapi.json", async () => {
    const { ctx } = petsServer({
      source: PETS_UPLOAD,
      files: {
        [`${PETS_FOLDER}/openapi.yaml`]: PETS_YAML,
        [`${PETS_FOLDER}/openapi.json`]: "{ not read }",
      },
    });
    const found = await discover(ctx);

    expect(found.lockSource).toEqual({
      type: "openapi",
      from: "upload",
      document_hash: documentHash(PETS_YAML),
    });
    expect(found.securitySchemes).toEqual({});
    expect(found.origin).toBe("openapi.yaml changed at 9f1c2e4");
  });

  it("refuses an upload folder with no definition", async () => {
    const { ctx } = petsServer({ source: PETS_UPLOAD });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      "tools/servers/pets holds no openapi.yaml or openapi.json.",
    );
  });

  it.each<{ field: string; source: ServerSource }>([
    {
      field: "repo",
      source: {
        type: "openapi",
        from: "repository",
        path: "spec/openapi.json",
        ref: "main",
      },
    },
    {
      field: "path",
      source: {
        type: "openapi",
        from: "repository",
        repo: "acme/pets-api",
        ref: "main",
      },
    },
    {
      field: "ref",
      source: {
        type: "openapi",
        from: "repository",
        repo: "acme/pets-api",
        path: "spec/openapi.json",
      },
    },
    { field: "url", source: { type: "openapi", from: "url" } },
  ])("refuses a source that names no $field", async ({ field, source }) => {
    const { ctx, sent } = petsServer({ source });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      `server.toml for pets names no source.${field}.`,
    );
    expect(sent).toEqual([]);
  });

  it("refuses a document that is not valid YAML", async () => {
    const { ctx } = petsServer({
      source: PETS_UPLOAD,
      files: { [`${PETS_FOLDER}/openapi.yaml`]: "openapi: [3.1" },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toMatch(
      /^The definition does not import: openapi\.yaml is not valid YAML: /,
    );
  });

  it("passes a definition reader failure through as it came", async () => {
    const failure = new Error("GitHub answered 502.");
    const { ctx } = petsServer({
      seams: { definitions: { read: () => Promise.reject(failure) } },
    });

    await expect(discover(ctx)).rejects.toBe(failure);
  });

  it("leaves security_schemes out when no scheme name fits", async () => {
    const spec = {
      ...PETS_SPEC,
      components: {
        securitySchemes: {
          "bearer auth": { type: "http", scheme: "bearer" },
        },
      },
    };
    const { reader } = definitions(JSON.stringify(spec));
    const { ctx } = petsServer({ seams: { definitions: reader } });
    const found = await discover(ctx);

    expect(found.lockSource).not.toHaveProperty("security_schemes");
    expect(found.securitySchemes).toEqual({});
  });

  // server.toml's own check refuses these sources first, so only a
  // hand-built source reaches the reader's refusal.
  it.each(["reflection", "introspection"] as const)(
    "refuses an OpenAPI definition from %s",
    async (from) => {
      const { ctx, sent } = petsServer({ source: { type: "openapi", from } });
      const error = await refusal(discover(ctx));

      expect(error.code).toBe("server_file");
      expect(error.message).toBe(
        `An OpenAPI definition cannot come from ${from}.`,
      );
      expect(sent).toEqual([]);
    },
  );
});

// ── GraphQL definitions ──────────────────────────────────────────────────────

const PING_SDL = 'type Query {\n  "Answer pong."\n  ping: String\n}\n';
const CHAT_FOLDER = "tools/servers/chat";
const CHAT_SDL_URL = "https://api.chat.dev/schema.graphql";
const CHAT_LIVE_URL = "https://api.chat.dev/graphql";
const CHAT_CREDENTIAL = "oxagen:credential/chat-live";
const GRAPHQL_ACCEPT = "application/graphql, text/plain;q=0.9, */*;q=0.1";

/** PING_SDL as an introspection query's data, written out by hand. */
const INTROSPECTION = {
  __schema: {
    description: null,
    queryType: { name: "Query" },
    mutationType: null,
    subscriptionType: null,
    types: [
      {
        kind: "OBJECT",
        name: "Query",
        description: null,
        fields: [
          {
            name: "ping",
            description: "Answer pong.",
            args: [],
            type: { kind: "SCALAR", name: "String", ofType: null },
            isDeprecated: false,
            deprecationReason: null,
          },
        ],
        inputFields: null,
        interfaces: [],
        enumValues: null,
        possibleTypes: null,
      },
      {
        kind: "SCALAR",
        name: "String",
        description: null,
        fields: null,
        inputFields: null,
        interfaces: null,
        enumValues: null,
        possibleTypes: null,
      },
    ],
    directives: [],
  },
};

/** Introspection reads the first environment, which is not the sandbox. */
const CHAT_ENVS: Environments = {
  live: {
    sandbox: false,
    url: CHAT_LIVE_URL,
    network: "cloud",
    credential: CHAT_CREDENTIAL,
  },
  test: {
    sandbox: true,
    url: "https://test.api.chat.dev/graphql",
    network: "cloud",
  },
};

const CHAT_REPO: ServerSource = {
  type: "graphql",
  from: "repository",
  repo: "acme/chat-api",
  path: "schema/schema.graphql",
  ref: "main",
};

const CHAT_INTROSPECTION: ServerSource = {
  type: "graphql",
  from: "introspection",
};

/** The chat API, a GraphQL server with a service credential. */
function chatServer(options: Partial<Setup> = {}) {
  return setup({
    server: "chat",
    environments: CHAT_ENVS,
    ...options,
    source: options.source ?? CHAT_REPO,
  });
}

/** A chat server whose live endpoint answers introspection with body. */
function introspected(body: unknown, options: Partial<Setup> = {}) {
  return chatServer({
    source: CHAT_INTROSPECTION,
    route: () => json(200, body),
    ...options,
  });
}

const NO_SCHEMA =
  "The live environment of chat answered the introspection query with " +
  "no schema. Introspection may be turned off there. Read the schema " +
  "from a linked repository instead.";

describe("discover a GraphQL definition", () => {
  it("reads SDL from a repository", async () => {
    const { reader } = definitions(PING_SDL);
    const { ctx, read, sent } = chatServer({
      seams: { definitions: reader },
    });
    const found = await discover(ctx);

    expect(toolNames(found)).toEqual(["ping"]);
    expect(found.offered[0]?.description).toBe("Answer pong.");
    expect(found.lockSource).toEqual({
      type: "graphql",
      from: "repository",
      document_hash: documentHash(PING_SDL),
      repo: "acme/chat-api",
      path: "schema/schema.graphql",
      ref: "main",
      commit: REPO_COMMIT,
    });
    expect(found).toMatchObject({
      securitySchemes: {},
      files: [],
      machine: null,
      origin: "schema.graphql changed at chat-api@4b7a0d3",
    });
    // A GraphQL schema has no overlay, so the folder is not read.
    expect(read).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("fetches SDL from a url with no credential", async () => {
    const { ctx, sent, credentials } = chatServer({
      source: { type: "graphql", from: "url", url: CHAT_SDL_URL },
      route: () => answer(200, PING_SDL, "application/graphql"),
    });
    const found = await discover(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/schema.graphql" });
    expect(header(sent[0], "Accept")).toBe(GRAPHQL_ACCEPT);
    expect(header(sent[0], "Authorization")).toBeUndefined();
    expect(credentials).not.toHaveBeenCalled();
    expect(toolNames(found)).toEqual(["ping"]);
    expect(found.lockSource).toEqual({
      type: "graphql",
      from: "url",
      document_hash: documentHash(PING_SDL),
      url: CHAT_SDL_URL,
    });
    expect(found.origin).toBe(`${CHAT_SDL_URL} changed at ${STAMP}`);
  });

  it("reads an uploaded schema.graphql", async () => {
    const { ctx } = chatServer({
      source: { type: "graphql", from: "upload" },
      files: { [`${CHAT_FOLDER}/schema.graphql`]: PING_SDL },
    });
    const found = await discover(ctx);

    expect(found.lockSource).toEqual({
      type: "graphql",
      from: "upload",
      document_hash: documentHash(PING_SDL),
    });
    expect(found.origin).toBe("schema.graphql changed at 9f1c2e4");
  });

  it("refuses an upload folder with no schema.graphql", async () => {
    const { ctx } = chatServer({ source: { type: "graphql", from: "upload" } });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe("tools/servers/chat holds no schema.graphql.");
  });

  it("refuses SDL that does not describe a schema", async () => {
    const { reader } = definitions("type Query {");
    const { ctx } = chatServer({ seams: { definitions: reader } });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toMatch(
      /^The definition does not import: The SDL does not describe a schema\./,
    );
  });

  it("introspects the first environment with its credential", async () => {
    const { ctx, sent, resolve } = introspected({ data: INTROSPECTION });
    const found = await discover(ctx);

    expect(resolve).toHaveBeenCalledWith(
      {
        server: "chat",
        environment: "live",
        reference: CHAT_CREDENTIAL,
        auth: SERVICE_BEARER,
        operator: undefined,
      },
      ctx.signal,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      host: "api.chat.dev",
      path: "/graphql",
    });
    expect(header(sent[0], "Authorization")).toBe(`Bearer ${SECRET}`);
    expect(header(sent[0], "Accept")).toBe("application/json");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      operationName: "IntrospectionQuery",
    });
    expect(toolNames(found)).toEqual(["ping"]);
    const schemaFile = found.files[0];
    expect(found.files).toHaveLength(1);
    expect(schemaFile?.path).toBe("schema.graphql");
    expect(schemaFile?.text).toContain("ping: String");
    expect(found.lockSource).toEqual({
      type: "graphql",
      from: "introspection",
      document_hash: documentHash(schemaFile?.text ?? ""),
    });
    expect(found.origin).toBe(`introspection changed at ${STAMP}`);
    expect(leaks(SECRET, found)).toEqual([]);
  });

  it("introspects despite an empty errors list", async () => {
    const { ctx } = introspected({ errors: [], data: INTROSPECTION });
    const found = await discover(ctx);

    expect(toolNames(found)).toEqual(["ping"]);
  });

  it.each([
    {
      label: "errors and null data",
      body: { errors: [{ message: "Introspection is off." }], data: null },
    },
    {
      label: "errors beside data",
      body: { errors: [{ message: "Partial." }], data: INTROSPECTION },
    },
    { label: "no data", body: {} },
    { label: "null data", body: { data: null } },
    { label: "a bare __schema", body: INTROSPECTION },
    { label: "an array", body: [] },
    { label: "a string", body: "introspection is off" },
  ])("refuses an introspection answer with $label", async ({ body }) => {
    const { ctx } = introspected(body);
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(NO_SCHEMA);
  });

  it("refuses introspection data with no __schema", async () => {
    const { ctx } = introspected({ data: {} });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toMatch(
      /^The definition does not import: The introspection result has no /,
    );
  });

  it("refuses an introspection answer that is not JSON", async () => {
    const { ctx } = introspected(undefined, {
      route: () => answer(200, "<html>off</html>", "text/html"),
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      "api.chat.dev answered the introspection query with JSON that does " +
        "not parse.",
    );
  });

  it("refuses an introspection answer of HTTP 403", async () => {
    const { ctx } = introspected(undefined, { route: () => answer(403) });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.retriable).toBe(false);
    expect(error.message).toBe(
      "api.chat.dev answered the introspection query with HTTP 403.",
    );
  });

  it("scrubs the token from an introspection failure", async () => {
    const { ctx, sent } = introspected(undefined, { route: echoFailure });
    const error = await refusal(discover(ctx));

    expect(quoted(sent[0])).toContain(`Authorization: Bearer ${SECRET}`);
    expect(error.code).toBe("source");
    expect(error.retriable).toBe(true);
    expect(error.message).toContain(`Authorization: Bearer ${REDACTED}`);
    expect(leaks(SECRET, error.message)).toEqual([]);
  });

  it("refuses introspection from a first environment with no url", async () => {
    const { ctx, sent, resolve } = introspected(undefined, {
      environments: {
        live: { sandbox: false, network: "cloud" },
        test: { sandbox: true, url: CHAT_LIVE_URL, network: "cloud" },
      },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe("The live environment of chat names no url.");
    expect(resolve).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses introspection with no environment", async () => {
    const { ctx } = introspected(undefined, { environments: {} });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("server_file");
    expect(error.message).toBe("chat has no environment to discover from.");
  });
});

// ── gRPC definitions ─────────────────────────────────────────────────────────

const ORDERS_FOLDER = "tools/servers/orders";
const ORDERS_PROTO = [
  'syntax = "proto3";',
  "package orders.v1;",
  'import "common/v1/money.proto";',
  "service Orders { rpc GetOrder(GetOrderRequest) returns (Order); }",
  "",
].join("\n");
const MONEY_PROTO = [
  'syntax = "proto3";',
  "package common.v1;",
  "message Money { int64 cents = 1; }",
  "",
].join("\n");
/** The folder as import wrote it: the package under proto/, by package path. */
const ORDERS_FILES = {
  [`${ORDERS_FOLDER}/proto/common/v1/money.proto`]: MONEY_PROTO,
  [`${ORDERS_FOLDER}/proto/orders/v1/orders.proto`]: ORDERS_PROTO,
};
const ORDERS_DESCRIPTORS = encoder.encode("orders.v1 descriptor set");
const ORDERS_HASH = documentHash("orders.v1 bundle");
const ORDERS_REPO: ServerSource = {
  type: "grpc",
  from: "repository",
  repo: "acme/orders-api",
  path: "api/orders.proto",
  ref: "main",
};
const ORDERS_URL = "https://api.orders.dev/v1/orders.proto";

const GET_ORDER: McpTool = {
  name: "orders_v1_Orders_GetOrder",
  description: "Get one order.",
  inputSchema: { type: "object" },
};

/** A gRPC importer that answers with one tool and a descriptor set. */
function grpcImporter(result: Partial<ImportResult> = {}) {
  return vi.fn<GrpcImporter>(() =>
    Promise.resolve({
      tools: offered([GET_ORDER]),
      listed: [],
      notes: [],
      environments: [],
      auth: [],
      document_hash: ORDERS_HASH,
      files: [],
      descriptor_set: ORDERS_DESCRIPTORS,
      ...result,
    }),
  );
}

describe("discover a gRPC definition", () => {
  it("refuses reflection before it reads anything", async () => {
    const grpc = grpcImporter();
    const { ctx, sent, credentials, read } = setup({
      server: "orders",
      source: { type: "grpc", from: "reflection" },
      seams: { grpc },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("unsupported");
    expect(error.message).toBe(
      "orders reads its gRPC definition by server reflection, and discovery cannot call reflection yet. Import the server again in Studio to pick up a change.",
    );
    expect(grpc).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(credentials).not.toHaveBeenCalled();
  });

  it("imports an uploaded definition from the folder's proto/ and writes nothing", async () => {
    const grpc = grpcImporter();
    const { ctx, sent } = setup({
      server: "orders",
      source: { type: "grpc", from: "upload" },
      files: {
        ...ORDERS_FILES,
        [`${ORDERS_FOLDER}/server.toml`]: "schema = \"mcp-server/v1\"\n",
      },
      seams: { grpc },
    });
    const found = await discover(ctx);

    expect(grpc).toHaveBeenCalledWith({
      files: [
        { path: "proto/common/v1/money.proto", text: MONEY_PROTO },
        { path: "proto/orders/v1/orders.proto", text: ORDERS_PROTO },
      ],
    });
    expect(toolNames(found)).toEqual(["orders_v1_Orders_GetOrder"]);
    expect(found.lockSource).toEqual({
      type: "grpc",
      from: "upload",
      document_hash: ORDERS_HASH,
    });
    expect(found).toMatchObject({
      securitySchemes: {},
      descriptorSet: ORDERS_DESCRIPTORS,
      version: undefined,
      latestVersion: undefined,
      files: [],
      machine: null,
      origin: `proto/ changed at ${COMMIT.slice(0, 7)}`,
    });
    expect(sent).toEqual([]);
  });

  it("refuses an uploaded definition when proto/ holds nothing", async () => {
    const grpc = grpcImporter();
    const { ctx } = setup({
      server: "orders",
      source: { type: "grpc", from: "upload" },
      seams: { grpc },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(`${ORDERS_FOLDER}/proto holds no .proto files.`);
    expect(grpc).not.toHaveBeenCalled();
  });

  it("imports a repository file with the folder's other files and writes it over its copy", async () => {
    const grpc = grpcImporter();
    const changed = ORDERS_PROTO.replace("GetOrder(", "FetchOrder(");
    const { read, reader } = definitions(changed);
    const { ctx } = setup({
      server: "orders",
      source: ORDERS_REPO,
      files: ORDERS_FILES,
      seams: { grpc, definitions: reader },
    });
    const found = await discover(ctx);

    expect(read).toHaveBeenCalledWith(
      SCOPE,
      { repo: "acme/orders-api", path: "api/orders.proto", ref: "main" },
      ctx.signal,
    );
    expect(grpc).toHaveBeenCalledWith({
      files: [
        { path: "proto/common/v1/money.proto", text: MONEY_PROTO },
        { path: "proto/orders/v1/orders.proto", text: changed },
      ],
    });
    expect(found.files).toEqual([
      { path: "proto/orders/v1/orders.proto", text: changed },
    ]);
    expect(found.lockSource).toEqual({
      type: "grpc",
      from: "repository",
      document_hash: ORDERS_HASH,
      repo: "acme/orders-api",
      path: "api/orders.proto",
      ref: "main",
      commit: REPO_COMMIT,
    });
    expect(found.origin).toBe(
      `orders.proto changed at orders-api@${REPO_COMMIT.slice(0, 7)}`,
    );
  });

  it("fetches a url file and writes it under proto/ when the folder has no copy", async () => {
    const grpc = grpcImporter();
    const { ctx, sent, credentials } = setup({
      server: "orders",
      source: { type: "grpc", from: "url", url: ORDERS_URL },
      files: { [`${ORDERS_FOLDER}/proto/common/v1/money.proto`]: MONEY_PROTO },
      route: () => answer(200, ORDERS_PROTO, "text/plain"),
      seams: { grpc },
    });
    const found = await discover(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "GET",
      host: "api.orders.dev",
      path: "/v1/orders.proto",
    });
    expect(header(sent[0], "Accept")).toBe("text/plain, */*;q=0.1");
    expect(header(sent[0], "Authorization")).toBeUndefined();
    expect(credentials).not.toHaveBeenCalled();
    expect(grpc).toHaveBeenCalledWith({
      files: [
        { path: "proto/common/v1/money.proto", text: MONEY_PROTO },
        { path: "proto/orders.proto", text: ORDERS_PROTO },
      ],
    });
    expect(found.files).toEqual([
      { path: "proto/orders.proto", text: ORDERS_PROTO },
    ]);
    expect(found.lockSource).toEqual({
      type: "grpc",
      from: "url",
      document_hash: ORDERS_HASH,
      url: ORDERS_URL,
    });
    expect(found.origin).toBe(`${ORDERS_URL} changed at ${STAMP}`);
  });

  it("names a url file that does not end in .proto service.proto", async () => {
    const grpc = grpcImporter();
    const url = "https://api.orders.dev/v1/definition";
    const { ctx } = setup({
      server: "orders",
      source: { type: "grpc", from: "url", url },
      route: () => answer(200, ORDERS_PROTO, "text/plain"),
      seams: { grpc },
    });
    const found = await discover(ctx);

    expect(found.files).toEqual([
      { path: "proto/service.proto", text: ORDERS_PROTO },
    ]);
  });

  it("refuses a definition the importer cannot read", async () => {
    const grpc = vi.fn<GrpcImporter>(() =>
      Promise.reject(new Error("orders.proto:3: unknown type GetOrderRequest")),
    );
    const { ctx } = setup({
      server: "orders",
      source: { type: "grpc", from: "upload" },
      files: ORDERS_FILES,
      seams: { grpc },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      "The definition does not import: orders.proto:3: unknown type GetOrderRequest",
    );
  });

  it("refuses a definition that imports with no descriptor set", async () => {
    const grpc = grpcImporter({ descriptor_set: undefined });
    const { ctx } = setup({
      server: "orders",
      source: { type: "grpc", from: "upload" },
      files: ORDERS_FILES,
      seams: { grpc },
    });
    const error = await refusal(discover(ctx));

    expect(error.code).toBe("source");
    expect(error.message).toBe(
      "The gRPC definition imported with no descriptor set.",
    );
  });
});

describe("servedDescriptorSet", () => {
  function checkoutOf(files: Record<string, string>): SteeringCheckout {
    const held = new Map(Object.entries(files));
    return {
      commit: COMMIT,
      read: (path) => Promise.resolve(held.get(path) ?? null),
      list: () => Promise.resolve([...held.keys()]),
      pullRequest: () =>
        Promise.resolve({ open: true, merged: false, headSha: null }),
    };
  }

  it("reads the descriptor set from the production branch's proto/", async () => {
    const grpc = grpcImporter();
    const checkout = checkoutOf({
      ...ORDERS_FILES,
      [`${ORDERS_FOLDER}/tools.toml`]: "schema = \"mcp-tools/v1\"\n",
    });

    await expect(servedDescriptorSet(checkout, "orders", grpc)).resolves.toBe(
      ORDERS_DESCRIPTORS,
    );
    expect(grpc).toHaveBeenCalledWith({
      files: [
        { path: "proto/common/v1/money.proto", text: MONEY_PROTO },
        { path: "proto/orders/v1/orders.proto", text: ORDERS_PROTO },
      ],
    });
  });

  it("refuses a folder with no .proto files", async () => {
    const grpc = grpcImporter();
    const error = await refusal(
      servedDescriptorSet(checkoutOf({}), "orders", grpc),
    );

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      `${ORDERS_FOLDER}/proto holds no files, and a gRPC server needs its .proto files there. Import the server in Studio to write them.`,
    );
    expect(grpc).not.toHaveBeenCalled();
  });

  it("refuses files that do not import", async () => {
    const grpc = vi.fn<GrpcImporter>(() =>
      Promise.reject(new Error("money.proto:2: syntax error")),
    );
    const error = await refusal(
      servedDescriptorSet(checkoutOf(ORDERS_FILES), "orders", grpc),
    );

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      `${ORDERS_FOLDER}/proto does not import on the production branch: money.proto:2: syntax error`,
    );
  });

  it("refuses an import with no descriptor set", async () => {
    const grpc = grpcImporter({ descriptor_set: undefined });
    const error = await refusal(
      servedDescriptorSet(checkoutOf(ORDERS_FILES), "orders", grpc),
    );

    expect(error.code).toBe("server_file");
    expect(error.message).toBe(
      `${ORDERS_FOLDER}/proto gave no descriptor set on the production branch.`,
    );
  });
});
