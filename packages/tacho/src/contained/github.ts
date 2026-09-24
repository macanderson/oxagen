import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { FetchLike } from "../host/control-client";

/**
 * A contained run's GitHub access (ADR-152). The operator supplies one GitHub
 * App installation token narrowed to one repository. The token stays outside
 * the sandbox: the bridge forwards the run's git and REST calls for that one
 * repository and adds the token on the way out, the way the model route adds
 * the run's model credential (ADR-143). The launcher revokes the token when
 * the run seals, so it expires with the run even when GitHub's one-hour
 * ceiling has not passed.
 */
export const containedGitHubSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
      .refine((value) => !/\/\.\.?$/.test(value), "Invalid repository name"),
    /** Installation access tokens carry the `ghs_` prefix. */
    token: z.string().regex(/^ghs_[A-Za-z0-9_]{20,255}$/),
  })
  .strict();
export type ContainedGitHub = z.infer<typeof containedGitHubSchema>;

export interface GitHubUpstreams {
  api: string;
  git: string;
}
export const GITHUB_UPSTREAMS: GitHubUpstreams = {
  api: "https://api.github.com",
  git: "https://github.com",
};

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "oxagen-contained-launcher",
};

/**
 * Refuse a token that reaches more than the one repository the run names. A
 * token minted for the whole installation would let the sandbox's git remote
 * be pointed anywhere the App is installed, and the bridge's path check would
 * be the only thing in the way.
 */
export async function verifyRunGitHubToken(
  grant: ContainedGitHub,
  fetch: FetchLike,
  upstreams: GitHubUpstreams = GITHUB_UPSTREAMS,
): Promise<void> {
  const response = await fetch(
    `${upstreams.api}/installation/repositories?per_page=2`,
    {
      method: "GET",
      headers: { ...API_HEADERS, authorization: `Bearer ${grant.token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub refused the run's installation token (${response.status}); mint a new one for this run`,
    );
  const body = JSON.parse(await response.text()) as {
    total_count?: number;
    repositories?: Array<{ full_name?: string }>;
  };
  const only = body.repositories?.[0]?.full_name;
  if (
    body.total_count !== 1 ||
    only === undefined ||
    only.toLowerCase() !== grant.repository.toLowerCase()
  )
    throw new Error(
      `The run's GitHub token must reach ${grant.repository} and no other repository; mint it with repositories: [${grant.repository.split("/")[1]}]`,
    );
}

/** Revoke at seal. A token that is already gone is the outcome we wanted. */
export async function revokeRunGitHubToken(
  token: string,
  fetch: FetchLike,
  upstreams: GitHubUpstreams = GITHUB_UPSTREAMS,
): Promise<"revoked" | "already_invalid"> {
  const response = await fetch(`${upstreams.api}/installation/token`, {
    method: "DELETE",
    headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return "revoked";
  if (response.status === 401) return "already_invalid";
  throw new Error(`GitHub did not revoke the run's token (${response.status})`);
}

const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
const GIT_ROUTE = new RegExp(
  `^/github/git/(${SEGMENT})/(${SEGMENT})/(info/refs\\?service=git-(?:upload|receive)-pack|git-upload-pack|git-receive-pack)$`,
);
const API_ROUTE = new RegExp(
  `^/github/api/repos/(${SEGMENT})/(${SEGMENT})((?:/${SEGMENT})*)(\\?[A-Za-z0-9_.,=&%+-]*)?$`,
);

export interface GitHubTarget {
  kind: "git" | "api";
  url: string;
}

/**
 * Map a sandbox path to the one upstream URL it may reach, or refuse it. Only
 * the smart-HTTP git endpoints and the REST API under `/repos/<owner>/<repo>`
 * for the run's own repository pass. Anything else, including another
 * repository under the same owner, is refused.
 */
export function gitHubTarget(
  path: string,
  repository: string,
  upstreams: GitHubUpstreams = GITHUB_UPSTREAMS,
): GitHubTarget | undefined {
  const wanted = repository.toLowerCase();
  const git = GIT_ROUTE.exec(path);
  if (git) {
    const [, owner, name, rest] = git;
    const repo = (name as string).replace(/\.git$/, "");
    if (`${owner}/${repo}`.toLowerCase() !== wanted) return undefined;
    return {
      kind: "git",
      url: `${upstreams.git}/${owner}/${repo}.git/${rest}`,
    };
  }
  const api = API_ROUTE.exec(path);
  if (api) {
    const [, owner, name, rest = "", query = ""] = api;
    if (`${owner}/${name}`.toLowerCase() !== wanted) return undefined;
    if (rest.split("/").some((segment) => segment === "." || segment === ".."))
      return undefined;
    return {
      kind: "api",
      url: `${upstreams.api}/repos/${owner}/${name}${rest}${query}`,
    };
  }
  return undefined;
}

const FORWARDED = [
  "accept",
  "accept-encoding",
  "content-type",
  "content-length",
  "content-encoding",
  "git-protocol",
  "x-github-api-version",
];

/**
 * Stream one request to GitHub with the run's token. The sandbox's own
 * `authorization` header is dropped: the credential is chosen here, outside
 * the sandbox, and never read from the request.
 */
export function forwardToGitHub(
  target: GitHubTarget,
  token: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): void {
  const url = new URL(target.url);
  const headers: Record<string, string> = {
    "user-agent": "oxagen-contained-launcher",
    authorization:
      target.kind === "git"
        ? `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
        : `Bearer ${token}`,
  };
  for (const name of FORWARDED) {
    const value = incoming.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(
    url,
    { method: incoming.method, headers, timeout: 120_000 },
    (response) => {
      const passed: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        if (name === "set-cookie" || name === "connection") continue;
        passed[name] = value;
      }
      outgoing.writeHead(response.statusCode ?? 502, passed);
      response.pipe(outgoing);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("GitHub timed out")));
  upstream.on("error", () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "GitHub could not be reached" }));
    } else outgoing.destroy();
  });
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
}
