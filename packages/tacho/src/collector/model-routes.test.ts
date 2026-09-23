/**
 * The proxy's header and error shaping on its own. `model-proxy.test.ts`
 * proves the same over real sockets; this file pins the two seams a vendor
 * SDK reads by the letter: which headers cross when a credential is swapped
 * (ADR-143), and what a refusal looks like in each vendor's error body.
 */
import { describe, expect, it } from "vitest";
import {
  downstreamResponseHeaders,
  providerError,
  upstreamRequestHeaders,
} from "./model-routes";

const CALLER: readonly string[] = [
  "Host",
  "127.0.0.1:4319",
  "anthropic-version",
  "2023-06-01",
  "Authorization",
  "Bearer oxrt_abc.def",
  "Content-Type",
  "application/json",
  "X-Api-Key",
  "oxrt_abc.def",
  "x-oxagen-session",
  "sess-1",
  "Accept-Encoding",
  "gzip",
  "Connection",
  "keep-alive, X-Hop",
  "X-Hop",
  "dropped",
  "User-Agent",
  "claude-cli/2.1",
];

describe("upstream request headers", () => {
  it("swaps every credential the caller sent for the one in custody, keeping the rest in order", () => {
    const out = upstreamRequestHeaders(CALLER, "api.anthropic.com", 12, false, {
      kind: "api_key",
      secret: "sk-ant-REAL",
    });
    expect(out).toEqual([
      "Host",
      "api.anthropic.com",
      "anthropic-version",
      "2023-06-01",
      "Content-Type",
      "application/json",
      "User-Agent",
      "claude-cli/2.1",
      "X-Api-Key",
      "sk-ant-REAL",
      "Accept-Encoding",
      "identity",
      "Content-Length",
      "12",
    ]);
    expect(JSON.stringify(out)).not.toContain("oxrt_");
    const bearer = upstreamRequestHeaders(CALLER, "api.openai.com", 0, false, {
      kind: "bearer",
      secret: "sk-proj-REAL",
    });
    expect(bearer).toContain("Authorization");
    expect(bearer[bearer.indexOf("Authorization") + 1]).toBe(
      "Bearer sk-proj-REAL",
    );
    expect(bearer).not.toContain("X-Api-Key");
    // No body and no Content-Length from the caller: none is stated.
    expect(bearer).not.toContain("Content-Length");
  });

  it("lets the caller's own credentials cross when nothing is attached", () => {
    const out = upstreamRequestHeaders(CALLER, "api.anthropic.com", 0, true);
    expect(out[out.indexOf("Authorization") + 1]).toBe("Bearer oxrt_abc.def");
    expect(out[out.indexOf("X-Api-Key") + 1]).toBe("oxrt_abc.def");
    // Hop-by-hop, the named connection header, the session header and the
    // caller's encoding never cross, whichever way the credential goes.
    for (const name of ["X-Hop", "Connection", "x-oxagen-session"])
      expect(out).not.toContain(name);
    expect(out[out.indexOf("Accept-Encoding") + 1]).toBe("identity");
  });

  it("restates Content-Length when the caller sent one, even for an empty body", () => {
    const out = upstreamRequestHeaders(
      ["Content-Length", "5", "Content-Encoding", "gzip"],
      "h",
      0,
      true,
    );
    expect(out).toEqual([
      "Host",
      "h",
      "Accept-Encoding",
      "identity",
      "Content-Length",
      "0",
    ]);
  });

  it("hands response headers back minus the hop's own", () => {
    expect(
      downstreamResponseHeaders([
        "Content-Type",
        "text/event-stream",
        "Transfer-Encoding",
        "chunked",
        "Connection",
        "close, X-Vendor-Hop",
        "X-Vendor-Hop",
        "1",
        "request-id",
        "req_1",
      ]),
    ).toEqual(["Content-Type", "text/event-stream", "request-id", "req_1"]);
  });
});

describe("a refusal in the vendor's shape", () => {
  it("is an authentication error at 401 and a permission error at 403 for Anthropic, with the code in the message", () => {
    expect(
      JSON.parse(
        providerError("anthropic", 401, "run_token_expired", "Expired.").body,
      ),
    ).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Expired. (run_token_expired)",
      },
    });
    expect(
      JSON.parse(
        providerError("anthropic", 403, "foreign_credential", "Own key.").body,
      ).error.type,
    ).toBe("permission_error");
    expect(
      JSON.parse(providerError("anthropic", 400, "bad", "Bad.").body).error
        .type,
    ).toBe("api_error");
  });

  it("is invalid_api_key at 401 for OpenAI, keeps the seam's code at 403, and is a server error otherwise", () => {
    const expired = providerError(
      "openai",
      401,
      "run_token_expired",
      "Expired.",
    );
    expect(expired.status).toBe(401);
    expect(JSON.parse(expired.body)).toEqual({
      error: {
        message: "Expired.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });
    expect(
      JSON.parse(providerError("openai", 403, "host_paused", "Paused.").body)
        .error,
    ).toMatchObject({ type: "invalid_request_error", code: "host_paused" });
    expect(
      JSON.parse(providerError("openai", 502, "upstream", "Down.").body).error,
    ).toMatchObject({ type: "server_error", code: "upstream" });
  });
});
