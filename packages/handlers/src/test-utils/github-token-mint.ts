// A stand-in for api.github.com behind the real installation-token mint
// (`getInstallationToken` in @oxagen/github), so a test can read the narrowing
// a handler sends in the access-token request body (#4753).
import { generateKeyPairSync } from "node:crypto";

/** A key the real mint can sign its app JWT with. */
export const TEST_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/** One access-token request: the installation in the path, and the body. */
export interface MintRequest {
  installationId: string;
  body: unknown;
}

const MINT_PATH = /\/app\/installations\/([^/]+)\/access_tokens$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch that answers the mint with a token, or with `mintStatus` and
 * GitHub's message, and records each mint's body. Any other request is
 * answered from `routes`, keyed by the URL path with its query, or 404.
 *
 * The mint caches tokens per installation and narrowing for the process, so
 * each test names its own installation id.
 */
export function githubTokenFetch(
  opts: {
    mintStatus?: number;
    mintMessage?: string;
    routes?: Record<string, unknown>;
  } = {},
) {
  const mints: MintRequest[] = [];
  const requests: string[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const mint = MINT_PATH.exec(url.pathname);
    if (mint) {
      const raw = typeof init?.body === "string" ? init.body : undefined;
      mints.push({
        installationId: mint[1] ?? "",
        body: raw === undefined ? undefined : JSON.parse(raw),
      });
      const status = opts.mintStatus ?? 201;
      return status === 201
        ? json(201, {
            token: "ghs_test",
            expires_at: "2099-01-01T00:00:00Z",
          })
        : json(status, { message: opts.mintMessage ?? "refused" });
    }
    const key = `${url.pathname}${url.search}`;
    const routes = opts.routes ?? {};
    return key in routes
      ? json(200, routes[key])
      : json(404, { message: "Not Found" });
  };
  return { fetch, mints, requests };
}
