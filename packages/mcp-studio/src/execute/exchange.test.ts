// exchange.ts: headers, and the recorded form of an upstream response.
import { describe, expect, it } from "vitest";
import { encodeText } from "./body";
import { headerValue, recordHttpResponse, recordedBody, recordedResponseHeaders } from "./exchange";
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

describe("recordedResponseHeaders", () => {
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
});
