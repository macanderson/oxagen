// http-call.ts: the error for a response that is not a success.
import { describe, expect, it } from "vitest";
import { reply } from "./__tests__/fake-http";
import { recordHttpResponse } from "./exchange";
import { upstreamError } from "./http-call";

const none = new Uint8Array(0);

describe("upstreamError for a redirect", () => {
  it("names the Location without the query that carried the API key", () => {
    const error = upstreamError(
      reply(301, undefined, [["Location", "https://api.example.com/v1/charges?api_key=sk_live_secret&limit=10#top"]]),
      none,
    );
    expect(error.title).toBe("Redirect not followed");
    expect(error.status).toBe(301);
    expect(error.detail).toContain("with Location https://api.example.com/v1/charges. ");
    expect(error.detail).toContain("The gateway leaves out a Location's query and fragment");
    expect(error.detail).not.toContain("sk_live_secret");
    expect(error.detail).not.toContain("limit=10");
  });

  it("cuts a relative Location at its query", () => {
    const error = upstreamError(reply(302, undefined, [["location", "/v1/charges?api_key=sk_live_secret"]]), none);
    expect(error.detail).toContain("with Location /v1/charges. ");
    expect(error.detail).not.toContain("sk_live_secret");
  });

  it("gives a replay of the recorded response the same error as the live one", () => {
    const headers: [string, string][] = [["Location", "https://api.example.com/v1/charges?api_key=sk_live_secret"]];
    const recorded = recordHttpResponse(reply(302, undefined, headers), none);
    const recordedHeaders: Record<string, string> = recorded.headers ?? {};
    expect(recordedHeaders).toEqual({ Location: "https://api.example.com/v1/charges" });
    const replayed = reply(recorded.status, undefined, Object.entries(recordedHeaders));
    expect(upstreamError(replayed, none)).toEqual(upstreamError(reply(302, undefined, headers), none));
  });

  it("names no Location when the redirect has none", () => {
    expect(upstreamError(reply(307), none).detail).toBe(
      "The upstream answered 307. The gateway does not follow redirects, so set the environment's url to the final address.",
    );
  });
});
