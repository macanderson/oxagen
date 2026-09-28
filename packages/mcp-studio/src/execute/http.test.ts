// http.ts: the request an OpenAPI operation builds, its retry rule, and how a
// response becomes a value or an error. A fake Transport stands in for the
// network, so each case is exact.
import { describe, expect, it } from "vitest";
import type { ManifestAuth } from "../contract/manifest";
import { recordedExchangeSchema } from "../contract/tests-files";
import type { HttpParameter, HttpRequest } from "../model/upstream-tool";
import { bodyJson, bodyText, fakeHttp, header, reply, sendContext, type ContextOptions } from "./__tests__/fake-http";
import { createHttpSender } from "./http";
import { parseEndpoint, sendFailure } from "./http-call";
import type { SendResult } from "./sender";
import { TransportError, type HttpTransportRequest, type HttpTransportResponse } from "./transport";
import { BuildError } from "./util";

const sender = createHttpSender({ backoff_ms: () => 1 });

function param(name: string, where: HttpParameter["in"], extra: Partial<HttpParameter> = {}): HttpParameter {
  return { name, in: where, property: name, required: false, ...extra };
}

function operation(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { kind: "http", operation: "op", method: "GET", path: "/things", parameters: [], ...overrides };
}

const LIST_CHARGES = operation({
  operation: "listCharges",
  path: "/customers/{customer_id}/charges",
  parameters: [param("customer_id", "path", { required: true }), param("limit", "query")],
  response: { status: "200", media_type: "application/json" },
});

const CREATE_REFUND = operation({
  operation: "createRefund",
  method: "POST",
  path: "/refunds",
  parameters: [param("X-Request-Source", "header")],
  body: { in: "spread", media_type: "application/json", required: true, properties: ["charge_id", "amount", "reason"] },
  response: { status: "201", media_type: "application/json" },
});

async function send(
  template: HttpRequest,
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

function failure(result: SendResult, title: string): { detail: string; status: number | undefined } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  expect(result.error.title).toBe(title);
  return result.error;
}

function built(template: HttpRequest, args: Record<string, unknown>): Promise<HttpTransportRequest> {
  return send(template, args, () => reply(200, {})).then(({ requests }) => only(requests));
}

describe("the request", () => {
  it("puts the base path, the encoded path parameter, and the query on the target", async () => {
    const { result, requests } = await send(LIST_CHARGES, { customer_id: "cus 81/x", limit: 2 }, () =>
      reply(200, { data: [] }),
    );
    const request = only(requests);
    expect(request.target).toEqual({
      kind: "http",
      scheme: "https",
      method: "GET",
      host: "api.example.com",
      path: "/v2/customers/cus%2081%2Fx/charges?limit=2",
    });
    expect(request.network).toBe("cloud");
    expect(request.deadline_ms).toBeGreaterThan(29_000);
    expect(request.body.byteLength).toBe(0);
    expect(header(request, "accept")).toBe("application/json");
    expect(header(request, "content-type")).toBeUndefined();
    expect(result).toMatchObject({ ok: true, value: { data: [] }, attempts: 1 });
  });

  it("records the request as built, before the credential", async () => {
    const auth: ManifestAuth = { mode: "service", scheme: "key", apply: { type: "api_key", in: "query", name: "api_key" } };
    const { result, requests } = await send(
      LIST_CHARGES,
      { customer_id: "cus_81", limit: 2 },
      () => reply(200, { data: [] }, [["Set-Cookie", "s=1"], ["X-Trace", "t1"]]),
      { auth, credential: { type: "api_key", value: "sk_live" } },
    );
    expect(only(requests).target.path).toBe("/v2/customers/cus_81/charges?limit=2&api_key=sk_live");
    const exchanges = result.exchanges ?? [];
    expect(exchanges).toEqual([
      {
        request: { method: "GET", path: "/customers/cus_81/charges", query: { limit: "2" } },
        response: { status: 200, headers: { "content-type": "application/json", "X-Trace": "t1" }, body: { data: [] } },
      },
    ]);
    expect(JSON.stringify(exchanges)).not.toContain("sk_live");
    expect(() => recordedExchangeSchema.parse(exchanges[0])).not.toThrow();
  });

  it("sends a JSON body, the header parameter, and the idempotency key, and records none of the credential", async () => {
    const args = { charge_id: "ch_3P9", amount: 4000, reason: "duplicate", "X-Request-Source": "oxagen" };
    const { result, requests } = await send(CREATE_REFUND, args, () => reply(201, { id: "re_1Q2" }), {
      credential: { type: "bearer", token: "tok_secret" },
      shaping: { idempotency_header: "Idempotency-Key" },
      idempotency_key: "key-1",
    });
    const request = only(requests);
    expect(request.headers).toEqual([
      ["X-Request-Source", "oxagen"],
      ["Accept", "application/json"],
      ["Content-Type", "application/json"],
      ["Idempotency-Key", "key-1"],
      ["Authorization", "Bearer tok_secret"],
    ]);
    expect(bodyJson(request)).toEqual({ charge_id: "ch_3P9", amount: 4000, reason: "duplicate" });
    expect(result.exchanges?.[0]?.request).toEqual({
      method: "POST",
      path: "/refunds",
      headers: { "X-Request-Source": "oxagen" },
      body: { charge_id: "ch_3P9", amount: 4000, reason: "duplicate" },
    });
    expect(JSON.stringify(result.exchanges)).not.toContain("tok_secret");
  });

  it("keeps an explicit port and drops the scheme's default", async () => {
    const odd = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(200, {}), { url: "http://10.0.0.5:8080/" });
    expect(only(odd.requests).target).toMatchObject({ scheme: "http", host: "10.0.0.5", port: 8080, path: "/customers/c/charges" });
    const plain = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(200, {}), { url: "https://API.example.com:443" });
    expect(only(plain.requests).target.port).toBeUndefined();
    expect(only(plain.requests).target.host).toBe("api.example.com");
  });

  it("passes a relay credential beside the request", async () => {
    const relay = { name: "billing-token", scheme: "bearer" as const };
    const { requests } = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(200, {}), {
      network: "relay:a-intel-east",
      credential: { type: "relay", credential: relay },
    });
    const request = only(requests);
    expect(request.relay_credential).toEqual(relay);
    expect(request.network).toBe("relay:a-intel-east");
    expect(header(request, "authorization")).toBeUndefined();
  });

  it("expands path parameters by style", async () => {
    const path = (p: HttpParameter, value: unknown): Promise<string> =>
      built(operation({ path: "/x/{v}", parameters: [p] }), { v: value }).then((r) => r.target.path);
    expect(await path(param("v", "path"), ["a b", "c"])).toBe("/v2/x/a%20b,c");
    expect(await path(param("v", "path"), { k: "1", j: "2" })).toBe("/v2/x/k,1,j,2");
    expect(await path(param("v", "path", { explode: true }), { k: "1" })).toBe("/v2/x/k=1");
    expect(await path(param("v", "path", { style: "label" }), "a")).toBe("/v2/x/.a");
    expect(await path(param("v", "path", { style: "label" }), ["a", "b"])).toBe("/v2/x/.a,b");
    expect(await path(param("v", "path", { style: "label", explode: true }), ["a", "b"])).toBe("/v2/x/.a.b");
    expect(await path(param("v", "path", { style: "label" }), { k: 1 })).toBe("/v2/x/.k,1");
    expect(await path(param("v", "path", { style: "label", explode: true }), { k: 1, j: true })).toBe("/v2/x/.k=1.j=true");
    expect(await path(param("v", "path", { style: "matrix" }), 5)).toBe("/v2/x/;v=5");
    expect(await path(param("v", "path", { style: "matrix" }), ["a", "b"])).toBe("/v2/x/;v=a,b");
    expect(await path(param("v", "path", { style: "matrix", explode: true }), ["a", "b"])).toBe("/v2/x/;v=a;v=b");
    expect(await path(param("v", "path", { style: "matrix" }), { k: "1" })).toBe("/v2/x/;v=k,1");
    expect(await path(param("v", "path", { style: "matrix", explode: true }), { k: "1", j: "2" })).toBe("/v2/x/;k=1;j=2");
  });

  it("serializes query parameters by style and records them raw", async () => {
    const query = async (p: HttpParameter, value: unknown): Promise<[string, unknown]> => {
      const { result, requests } = await send(operation({ parameters: [p] }), { q: value }, () => reply(200, {}));
      const recorded = result.exchanges?.[0]?.request;
      return [only(requests).target.path, recorded !== undefined && "query" in recorded ? recorded.query : undefined];
    };
    expect(await query(param("q", "query"), ["a", "b c"])).toEqual(["/v2/things?q=a&q=b%20c", { q: ["a", "b c"] }]);
    expect(await query(param("q", "query", { explode: false }), ["a", "b"])).toEqual(["/v2/things?q=a,b", { q: "a,b" }]);
    expect(await query(param("q", "query"), { k: "1", j: "2" })).toEqual(["/v2/things?k=1&j=2", { k: "1", j: "2" }]);
    expect(await query(param("q", "query", { explode: false }), { k: "1" })).toEqual(["/v2/things?q=k,1", { q: "k,1" }]);
    expect(await query(param("q", "query", { style: "spaceDelimited" }), ["a", "b"])).toEqual([
      "/v2/things?q=a%20b",
      { q: "a b" },
    ]);
    expect(await query(param("q", "query", { style: "pipeDelimited" }), ["a", "b"])).toEqual([
      "/v2/things?q=a|b",
      { q: "a|b" },
    ]);
    expect(await query(param("q", "query", { style: "pipeDelimited", explode: true }), ["a", "b"])).toEqual([
      "/v2/things?q=a&q=b",
      { q: ["a", "b"] },
    ]);
    expect(await query(param("q", "query", { style: "deepObject", explode: true }), { k: "1" })).toEqual([
      "/v2/things?q[k]=1",
      { "q[k]": "1" },
    ]);
    expect(await query(param("q", "query"), [])).toEqual(["/v2/things", undefined]);
    expect(await query(param("q", "query"), true)).toEqual(["/v2/things?q=true", { q: "true" }]);
  });

  it("leaves out a parameter with no value", async () => {
    const request = await built(operation({ parameters: [param("q", "query"), param("h", "header")] }), { q: null });
    expect(request.target.path).toBe("/v2/things");
    expect(header(request, "h")).toBeUndefined();
  });

  it("sends header parameters as written and skips the ones the Sender sets", async () => {
    const template = operation({
      parameters: [
        param("X-List", "header"),
        param("X-Obj", "header"),
        param("X-Exp", "header", { explode: true }),
        param("Accept", "header"),
        param("Authorization", "header"),
        param("Idempotency-Key", "header"),
      ],
    });
    const request = await send(
      template,
      { "X-List": ["a", "b"], "X-Obj": { k: "1" }, "X-Exp": { k: "1", j: "2" }, Accept: "text/html", Authorization: "x", "Idempotency-Key": "mine" },
      () => reply(200, {}),
      { shaping: { idempotency_header: "idempotency-key" }, idempotency_key: "k1" },
    ).then(({ requests }) => only(requests));
    expect(request.headers).toEqual([
      ["X-List", "a,b"],
      ["X-Obj", "k,1"],
      ["X-Exp", "k=1,j=2"],
      ["Accept", "application/json"],
      ["idempotency-key", "k1"],
    ]);
  });

  it("joins cookie parameters and an API key cookie into one Cookie header, unrecorded", async () => {
    const auth: ManifestAuth = { mode: "service", scheme: "key", apply: { type: "api_key", in: "cookie", name: "session" } };
    const { result, requests } = await send(
      operation({ parameters: [param("theme", "cookie"), param("ids", "cookie")] }),
      { theme: "dark", ids: [1, 2] },
      () => reply(200, {}),
      { auth, credential: { type: "api_key", value: "sess_1" } },
    );
    expect(header(only(requests), "cookie")).toBe("theme=dark; ids=1; ids=2; session=sess_1");
    expect(result.exchanges?.[0]?.request).toEqual({ method: "GET", path: "/things" });
  });

  it("serializes cookie parameters by the form style, exploded unless explode is false", async () => {
    const cookie = (p: HttpParameter, value: unknown): Promise<string | undefined> =>
      built(operation({ parameters: [p] }), { c: value }).then((r) => header(r, "cookie"));
    expect(await cookie(param("c", "cookie"), "blue")).toBe("c=blue");
    expect(await cookie(param("c", "cookie"), ["blue", "black"])).toBe("c=blue; c=black");
    expect(await cookie(param("c", "cookie"), { R: 100, G: 200 })).toBe("R=100; G=200");
    expect(await cookie(param("c", "cookie", { explode: true }), ["blue", "black"])).toBe("c=blue; c=black");
    expect(await cookie(param("c", "cookie", { explode: false }), "blue")).toBe("c=blue");
    expect(await cookie(param("c", "cookie", { explode: false }), ["blue", "black"])).toBe("c=blue,black");
    expect(await cookie(param("c", "cookie", { explode: false }), { R: 100, G: 200 })).toBe("c=R,100,G,200");
    expect(await cookie(param("c", "cookie"), [])).toBeUndefined();
  });

  it("sends no parameter cookie that takes the API key cookie's name", async () => {
    const auth: ManifestAuth = { mode: "service", scheme: "key", apply: { type: "api_key", in: "cookie", name: "session" } };
    const { requests } = await send(
      operation({ parameters: [param("prefs", "cookie")] }),
      { prefs: { lang: "en", session: "forged" } },
      () => reply(200, {}),
      { auth, credential: { type: "api_key", value: "sess_1" } },
    );
    expect(header(only(requests), "cookie")).toBe("lang=en; session=sess_1");
  });

  it("sends form and text bodies", async () => {
    const form = await built(
      operation({ method: "POST", body: { in: "property", property: "body", media_type: "application/x-www-form-urlencoded", required: true } }),
      { body: { a: "1 2", b: [true, 3, undefined], c: null, d: { x: 1 }, e: undefined } },
    );
    expect(bodyText(form)).toBe("a=1+2&b=true&b=3&c=null&d=%7B%22x%22%3A1%7D");
    expect(header(form, "content-type")).toBe("application/x-www-form-urlencoded");
    const text = await built(
      operation({ method: "PUT", body: { in: "property", property: "body", media_type: "text/plain", required: false } }),
      { body: "hello" },
    );
    expect(bodyText(text)).toBe("hello");
  });

  it("sends no body when an optional one has no properties", async () => {
    const request = await built(
      operation({ method: "PATCH", body: { in: "spread", media_type: "application/json", required: false, properties: ["a"] } }),
      {},
    );
    expect(request.body.byteLength).toBe(0);
    expect(header(request, "content-type")).toBeUndefined();
    const optional = await built(
      operation({ method: "PATCH", body: { in: "property", property: "body", media_type: "application/json", required: false } }),
      {},
    );
    expect(optional.body.byteLength).toBe(0);
    const required = await built(
      operation({ method: "POST", body: { in: "spread", media_type: "application/json", required: true, properties: ["a"] } }),
      {},
    );
    expect(bodyJson(required)).toEqual({});
  });
});

describe("a request that cannot be built", () => {
  const refused = async (
    template: HttpRequest,
    args: Record<string, unknown>,
    title: string,
    options: Omit<ContextOptions, "transport"> = {},
  ): Promise<string> => {
    const { result, requests } = await send(template, args, () => reply(200, {}), options);
    expect(requests).toHaveLength(0);
    expect(result.attempts).toBe(0);
    return failure(result, title).detail;
  };

  it("refuses an environment url the gateway cannot send to", async () => {
    const args = { customer_id: "c" };
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: undefined })).toContain("no url");
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: "not a url" })).toContain("does not parse");
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: "ftp://a.example.com" })).toContain("ftp");
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: "https://u:p@a.example.com" })).toContain(
      "user name",
    );
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: "https://a.example.com/#x" })).toContain(
      "fragment",
    );
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: "https://[::1]/" })).toContain("IPv6");
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: "https://a.example.com/v2?x=1" })).toContain(
      "query",
    );
    expect(await refused(LIST_CHARGES, args, "Invalid environment", { url: "https://a_b.example.com/" })).toContain(
      "host name",
    );
  });

  it("refuses a path parameter with no value or no parameter", async () => {
    expect(await refused(LIST_CHARGES, {}, "Invalid arguments")).toContain("customer_id");
    expect(await refused(LIST_CHARGES, { customer_id: "" }, "Invalid arguments")).toContain("empty");
    expect(await refused(operation({ path: "/x/{id}" }), { id: "1" }, "Invalid request")).toContain("{id}");
    expect(
      await refused(operation({ path: "/x/{v}", parameters: [param("v", "path", { style: "form" })] }), { v: "1" }, "Invalid request"),
    ).toContain("form");
    expect(await refused(operation({ path: "/x/{v}", parameters: [param("v", "path")] }), { v: [[1]] }, "Invalid arguments")).toContain(
      "nested",
    );
  });

  it("refuses a query parameter its style cannot carry", async () => {
    expect(
      await refused(operation({ parameters: [param("q", "query", { style: "deepObject" })] }), { q: ["a"] }, "Invalid arguments"),
    ).toContain("deepObject");
    expect(
      await refused(operation({ parameters: [param("q", "query", { style: "matrix" })] }), { q: ["a"] }, "Invalid request"),
    ).toContain("matrix");
  });

  it("refuses a header or cookie that would break the request", async () => {
    expect(await refused(operation({ parameters: [param("X-A", "header")] }), { "X-A": "a\r\nX-B: 1" }, "Invalid arguments")).toContain(
      "line break",
    );
    expect(await refused(operation({ parameters: [param("X A", "header")] }), { "X A": "a" }, "Invalid request")).toContain(
      "token",
    );
    expect(await refused(operation({ parameters: [param("c", "cookie")] }), { c: "a;b" }, "Invalid arguments")).toContain(
      "semicolon",
    );
    expect(await refused(operation({ parameters: [param("c", "cookie")] }), { c: ["a", "b;x=1"] }, "Invalid arguments")).toContain(
      "semicolon",
    );
    expect(await refused(operation({ parameters: [param("c", "cookie")] }), { c: { "x=y; z": "1" } }, "Invalid arguments")).toContain(
      "token",
    );
  });

  it("refuses a body it cannot encode", async () => {
    const multipart = operation({
      method: "POST",
      body: { in: "property", property: "body", media_type: "multipart/form-data", required: true },
    });
    expect(await refused(multipart, { body: {} }, "Unsupported body")).toContain("multipart/form-data");
    const text = operation({ method: "POST", body: { in: "property", property: "body", media_type: "text/plain", required: true } });
    expect(await refused(text, { body: 1 }, "Invalid arguments")).toContain("string");
    expect(await refused(text, {}, "Invalid arguments")).toContain("required");
    const form = operation({
      method: "POST",
      body: { in: "property", property: "body", media_type: "application/x-www-form-urlencoded", required: true },
    });
    expect(await refused(form, { body: "a=1" }, "Invalid arguments")).toContain("object");
    expect(await refused(form, { body: { f: () => 1 } }, "Invalid arguments")).toContain("function");
  });

  it("refuses a credential the scheme cannot place", async () => {
    expect(await refused(LIST_CHARGES, { customer_id: "c" }, "Invalid credential", { credential: { type: "api_key", value: "k" } })).toContain(
      "api_key",
    );
  });

  it("refuses a target longer than a relay envelope allows", async () => {
    expect(await refused(LIST_CHARGES, { customer_id: "c".repeat(9000) }, "Invalid request")).toContain("path");
  });
});

describe("the retry rule", () => {
  const busy = (status: number, headers: Array<[string, string]> = []) => reply(status, { title: "Busy" }, headers);

  it("retries a GET on 429, 502, 503, and 504, then succeeds", async () => {
    for (const status of [429, 502, 503, 504]) {
      const { result, requests } = await send(LIST_CHARGES, { customer_id: "c" }, (_r, n) =>
        n === 1 ? busy(status, [["Retry-After", "0"]]) : reply(200, { ok: true }),
      );
      expect(requests).toHaveLength(2);
      expect(result).toMatchObject({ ok: true, value: { ok: true }, attempts: 2 });
      expect(result.exchanges).toHaveLength(1);
      expect(result.exchanges?.[0]?.response).toMatchObject({ status: 200 });
    }
  });

  it("stops after 4 attempts with the last error", async () => {
    const { result, requests } = await send(LIST_CHARGES, { customer_id: "c" }, () => busy(503));
    expect(requests).toHaveLength(4);
    expect(result.attempts).toBe(4);
    expect(failure(result, "Busy").status).toBe(503);
    expect(result.exchanges?.[0]?.response).toMatchObject({ status: 503 });
  });

  it("retries HEAD, OPTIONS, PUT, DELETE, and a keyed POST", async () => {
    for (const method of ["HEAD", "OPTIONS", "PUT", "DELETE"] as const) {
      const { requests } = await send(operation({ method }), {}, (_r, n) => (n === 1 ? busy(502) : reply(204)));
      expect(requests).toHaveLength(2);
    }
    const { requests } = await send(CREATE_REFUND, {}, (_r, n) => (n === 1 ? busy(429) : reply(201, {})), {
      shaping: { idempotency_header: "Idempotency-Key" },
      idempotency_key: "k1",
    });
    expect(requests.map((r) => header(r, "idempotency-key"))).toEqual(["k1", "k1"]);
  });

  it("never retries a POST with no key, a PATCH, or another status", async () => {
    expect((await send(CREATE_REFUND, {}, () => busy(503))).requests).toHaveLength(1);
    expect((await send(operation({ method: "PATCH" }), {}, () => busy(503), { idempotency_key: "k" })).requests).toHaveLength(1);
    const { result, requests } = await send(LIST_CHARGES, { customer_id: "c" }, () => busy(500));
    expect(requests).toHaveLength(1);
    expect(failure(result, "Busy").status).toBe(500);
  });

  it("never retries a transport failure", async () => {
    const { result, requests } = await send(LIST_CHARGES, { customer_id: "c" }, () => {
      throw new TransportError("not_sent", "The connection was refused.", false);
    });
    expect(requests).toHaveLength(1);
    expect(failure(result, "Not sent").detail).toBe("The connection was refused.");
    expect(result.exchanges).toEqual([]);
  });

  it("names a refused address and a refused redirect", async () => {
    const refusedAddress = await send(LIST_CHARGES, { customer_id: "c" }, () =>
      Promise.reject(new TransportError("refused_address", "10.0.0.1 is a private address.", false)),
    );
    expect(failure(refusedAddress.result, "Address refused").detail).toContain("private");
    const refusedRedirect = await send(LIST_CHARGES, { customer_id: "c" }, () =>
      Promise.reject(new TransportError("refused_redirect", "The upstream redirected to evil.example.com.", true)),
    );
    failure(refusedRedirect.result, "Redirect refused");
  });

  it("gives up when a retry could not start before the deadline", async () => {
    const { result, requests } = await send(LIST_CHARGES, { customer_id: "c" }, () => busy(503, [["Retry-After", "60"]]), {
      shaping: { deadline_ms: 1_000 },
    });
    expect(requests).toHaveLength(1);
    failure(result, "Busy");
  });
});

describe("the response", () => {
  it("reads a problem+json title and detail", async () => {
    const { result } = await send(LIST_CHARGES, { customer_id: "c" }, () =>
      reply(404, { type: "about:blank", title: "Not found", detail: "No customer c." }, [["content-type", "application/problem+json"]]),
    );
    expect(failure(result, "Not found")).toEqual({ title: "Not found", detail: "No customer c.", status: 404 });
  });

  it("falls back to a message field, the text, or the status", async () => {
    const message = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(400, { message: "Bad limit." }));
    expect(failure(message.result, "Upstream error").detail).toBe("Bad limit.");
    const text = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(500, "  boom  ", [["content-type", "text/plain"]]));
    expect(failure(text.result, "Upstream error").detail).toBe("boom");
    const empty = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(401));
    expect(failure(empty.result, "Upstream error").detail).toBe("The upstream answered 401.");
    const long = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(400, { detail: "x".repeat(2000) }));
    expect(failure(long.result, "Upstream error").detail).toHaveLength(1001);
    const badJson = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(400, "{", [["content-type", "application/json"]]));
    expect(failure(badJson.result, "Upstream error").detail).toBe("{");
  });

  it("names the Location of a redirect it did not follow", async () => {
    const { result } = await send(LIST_CHARGES, { customer_id: "c" }, () =>
      reply(302, undefined, [["Location", "https://api.example.com/v3/customers/c/charges"]]),
    );
    const error = failure(result, "Redirect not followed");
    expect(error.status).toBe(302);
    expect(error.detail).toContain("Location https://api.example.com/v3/customers/c/charges");
    const bare = await send(LIST_CHARGES, { customer_id: "c" }, () => reply(307));
    expect(failure(bare.result, "Redirect not followed").detail).toContain("answered 307.");
  });

  it("returns nothing for an empty 2xx, the text for a non-JSON body, and wraps a list", async () => {
    expect((await send(operation(), {}, () => reply(204))).result).toMatchObject({ ok: true, value: undefined });
    expect((await send(operation(), {}, () => reply(200, "plain", [["content-type", "text/plain"]]))).result).toMatchObject({
      ok: true,
      value: "plain",
    });
    const wrapped = operation({ response: { status: "200", media_type: "application/json", wrap: "items" } });
    expect((await send(wrapped, {}, () => reply(200, [1, 2]))).result).toMatchObject({ ok: true, value: { items: [1, 2] } });
    expect((await send(wrapped, {}, () => reply(200, "[3]"))).result).toMatchObject({ ok: true, value: { items: [3] } });
  });

  it("refuses a 2xx whose JSON does not parse", async () => {
    const { result } = await send(operation(), {}, () => reply(200, "{", [["content-type", "application/json"]]));
    expect(failure(result, "Invalid response").status).toBe(200);
  });
});

describe("the deadline and cancel", () => {
  const never = (): Promise<HttpTransportResponse> => new Promise(() => undefined);

  it("ends a send that outlives the deadline", async () => {
    const { result } = await send(LIST_CHARGES, { customer_id: "c" }, never, { shaping: { deadline_ms: 20 } });
    expect(failure(result, "Deadline exceeded").detail).toContain("20 ms");
  });

  it("releases a response that arrives after the deadline", async () => {
    const late = reply(200, {});
    const { result } = await send(
      LIST_CHARGES,
      { customer_id: "c" },
      () => new Promise<HttpTransportResponse>((resolve) => setTimeout(() => resolve(late), 40)),
      { shaping: { deadline_ms: 10 } },
    );
    failure(result, "Deadline exceeded");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(late.cancel).toHaveBeenCalled();
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = send(LIST_CHARGES, { customer_id: "c" }, never, { signal: controller.signal });
    controller.abort();
    failure((await pending).result, "Cancelled");
  });
});

describe("the shared helpers", () => {
  it("keeps an endpoint's query for an MCP or GraphQL url", () => {
    expect(parseEndpoint("https://mcp.example.com/mcp?v=1", "endpoint").path).toBe("/mcp?v=1");
    expect(parseEndpoint("https://api.example.com/v2/", "base").path).toBe("/v2");
  });

  it("names a defect as an internal error and keeps a build error's title", () => {
    expect(sendFailure(new Error("boom"), "HTTP")).toEqual({
      ok: false,
      error: { title: "Internal error", detail: "The HTTP Sender failed: boom", status: undefined },
      attempts: 0,
    });
    expect(sendFailure(new BuildError("Invalid request", "No."), "HTTP")).toMatchObject({
      error: { title: "Invalid request", detail: "No." },
    });
  });
});
