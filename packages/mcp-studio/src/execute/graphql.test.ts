// graphql.ts: the document a GraphQL root field builds, its retry rule, and
// how a response becomes a value or an error. A fake Transport stands in for
// the network, so each case is exact.
import { describe, expect, it } from "vitest";
import type { ManifestAuth } from "../contract/manifest";
import { recordedExchangeSchema } from "../contract/tests-files";
import type { GraphqlRequest } from "../model/upstream-tool";
import { bodyJson, fakeHttp, header, reply, sendContext, type ContextOptions } from "./__tests__/fake-http";
import { createGraphqlSender, graphqlDocument } from "./graphql";
import { MAX_ATTEMPTS } from "./retry";
import type { SendError, SendResult } from "./sender";
import { TransportError, type HttpTransportRequest, type HttpTransportResponse } from "./transport";

const sender = createGraphqlSender({ backoff_ms: () => 1 });

function field(overrides: Partial<GraphqlRequest> = {}): GraphqlRequest {
  return {
    kind: "graphql",
    operation_type: "query",
    field: "Query.charges",
    arguments: [
      { name: "customer", type: "ID!", property: "customer_id" },
      { name: "first", type: "Int", property: "limit" },
    ],
    selection: "{ id amount }",
    ...overrides,
  };
}

const CHARGES = field();

const CREATE_REFUND = field({
  operation_type: "mutation",
  field: "Mutation.createRefund",
  arguments: [{ name: "charge", type: "ID!", property: "charge_id" }],
  selection: "{ id status }",
});

async function send(
  template: GraphqlRequest,
  args: Record<string, unknown>,
  answer: (request: HttpTransportRequest, number: number) => Promise<HttpTransportResponse> | HttpTransportResponse,
  options: Omit<ContextOptions, "transport"> = {},
): Promise<{ result: SendResult; requests: HttpTransportRequest[] }> {
  const fake = fakeHttp(answer);
  const result = await sender.send(template, args, sendContext({ transport: fake.transport, ...options }));
  return { result, requests: fake.requests };
}

function only(requests: HttpTransportRequest[]): HttpTransportRequest {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request === undefined) throw new Error("no request");
  return request;
}

function failure(result: SendResult, title: string): SendError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  expect(result.error.title).toBe(title);
  return result.error;
}

const DATA = { data: { charges: [{ id: "ch_1", amount: 4000 }] } };

describe("the document", () => {
  it("declares and passes each argument the call carries, as a variable", () => {
    expect(graphqlDocument(CHARGES, { customer_id: "cus_81", limit: 2 })).toEqual({
      query: "query Charges($customer: ID!, $first: Int) { charges(customer: $customer, first: $first) { id amount } }",
      variables: { customer: "cus_81", first: 2 },
    });
  });

  it("leaves out an absent argument and passes an explicit null", () => {
    expect(graphqlDocument(CHARGES, { customer_id: "cus_81" })).toEqual({
      query: "query Charges($customer: ID!) { charges(customer: $customer) { id amount } }",
      variables: { customer: "cus_81" },
    });
    expect(graphqlDocument(CHARGES, { customer_id: "cus_81", limit: null })).toEqual({
      query: "query Charges($customer: ID!, $first: Int) { charges(customer: $customer, first: $first) { id amount } }",
      variables: { customer: "cus_81", first: null },
    });
  });

  it("has no variables when the call carries no argument", () => {
    const document = graphqlDocument(CHARGES, {});
    expect(document).toEqual({ query: "query Charges { charges { id amount } }" });
    expect(Object.hasOwn(document, "variables")).toBe(false);
  });

  it("wraps a selection written without braces, and sends a scalar field with none", () => {
    expect(graphqlDocument(field({ selection: "  id amount  " }), {}).query).toBe("query Charges { charges { id amount } }");
    expect(graphqlDocument(field({ selection: undefined }), {}).query).toBe("query Charges { charges }");
  });

  it("names a mutation after its field", () => {
    expect(graphqlDocument(CREATE_REFUND, { charge_id: "ch_3P9" }).query).toBe(
      "mutation CreateRefund($charge: ID!) { createRefund(charge: $charge) { id status } }",
    );
  });

  it("takes a field with no root prefix as it is", () => {
    expect(graphqlDocument(field({ field: "charges" }), {}).query).toBe("query Charges { charges { id amount } }");
  });
});

describe("the request", () => {
  it("posts the document to the endpoint and records it as sent", async () => {
    const { result, requests } = await send(CHARGES, { customer_id: "cus_81", limit: 2 }, () => reply(200, DATA));
    const request = only(requests);
    expect(request.target).toEqual({ kind: "http", scheme: "https", method: "POST", host: "api.example.com", path: "/v2" });
    expect(request.network).toBe("cloud");
    expect(request.deadline_ms).toBeGreaterThan(29_000);
    expect(request.headers).toEqual([
      ["Accept", "application/graphql-response+json, application/json"],
      ["Content-Type", "application/json"],
    ]);
    const document = graphqlDocument(CHARGES, { customer_id: "cus_81", limit: 2 });
    expect(bodyJson(request)).toEqual(document);
    expect(result).toMatchObject({ ok: true, value: { items: DATA.data.charges }, attempts: 1 });
    const exchange = result.exchanges?.[0];
    expect(exchange?.request).toEqual(document);
    expect(exchange?.response).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: DATA,
    });
    expect(() => recordedExchangeSchema.parse(exchange)).not.toThrow();
  });

  it("sends the idempotency key only when the tool names its header", async () => {
    const keyed = await send(CREATE_REFUND, { charge_id: "ch_3P9" }, () => reply(200, { data: { createRefund: {} } }), {
      shaping: { idempotency_header: "Idempotency-Key" },
      idempotency_key: "key-1",
    });
    expect(header(only(keyed.requests), "idempotency-key")).toBe("key-1");
    const plain = await send(CREATE_REFUND, { charge_id: "ch_3P9" }, () => reply(200, { data: { createRefund: {} } }), {
      idempotency_key: "key-1",
    });
    expect(header(only(plain.requests), "idempotency-key")).toBeUndefined();
  });

  it("puts a bearer token in a header and records none of it", async () => {
    const { result, requests } = await send(CHARGES, { customer_id: "c" }, () => reply(200, DATA), {
      credential: { type: "bearer", token: "tok_secret" },
    });
    expect(header(only(requests), "authorization")).toBe("Bearer tok_secret");
    expect(JSON.stringify(result.exchanges)).not.toContain("tok_secret");
  });

  it("adds a query key after the endpoint's own query and records none of it", async () => {
    const auth: ManifestAuth = { mode: "service", scheme: "key", apply: { type: "api_key", in: "query", name: "key" } };
    const { result, requests } = await send(CHARGES, { customer_id: "c" }, () => reply(200, DATA), {
      url: "https://api.example.com/graphql?v=1",
      auth,
      credential: { type: "api_key", value: "k 1" },
    });
    expect(only(requests).target.path).toBe("/graphql?v=1&key=k%201");
    const recorded = JSON.stringify(result.exchanges);
    expect(recorded).not.toContain("k 1");
    expect(recorded).not.toContain("k%201");
  });

  it("puts a cookie key in the Cookie header", async () => {
    const auth: ManifestAuth = { mode: "service", scheme: "key", apply: { type: "api_key", in: "cookie", name: "session" } };
    const { requests } = await send(CHARGES, { customer_id: "c" }, () => reply(200, DATA), {
      auth,
      credential: { type: "api_key", value: "sess_1" },
    });
    expect(header(only(requests), "cookie")).toBe("session=sess_1");
  });

  it("passes a relay credential beside the request", async () => {
    const relay = { name: "billing-token", scheme: "bearer" as const };
    const { requests } = await send(CHARGES, { customer_id: "c" }, () => reply(200, DATA), {
      network: "relay:a-intel-east",
      credential: { type: "relay", credential: relay },
    });
    const request = only(requests);
    expect(request.relay_credential).toEqual(relay);
    expect(request.network).toBe("relay:a-intel-east");
    expect(header(request, "authorization")).toBeUndefined();
  });

  it("sends nothing when the environment has no url", async () => {
    const { result, requests } = await send(CHARGES, { customer_id: "c" }, () => reply(200, DATA), { url: undefined });
    expect(requests).toHaveLength(0);
    expect(failure(result, "Invalid environment").detail).toBe("The environment has no url, so the call has no host.");
    expect(result.attempts).toBe(0);
    expect(result.exchanges).toBeUndefined();
  });
});

describe("the response", () => {
  it("returns an object field as it is and a null field as null", async () => {
    const refund = await send(CREATE_REFUND, { charge_id: "ch_3P9" }, () =>
      reply(200, { data: { createRefund: { id: "re_1", status: "pending" } } }),
    );
    expect(refund.result).toMatchObject({ ok: true, value: { id: "re_1", status: "pending" } });
    const empty = await send(CHARGES, {}, () => reply(200, { data: { charges: null } }));
    expect(empty.result).toMatchObject({ ok: true, value: null });
  });

  it("reads the body as JSON whatever its content type says", async () => {
    const { result } = await send(CHARGES, {}, () =>
      reply(200, JSON.stringify(DATA), [["content-type", "application/graphql-response+json"]]),
    );
    expect(result).toMatchObject({ ok: true, value: { items: DATA.data.charges } });
  });

  it("treats an errors array as an error even on a 200", async () => {
    const { result, requests } = await send(CHARGES, { customer_id: "c" }, () =>
      reply(200, { data: null, errors: [{ message: "Customer not found" }, { extensions: { code: "X" } }] }),
    );
    expect(requests).toHaveLength(1);
    expect(failure(result, "GraphQL error")).toEqual({
      title: "GraphQL error",
      detail: 'Customer not found; {"extensions":{"code":"X"}}',
      status: 200,
    });
    expect(result.exchanges).toHaveLength(1);
  });

  it("cuts a long errors detail at 1000 characters", async () => {
    const { result } = await send(CHARGES, {}, () => reply(200, { errors: [{ message: "x".repeat(1500) }] }));
    expect(failure(result, "GraphQL error").detail).toBe(`${"x".repeat(1000)}…`);
  });

  it("gives a non-2xx with no errors array the upstream's problem title and detail", async () => {
    const { result } = await send(CHARGES, {}, () =>
      reply(400, { title: "Bad Request", detail: "Variable $customer is required." }),
    );
    expect(failure(result, "Bad Request")).toEqual({
      title: "Bad Request",
      detail: "Variable $customer is required.",
      status: 400,
    });
  });

  it("refuses to follow a redirect", async () => {
    const { result, requests } = await send(CHARGES, {}, () =>
      reply(307, undefined, [["location", "https://other.example.com/graphql"]]),
    );
    expect(requests).toHaveLength(1);
    expect(failure(result, "Redirect not followed").detail).toContain("https://other.example.com/graphql");
  });

  it.each([
    ["no body", () => reply(200), "The upstream answered 200 with no body."],
    ["JSON that does not parse", () => reply(200, "{not json"), "The upstream answered 200 with JSON that does not parse"],
    ["no data object", () => reply(200, { errors: [] }), "The upstream answered 200 with no data object."],
    ["a data list", () => reply(200, { data: [] }), "The upstream answered 200 with no data object."],
    ["no such field", () => reply(200, { data: { other: 1 } }), "The response's data has no charges field."],
  ])("calls a 200 with %s an invalid response", async (_name, answer, detail) => {
    const { result, requests } = await send(CHARGES, {}, answer);
    expect(requests).toHaveLength(1);
    const error = failure(result, "Invalid response");
    expect(error.detail).toContain(detail);
    expect(error.status).toBe(200);
  });
});

describe("retries", () => {
  it("retries a query on 503, even when the answer carries errors", async () => {
    const { result, requests } = await send(CHARGES, { customer_id: "c" }, (_request, number) =>
      number === 1 ? reply(503, { errors: [{ message: "busy" }] }) : reply(200, DATA),
    );
    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, value: { items: DATA.data.charges }, attempts: 2 });
  });

  it.each([429, 502, 504])("retries a query on %i", async (status) => {
    const { result, requests } = await send(CHARGES, {}, (_request, number) =>
      number === 1 ? reply(status, undefined, [["retry-after", "0"]]) : reply(200, DATA),
    );
    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  it("gives up after the last attempt and returns its error", async () => {
    const { result, requests } = await send(CHARGES, {}, () => reply(502, "Bad Gateway"));
    expect(requests).toHaveLength(MAX_ATTEMPTS);
    expect(failure(result, "Upstream error")).toEqual({ title: "Upstream error", detail: "Bad Gateway", status: 502 });
    expect(result.attempts).toBe(MAX_ATTEMPTS);
  });

  it("never retries a mutation", async () => {
    const { result, requests } = await send(CREATE_REFUND, { charge_id: "ch_3P9" }, () => reply(503, "Service Unavailable"));
    expect(requests).toHaveLength(1);
    expect(failure(result, "Upstream error")).toEqual({
      title: "Upstream error",
      detail: "Service Unavailable",
      status: 503,
    });
    expect(result.attempts).toBe(1);
  });

  it("never retries a mutation whose 503 carries errors", async () => {
    const { result, requests } = await send(CREATE_REFUND, { charge_id: "ch_3P9" }, () =>
      reply(503, { errors: [{ message: "busy" }] }),
    );
    expect(requests).toHaveLength(1);
    expect(failure(result, "GraphQL error").status).toBe(503);
  });

  it("does not retry a query on a status outside the retry list", async () => {
    const { requests } = await send(CHARGES, {}, () => reply(500, "boom"));
    expect(requests).toHaveLength(1);
  });

  it("reports a refused address without a retry", async () => {
    const { result, requests } = await send(CHARGES, {}, () => {
      throw new TransportError("refused_address", "api.example.com resolves to a private address.", false);
    });
    expect(requests).toHaveLength(1);
    expect(failure(result, "Address refused").status).toBeUndefined();
    expect(result.exchanges).toEqual([]);
  });
});
