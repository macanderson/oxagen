// call.ts: one call from the manifest, start to end. A fake Transport stands
// in for the network, and fake Senders stand in where a case is about the
// dispatch rather than the request.
import { describe, expect, it, vi } from "vitest";
import type { ManifestServer, ManifestShaping, ManifestTool } from "../contract/manifest";
import { recordedExchangeSchema } from "../contract/tests-files";
import type { GraphqlRequest, Paging, RequestKind, RequestTemplate } from "../model/upstream-tool";
import { bodyJson, fakeHttp, header, reply, type FakeHttp, type FakeResponse } from "./__tests__/fake-http";
import {
  BEARER_AUTH,
  fakeCredentials,
  listRequest,
  manifestServer,
  manifestTool,
  type FakeCredentials,
} from "./__tests__/manifest";
import { executeCall, type CallEnvironment, type ExecutedCall, type ExecuteOptions } from "./call";
import type { CredentialSource } from "./credentials";
import { createGraphqlSender } from "./graphql";
import { createHttpSender } from "./http";
import { execute } from "./index";
import type { SendContext, Sender, Senders, SendResult, UpstreamArguments } from "./sender";
import type { CallToolResult, HeaderEntry, HttpTransportRequest, HttpTransportResponse, LocalCall } from "./transport";

const TOKEN = "tok_never_recorded";

/** The HTTP and GraphQL Senders with a 1 ms backoff, so a retry costs no time. */
const FAST: Partial<Senders> = {
  http: createHttpSender({ backoff_ms: () => 1 }),
  graphql: createGraphqlSender({ backoff_ms: () => 1 }),
};

function sandbox(server: ManifestServer = manifestServer({ auth: BEARER_AUTH })): CallEnvironment {
  return { server, name: "sandbox", operator: "op_1" };
}

type Answer = (request: HttpTransportRequest, number: number) => Promise<HttpTransportResponse> | HttpTransportResponse;

interface Setup {
  environment?: CallEnvironment;
  credentials?: FakeCredentials;
  local?: (call: LocalCall) => Promise<CallToolResult>;
  options?: ExecuteOptions;
}

interface Run {
  call: ExecutedCall;
  fake: FakeHttp;
  credentials: FakeCredentials;
}

async function run(tool: ManifestTool, args: Record<string, unknown>, answer: Answer, setup: Setup = {}): Promise<Run> {
  const fake = fakeHttp(answer, setup.local);
  const credentials = setup.credentials ?? fakeCredentials();
  const call = await executeCall(tool, args, setup.environment ?? sandbox(), credentials.source, fake.transport, {
    senders: FAST,
    ...setup.options,
  });
  return { call, fake, credentials };
}

function unanswered(): never {
  throw new Error("The call should not reach the network.");
}

function texts(result: CallToolResult): unknown[] {
  return result.content.map((item) => item.text);
}

function failedWith(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const PROBLEM: HeaderEntry[] = [["content-type", "application/problem+json"]];

// ── Paging fixtures ──────────────────────────────────────────────────────────

const CURSOR: Paging = { style: "cursor", input: "starting_after", next: "next_cursor", items: "data", limit: "limit" };

function cursorTool(shaping: Partial<ManifestShaping> = {}): ManifestTool {
  return manifestTool({
    request: listRequest(["starting_after", "limit"]),
    properties: { starting_after: { type: "string" }, limit: { type: "integer" } },
    shaping: { paginate: "cursor", ...shaping },
    paging: CURSOR,
  });
}

function charges(from: number, count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `ch_${from + index}` }));
}

/** Page n of the charges: three items and the cursor for page n + 1. */
function chargesPage(n: number, headers: HeaderEntry[] = []): FakeResponse {
  return reply(200, { data: charges((n - 1) * 3, 3), next_cursor: `cur_${n}` }, headers);
}

// ── Fake Senders ─────────────────────────────────────────────────────────────

interface Sent {
  kind: RequestKind;
  args: UpstreamArguments;
  context: SendContext;
}

function fakeSenders(answer: (kind: RequestKind, number: number) => SendResult | Promise<SendResult>): {
  senders: Senders;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  function sender<K extends RequestKind>(kind: K): Sender<K> {
    return {
      kind,
      send: (_template, args, context) => {
        sent.push({ kind, args, context });
        return Promise.resolve(answer(kind, sent.length));
      },
    };
  }
  return { sent, senders: { mcp: sender("mcp"), http: sender("http"), graphql: sender("graphql"), grpc: sender("grpc") } };
}

function answered(value: unknown): SendResult {
  return { ok: true, value, attempts: 1, exchanges: [] };
}

const TEMPLATES: Array<[RequestKind, RequestTemplate]> = [
  ["mcp", { kind: "mcp", tool: "list_charges" }],
  ["http", listRequest([])],
  ["graphql", { kind: "graphql", operation_type: "query", field: "Query.charges", arguments: [], selection: "{ id }" }],
  [
    "grpc",
    {
      kind: "grpc",
      method: "/billing.v1.Charges/ListCharges",
      streaming: "unary",
      idempotency_level: "NO_SIDE_EFFECTS",
      request_type: "billing.v1.ListChargesRequest",
      response_type: "billing.v1.ListChargesResponse",
    },
  ],
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("before the send", () => {
  const TOOL = manifestTool({ properties: { customer_id: { type: "string" } }, required: ["customer_id"] });

  it("refuses arguments that do not match the input schema, and sends nothing", async () => {
    const { call, fake, credentials } = await run(TOOL, {}, unanswered);
    expect(call.result.isError).toBe(true);
    const [text] = texts(call.result);
    expect(text).toMatch(/^The arguments do not match the tool's input schema\. /);
    expect(text).toContain("customer_id is required.");
    expect(call.exchanges).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    expect(credentials.requests).toHaveLength(0);
  });

  it("names a value of the wrong type", async () => {
    const { call } = await run(TOOL, { customer_id: 81 }, unanswered);
    expect(texts(call.result)[0]).toContain("customer_id must be a string.");
  });

  it("refuses an environment the server does not have, including an Object.prototype name", async () => {
    for (const name of ["production", "constructor"]) {
      const { call, fake } = await run(TOOL, { customer_id: "cus_1" }, unanswered, {
        environment: { ...sandbox(), name },
      });
      expect(call).toEqual({ result: failedWith(`The server billing has no environment named ${name}.`), exchanges: [] });
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("asks the CredentialSource for the environment's credential, with the call's signal", async () => {
    const resolve = vi.fn<CredentialSource["resolve"]>(() => Promise.resolve({ type: "bearer", token: TOKEN }));
    const controller = new AbortController();
    const fake = fakeHttp(() => reply(200, { data: [] }));
    await executeCall(TOOL, { customer_id: "cus_1" }, sandbox(), { resolve }, fake.transport, {
      senders: FAST,
      signal: controller.signal,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      { server: "billing", environment: "sandbox", reference: "billing-sandbox", auth: BEARER_AUTH, operator: "op_1" },
      controller.signal,
    );
    expect(fake.requests.map((request) => header(request, "authorization"))).toEqual([`Bearer ${TOKEN}`]);
  });

  it("asks for no credential when the server has no auth", async () => {
    const { fake, credentials } = await run(TOOL, { customer_id: "cus_1" }, () => reply(200, { data: [] }), {
      environment: sandbox(manifestServer({ auth: null })),
    });
    expect(credentials.requests).toHaveLength(0);
    expect(fake.requests.map((request) => header(request, "authorization"))).toEqual([undefined]);
  });

  it("returns the connect link when the operator has no token, and sends nothing", async () => {
    const source: CredentialSource = {
      resolve: () =>
        Promise.resolve({
          type: "missing",
          message: "Connect your Billing API account in Oxagen, then retry.",
          connect_url: "https://app.oxagen.sh/connect/billing",
        }),
    };
    const fake = fakeHttp(unanswered);
    const call = await executeCall(TOOL, { customer_id: "cus_1" }, sandbox(), source, fake.transport);
    expect(call).toEqual({
      result: failedWith("Connect your Billing API account in Oxagen, then retry.\nhttps://app.oxagen.sh/connect/billing"),
      exchanges: [],
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects when the CredentialSource rejects", async () => {
    const source: CredentialSource = { resolve: () => Promise.reject(new Error("The vault is unreachable.")) };
    const fake = fakeHttp(unanswered);
    await expect(executeCall(TOOL, { customer_id: "cus_1" }, sandbox(), source, fake.transport)).rejects.toThrow(
      "The vault is unreachable.",
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the send", () => {
  it.each(TEMPLATES)("sends a %s tool through the %s Sender", async (kind, request) => {
    const fake = fakeSenders((called) =>
      answered(called === "mcp" ? { content: [{ type: "text", text: "from mcp" }] } : { from: called }),
    );
    const { call } = await run(manifestTool({ request }), {}, unanswered, { options: { senders: fake.senders } });
    expect(fake.sent.map((sent) => sent.kind)).toEqual([kind]);
    expect(call.result).toEqual(
      kind === "mcp"
        ? { content: [{ type: "text", text: "from mcp" }] }
        : { content: [{ type: "text", text: JSON.stringify({ from: kind }) }], structuredContent: { from: kind } },
    );
  });

  it("sends the shaped arguments with the environment, credential, and signal", async () => {
    const tool = manifestTool({
      properties: { customer_id: { type: "string" }, limit: { type: "integer" } },
      shaping: { rename: { customer: "customer_id" }, fixed: { expand: "customer" }, defaults: { limit: 10 } },
    });
    const fake = fakeSenders(() => answered({ data: [] }));
    const controller = new AbortController();
    const environment = sandbox();
    const { call, fake: http } = await run(tool, { customer_id: "cus_1" }, unanswered, {
      environment,
      options: { senders: fake.senders, signal: controller.signal },
    });
    expect(call.result.isError).toBeUndefined();
    const [sent] = fake.sent;
    expect(sent?.args).toEqual({ customer: "cus_1", expand: "customer", limit: 10 });
    expect(sent?.context).toMatchObject({
      environment: { name: "sandbox", url: "https://api.example.com/v2", network: "cloud" },
      auth: BEARER_AUTH,
      credential: { type: "bearer", token: TOKEN },
      idempotency_key: undefined,
    });
    expect(sent?.context.server).toBe(environment.server);
    expect(sent?.context.shaping).toBe(tool.shaping);
    expect(sent?.context.transport).toBe(http.transport);
    expect(sent?.context.signal).toBe(controller.signal);
  });

  it("maps a Sender that throws to an internal error", async () => {
    const thrower: Sender<"http"> = {
      kind: "http",
      send: () => {
        throw new Error("boom");
      },
    };
    const { call } = await run(manifestTool(), {}, unanswered, { options: { senders: { http: thrower } } });
    expect(call).toEqual({ result: failedWith("Internal error: The http Sender failed: boom"), exchanges: [] });
  });

  it("maps a non-2xx status to isError with the problem's title and detail, and keeps the exchange", async () => {
    const { call } = await run(manifestTool(), {}, () =>
      reply(404, { title: "Not Found", detail: "No such customer." }, PROBLEM),
    );
    expect(call.result).toEqual(failedWith("Not Found (status 404): No such customer."));
    expect(call.exchanges).toMatchObject([{ response: { status: 404 } }]);
  });

  it("shapes an MCP result, so a redacted field reaches the agent in neither form", async () => {
    const record = { id: "file_1", token: "sk_live_leak" };
    const fake = fakeSenders(() =>
      answered({ content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record }),
    );
    const tool = manifestTool({ request: { kind: "mcp", tool: "read_file" }, shaping: { redact: ["token"] } });
    const { call } = await run(tool, {}, unanswered, { options: { senders: fake.senders } });
    expect(call.result).toEqual({
      content: [{ type: "text", text: '{"id":"file_1"}' }],
      structuredContent: { id: "file_1" },
    });
  });

  it("renders an MCP value that is not a tool result as JSON", async () => {
    const fake = fakeSenders(() => answered({ unexpected: true }));
    const { call } = await run(manifestTool({ request: { kind: "mcp", tool: "read_file" } }), {}, unanswered, {
      options: { senders: fake.senders },
    });
    expect(call.result).toEqual({
      content: [{ type: "text", text: '{"unexpected":true}' }],
      structuredContent: { unexpected: true },
    });
  });
});

describe("a local server", () => {
  const DIGEST = `sha256:${"c".repeat(64)}`;
  const LOCAL = manifestServer({
    auth: null,
    environments: { default: { sandbox: true, network: "local" } },
    pinned: { type: "local", package: { digest: DIGEST } },
  });
  const environment: CallEnvironment = { server: LOCAL, name: "default", operator: undefined };

  it("routes the call through the local gateway, with the package digest", async () => {
    const tool = manifestTool({
      name: "read_file",
      request: { kind: "mcp", tool: "read_file" },
      properties: { path: { type: "string" } },
      shaping: { rename: { file: "path" } },
    });
    const { call, fake, credentials } = await run(tool, { path: "notes.txt" }, unanswered, {
      environment,
      local: () => Promise.resolve({ content: [{ type: "text", text: "hello" }] }),
    });
    expect(call.result).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(call.exchanges).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
    expect(credentials.requests).toHaveLength(0);
    expect(fake.locals).toMatchObject([
      { tool: "billing__read_file", upstream: "read_file", package_digest: DIGEST, arguments: { file: "notes.txt" } },
    ]);
  });

  it("refuses a tool that is not MCP", async () => {
    const { call, fake } = await run(manifestTool(), {}, unanswered, { environment });
    expect(call.result).toEqual(failedWith("Invalid request: list_charges is a http tool, and only an MCP tool runs locally."));
    expect(fake.locals).toHaveLength(0);
  });

  it("never pages", async () => {
    const tool = manifestTool({
      request: { kind: "mcp", tool: "list_files" },
      shaping: { paginate: "cursor" },
      paging: { style: "cursor", input: "cursor", next: "nextCursor", items: "files" },
    });
    const page = { content: [{ type: "text", text: "page" }], structuredContent: { files: ["a"], nextCursor: "c1" } };
    const { call, fake } = await run(tool, {}, unanswered, { environment, local: () => Promise.resolve(page) });
    expect(fake.locals).toHaveLength(1);
    expect(call.result).toEqual(page);
  });
});

describe("auto paging", () => {
  it("stops a cursor call at max_items", async () => {
    const { call, fake } = await run(cursorTool({ max_items: 5 }), { limit: 3 }, (_request, n) => chargesPage(n));
    expect(fake.requests.map((request) => request.target.path)).toEqual([
      "/v2/charges?limit=3",
      "/v2/charges?starting_after=cur_1&limit=3",
    ]);
    const value = { data: charges(0, 5), next_cursor: "cur_2" };
    expect(call.result).toEqual({
      content: [
        { type: "text", text: JSON.stringify(value) },
        { type: "text", text: "Auto paging stopped at max_items: the result holds 5 items from 2 pages, and more may remain." },
      ],
      structuredContent: value,
    });
    expect(call.exchanges).toHaveLength(2);
  });

  it("stops a page call at an empty page", async () => {
    const tool = manifestTool({
      request: listRequest(["page"]),
      properties: { page: { type: "integer" } },
      shaping: { paginate: "page" },
      paging: { style: "page", input: "page", items: "results" },
    });
    const { call, fake } = await run(tool, {}, (_request, n) => reply(200, { results: n < 3 ? charges(n * 10, 2) : [] }));
    expect(fake.requests.map((request) => request.target.path)).toEqual([
      "/v2/charges",
      "/v2/charges?page=2",
      "/v2/charges?page=3",
    ]);
    const value = { results: [...charges(10, 2), ...charges(20, 2)] };
    expect(call.result).toEqual({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    expect(call.exchanges).toHaveLength(3);
  });

  it("follows a GraphQL connection's endCursor until hasNextPage is false", async () => {
    const connection: GraphqlRequest = {
      kind: "graphql",
      operation_type: "query",
      field: "Query.charges",
      arguments: [
        { name: "first", type: "Int", property: "first" },
        { name: "after", type: "String", property: "after" },
      ],
      selection: "{ edges { node { id } } pageInfo { endCursor hasNextPage } }",
    };
    const tool = manifestTool({
      request: connection,
      properties: { first: { type: "integer" }, after: { type: "string" } },
      shaping: { paginate: "connection" },
      paging: {
        style: "connection",
        input: "after",
        next: "pageInfo.endCursor",
        has_more: "pageInfo.hasNextPage",
        items: "edges",
      },
    });
    const page = (n: number): unknown => ({
      edges: [{ node: { id: `ch_${n}` } }],
      pageInfo: { endCursor: `c${n}`, hasNextPage: n < 2 },
    });
    const { call, fake } = await run(tool, { first: 1 }, (_request, n) => reply(200, { data: { charges: page(n) } }));
    expect(fake.requests).toHaveLength(2);
    const [, second] = fake.requests;
    if (second === undefined) throw new Error("no second request");
    expect(bodyJson(second)).toMatchObject({ variables: { first: 1, after: "c1" } });
    const value = { edges: [{ node: { id: "ch_1" } }, { node: { id: "ch_2" } }], pageInfo: { endCursor: "c2", hasNextPage: false } };
    expect(call.result).toEqual({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  });

  it("keeps the items it has and adds a note when a later page fails", async () => {
    const { call } = await run(cursorTool(), {}, (_request, n) =>
      n === 1 ? chargesPage(1) : reply(400, { title: "Bad Request", detail: "The cursor has expired." }, PROBLEM),
    );
    const value = { data: charges(0, 3), next_cursor: "cur_1" };
    expect(call.result).toEqual({
      content: [
        { type: "text", text: JSON.stringify(value) },
        {
          type: "text",
          text:
            "Auto paging stopped because page 2 failed: the result holds 3 items from 1 page. " +
            "Bad Request (status 400): The cursor has expired.",
        },
      ],
      structuredContent: value,
    });
    expect(call.exchanges).toMatchObject([{ response: { status: 200 } }, { response: { status: 400 } }]);
  });

  it("returns isError with the exchange when the first page fails", async () => {
    const { call } = await run(cursorTool(), {}, () => reply(404, { title: "Not Found", detail: "No such list." }, PROBLEM));
    expect(call.result).toEqual(failedWith("Not Found (status 404): No such list."));
    expect(call.exchanges).toMatchObject([{ response: { status: 404 } }]);
  });

  it("gives each page the time left, and stops at the deadline", async () => {
    let clock = 0;
    const fake = fakeSenders((_kind, n) => {
      clock += 400;
      return answered({ data: charges(n, 1), next_cursor: `cur_${n}` });
    });
    const tool = cursorTool({ deadline_ms: 1000 });
    const { call } = await run(tool, {}, unanswered, { options: { senders: fake.senders, now: () => clock } });
    expect(fake.sent.map((sent) => sent.context.shaping.deadline_ms)).toEqual([1000, 600, 200]);
    expect(fake.sent[0]?.context.shaping).toBe(tool.shaping);
    expect(fake.sent.map((sent) => sent.args)).toEqual([{}, { starting_after: "cur_1" }, { starting_after: "cur_2" }]);
    expect(texts(call.result)[1]).toBe(
      "Auto paging stopped at the 1000 ms deadline: the result holds 3 items from 3 pages, and more may remain.",
    );
  });

  it("sends one request when the tool does not ask to page", async () => {
    const tool = manifestTool({ request: listRequest(["starting_after"]), paging: CURSOR });
    const { call, fake } = await run(tool, {}, () => chargesPage(1));
    expect(fake.requests).toHaveLength(1);
    expect(call.result.structuredContent).toEqual({ data: charges(0, 3), next_cursor: "cur_1" });
  });
});

describe("the recorded exchanges", () => {
  it("record each page as built, before the credential, with no Set-Cookie", async () => {
    const { call, fake } = await run(cursorTool({ max_items: 5 }), {}, (_request, n) =>
      chargesPage(n, [
        ["Set-Cookie", "session=s3cr3t"],
        ["X-Request-Id", `req_${n}`],
      ]),
    );
    expect(fake.requests.map((request) => header(request, "authorization"))).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(call.exchanges).toHaveLength(2);
    for (const exchange of call.exchanges) expect(recordedExchangeSchema.safeParse(exchange).success).toBe(true);
    const recorded = JSON.stringify(call.exchanges);
    expect(recorded).toContain("req_2");
    expect(recorded).not.toContain(TOKEN);
    expect(recorded).not.toContain("s3cr3t");
    expect(recorded.toLowerCase()).not.toContain("set-cookie");
    expect(recorded.toLowerCase()).not.toContain("authorization");
  });

  it("carry a new idempotency key for each page, and the same key on every retry of one page", async () => {
    const tool = cursorTool({ max_items: 5, idempotency_header: "Idempotency-Key" });
    const { fake } = await run(tool, {}, (_request, n) => (n === 1 ? reply(503) : chargesPage(n - 1)));
    const keys = fake.requests.map((request) => header(request, "idempotency-key"));
    expect(keys).toHaveLength(3);
    const [first, retry, second] = keys;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(retry).toBe(first);
    expect(second).toMatch(/^[0-9a-f]{8}-/);
    expect(second).not.toBe(first);
  });

  it("carry no idempotency key when the tool names no header", async () => {
    const { fake } = await run(cursorTool({ max_items: 5 }), {}, (_request, n) => chargesPage(n));
    expect(fake.requests.map((request) => header(request, "idempotency-key"))).toEqual([undefined, undefined]);
  });
});

describe("execute", () => {
  it("returns executeCall's result, through the default Senders", async () => {
    const tool = manifestTool();
    const answer: Answer = () => reply(200, { data: [{ id: "ch_1" }] });
    const environment = sandbox();
    const result = await execute(tool, {}, environment, fakeCredentials().source, fakeHttp(answer).transport);
    const full = await executeCall(tool, {}, environment, fakeCredentials().source, fakeHttp(answer).transport);
    expect(result).toEqual(full.result);
    expect(result).toEqual({
      content: [{ type: "text", text: '{"data":[{"id":"ch_1"}]}' }],
      structuredContent: { data: [{ id: "ch_1" }] },
    });
  });
});
