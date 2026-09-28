// exchange.ts: headers, and the recorded form of an upstream response.
import { describe, expect, it } from "vitest";
import { encodeText } from "./body";
import {
  headerValue,
  locationWithoutQuery,
  recordHttpResponse,
  recordedBody,
  recordedResponseHeaders,
} from "./exchange";
import type { HttpTransportResponse } from "./transport";

const empty: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: () => ({
    next: (): Promise<IteratorResult<Uint8Array>> => Promise.resolve({ done: true, value: undefined }),
  }),
};

function response(status: number, headers: [string, string][]): HttpTransportResponse {
  return { status, headers, body: empty, cancel: () => undefined };
}

describe("headerValue", () => {
  it("finds a header in any case and joins repeats", () => {
    expect(headerValue([["Content-Type", "application/json"]], "content-type")).toBe("application/json");
    expect(
      headerValue(
        [
          ["Vary", "Accept"],
          ["vary", "Origin"],
        ],
        "VARY",
      ),
    ).toBe("Accept, Origin");
    expect(headerValue([], "retry-after")).toBeUndefined();
  });
});

describe("locationWithoutQuery", () => {
  it("keeps an absolute url's scheme, host, port, and path, and drops its query and fragment", () => {
    expect(locationWithoutQuery("https://api.example.com/v1/charges?api_key=sk_live_secret&limit=10#top")).toBe(
      "https://api.example.com/v1/charges",
    );
    expect(locationWithoutQuery("http://localhost:8080/v1/charges?api_key=sk_live_secret")).toBe(
      "http://localhost:8080/v1/charges",
    );
    expect(locationWithoutQuery("https://api.example.com/v1/charges")).toBe("https://api.example.com/v1/charges");
  });

  it("drops a user name and password from an absolute url", () => {
    expect(locationWithoutQuery("https://user:sk_live_secret@api.example.com/v1")).toBe("https://api.example.com/v1");
  });

  it("cuts a relative or unparseable value at its first ? or #", () => {
    expect(locationWithoutQuery("/v1/charges?api_key=sk_live_secret")).toBe("/v1/charges");
    expect(locationWithoutQuery("charges#api_key=sk_live_secret")).toBe("charges");
    expect(locationWithoutQuery("not a url?api_key=sk_live_secret")).toBe("not a url");
    expect(locationWithoutQuery("/v1/charges")).toBe("/v1/charges");
  });

  it("drops a user name and password from a scheme-relative url", () => {
    expect(locationWithoutQuery("//user:sk_live_secret@api.example.com/v1?api_key=sk_live_secret")).toBe(
      "//api.example.com/v1",
    );
    expect(locationWithoutQuery("//api.example.com/v1")).toBe("//api.example.com/v1");
  });

  it("gives the same value when applied twice", () => {
    for (const location of [
      "https://api.example.com/v1/charges?api_key=sk_live_secret#top",
      "https://user:pass@api.example.com",
      "//user:sk_live_secret@api.example.com/v1",
      "/v1/charges?api_key=sk_live_secret",
      "not a url#fragment",
    ]) {
      const once = locationWithoutQuery(location);
      expect(once).not.toContain("sk_live_secret");
      expect(locationWithoutQuery(once)).toBe(once);
    }
  });
});

describe("recordedResponseHeaders", () => {
  it("keeps a Location without the query that carried the API key", () => {
    const recorded = recordedResponseHeaders([
      ["Location", "https://api.example.com/v1/charges?api_key=sk_live_secret#page"],
      ["content-type", "text/html"],
    ]);
    expect(recorded).toEqual({ Location: "https://api.example.com/v1/charges", "content-type": "text/html" });
    expect(JSON.stringify(recorded)).not.toContain("sk_live_secret");
  });

  it("drops Set-Cookie in any case and joins repeats of one name", () => {
    expect(
      recordedResponseHeaders([
        ["content-type", "application/json"],
        ["Set-Cookie", "session=secret"],
        ["set-cookie", "other=secret"],
        ["x-trace", "1"],
        ["x-trace", "2"],
      ]),
    ).toEqual({ "content-type": "application/json", "x-trace": "1, 2" });
  });

  it("records nothing when no header remains", () => {
    expect(recordedResponseHeaders([])).toBeUndefined();
    expect(recordedResponseHeaders([["SET-COOKIE", "session=secret"]])).toBeUndefined();
  });
});

describe("recordedBody", () => {
  it("records nothing for an empty body", () => {
    expect(recordedBody(new Uint8Array(0), "application/json")).toBeUndefined();
  });

  it("parses a JSON body", () => {
    expect(recordedBody(encodeText('{"id":"re_1Q2"}'), "application/json; charset=utf-8")).toEqual({ id: "re_1Q2" });
  });

  it("keeps the text of a JSON body that does not parse, and of any other type", () => {
    expect(recordedBody(encodeText("{oops"), "application/json")).toBe("{oops");
    expect(recordedBody(encodeText('{"a":1}'), "text/plain")).toBe('{"a":1}');
    expect(recordedBody(encodeText("ok"), undefined)).toBe("ok");
  });
});

describe("recordHttpResponse", () => {
  it("records the status, the kept headers, and the body", () => {
    const recorded = recordHttpResponse(
      response(201, [
        ["content-type", "application/json"],
        ["set-cookie", "session=secret"],
      ]),
      encodeText('{"id":"re_1Q2","amount":4000,"status":"succeeded"}'),
    );
    expect(recorded).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      body: { id: "re_1Q2", amount: 4000, status: "succeeded" },
    });
  });

  it("leaves out empty headers and an empty body", () => {
    const recorded = recordHttpResponse(response(204, []), new Uint8Array(0));
    expect(recorded).toEqual({ status: 204 });
    expect(Object.keys(recorded)).toEqual(["status"]);
  });

  it("records a redirect's Location without its query", () => {
    const recorded = recordHttpResponse(
      response(301, [["location", "/v1/charges?api_key=sk_live_secret"]]),
      new Uint8Array(0),
    );
    expect(recorded).toEqual({ status: 301, headers: { location: "/v1/charges" } });
  });

  it("leaves out a redirect's body, which can echo the url and its query", () => {
    const bytes = encodeText('<a href="/v1/charges?api_key=sk_live_secret">Moved</a>');
    const recorded = recordHttpResponse(
      response(302, [
        ["content-type", "text/html"],
        ["location", "/v1/charges?api_key=sk_live_secret"],
      ]),
      bytes,
    );
    expect(recorded).toEqual({ status: 302, headers: { "content-type": "text/html", location: "/v1/charges" } });
    expect(JSON.stringify(recorded)).not.toContain("sk_live_secret");
  });

  it("keeps the body of a response that is not a redirect", () => {
    const recorded = recordHttpResponse(response(404, [["content-type", "text/plain"]]), encodeText("not found"));
    expect(recorded).toEqual({ status: 404, headers: { "content-type": "text/plain" }, body: "not found" });
  });
});
