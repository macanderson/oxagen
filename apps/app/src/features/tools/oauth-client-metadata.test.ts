// Oxagen's OAuth client metadata document (#4814): an authorization server
// fetches it anonymously and trusts the callback it lists, so the document's
// `client_id` must equal the URL it is served from and its one callback must be
// the app's own, whatever host the request claims.
import { describe, expect, it } from "vitest";
import { appOriginOf } from "./app-origin";
import {
  handleMcpOAuthClientMetadata,
  mcpOAuthClientMetadata,
} from "./oauth-client-metadata";

const APP = "https://app.oxagen.sh";
const DOCUMENT = `${APP}/api/v1/mcp/oauth/client-metadata`;

function request(headers: Record<string, string>): Request {
  return new Request(DOCUMENT, { headers });
}

describe("mcpOAuthClientMetadata", () => {
  it("is a public client whose ID is its own URL and whose callback is the app's", () => {
    expect(mcpOAuthClientMetadata(APP)).toEqual({
      client_id: DOCUMENT,
      client_name: "Oxagen",
      client_uri: APP,
      logo_uri: `${APP}/brand/oxagen-icon.svg`,
      redirect_uris: [`${APP}/api/v1/mcp/oauth/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("handleMcpOAuthClientMetadata", () => {
  it("serves the document as cacheable JSON with no secret in it", async () => {
    const res = await handleMcpOAuthClientMetadata(
      request({ host: "app.oxagen.sh" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toContain("max-age=");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBe(DOCUMENT);
    expect(JSON.stringify(body)).not.toContain("secret\":");
  });

  it("never names a callback on a host the request claims but the app does not own", async () => {
    const res = await handleMcpOAuthClientMetadata(
      request({ host: "app.oxagen.sh", "x-forwarded-host": "evil.example" }),
    );
    const body = (await res.json()) as { redirect_uris: string[] };
    expect(body.redirect_uris).toEqual([`${APP}/api/v1/mcp/oauth/callback`]);
  });
});

describe("appOriginOf", () => {
  const read =
    (headers: Record<string, string>) =>
    (name: string): string | null =>
      headers[name] ?? null;

  it("keeps the app's own host and a local one, and falls back for any other", () => {
    expect(appOriginOf(read({ host: "app.oxagen.sh" }))).toBe(APP);
    expect(
      appOriginOf(
        read({ "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" }),
      ),
    ).toBe("http://localhost:3000");
    expect(appOriginOf(read({ host: "evil.example" }))).toBe(APP);
    // Another production host keeps its own origin, so the popup lands on the
    // host that set the sign-in cookie.
    expect(
      appOriginOf(read({ host: "oxagen.app", "x-forwarded-proto": "http" })),
    ).toBe("https://oxagen.app");
    expect(appOriginOf(read({}))).toBe(APP);
  });
});
