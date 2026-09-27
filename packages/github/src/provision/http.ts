// http.ts: the one request helper the steering repo provisioning uses.
//
// Provisioning is a durable job. Inngest retries a failed step, so this helper
// never retries or sleeps itself. It throws `GitHubApiError` for a status the
// caller did not ask to see, and `GitHubRateLimitedError` for a rate limit, so
// the job retries later from the step that failed.
import { GitHubApiError, GitHubRateLimitedError } from "../fetch-client";

/** The subset of `fetch` the helper calls. The global `fetch` satisfies it. */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface GithubRestOptions {
  /** An installation token or a user access token. */
  token: string;
  /** Defaults to https://api.github.com. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. Tests pass a fake server. */
  fetch?: HttpFetch;
}

export interface GithubResponse<T> {
  status: number;
  /** The parsed body, or null for an empty body or a status in `accept`. */
  data: T | null;
  /** The error message GitHub sent with a status in `accept`, if any. */
  message: string | null;
}

export interface GithubRest {
  /**
   * Send one request. A 2xx answer returns its body. A status listed in
   * `accept` returns with `data` null and GitHub's message. Any other status
   * throws.
   */
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    accept?: readonly number[],
  ): Promise<GithubResponse<T>>;
}

const DEFAULT_BASE_URL = "https://api.github.com";

/** How long a job waits before it asks again after a rate limit. */
export const RATE_LIMIT_RETRY_MS = 60_000;

function parse(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function messageOf(body: unknown, status: number): string {
  if (body !== null && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    const errors = (body as { errors?: unknown }).errors;
    const parts: string[] = [];
    if (typeof message === "string") parts.push(message);
    if (Array.isArray(errors)) {
      for (const e of errors) {
        if (typeof e === "string") parts.push(e);
        else if (e !== null && typeof e === "object") {
          const m = (e as { message?: unknown }).message;
          if (typeof m === "string") parts.push(m);
        }
      }
    }
    if (parts.length > 0) return parts.join(": ");
  }
  return `status ${status}`;
}

/** Percent-encode one path segment, such as an owner or a repository name. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function createGithubRest(opts: GithubRestOptions): GithubRest {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const send: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  return {
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      accept: readonly number[] = [],
    ): Promise<GithubResponse<T>> {
      const res = await send(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const parsed = parse(await res.text());
      if (res.status >= 200 && res.status < 300)
        return { status: res.status, data: parsed as T | null, message: null };
      const message = messageOf(parsed, res.status);
      // A rate limit throws even when the caller accepts its status. A caller
      // that accepts 403 reads it as a refused authorization, and a limit is
      // not one.
      if (
        res.status === 429 ||
        (res.status === 403 && /rate limit/i.test(message))
      )
        throw new GitHubRateLimitedError(
          res.status,
          message,
          RATE_LIMIT_RETRY_MS,
        );
      if (accept.includes(res.status))
        return { status: res.status, data: null, message };
      throw new GitHubApiError(res.status, message);
    },
  };
}
