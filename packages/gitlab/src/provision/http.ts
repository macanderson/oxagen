// http.ts: the one request helper the steering repo provisioning uses on GitLab.
//
// Provisioning is a durable job. Inngest retries a failed step, so this helper
// never retries or sleeps itself. It throws `GitLabApiError` for a status the
// caller did not ask to see, `GitLabRateLimitedError` for a rate limit, and
// `SteeringGitlabReauthorizeError` for a token GitLab no longer accepts, so the
// job retries later or asks the owner to connect again.
//
// The token travels in the `PRIVATE-TOKEN` header, as in client.ts. A group
// access token works there. The helper scrubs the token from every message it
// returns or throws, because messages end up in logs and run records.
import { GitLabApiError } from "../client";

/** The subset of `fetch` the helper calls. The global `fetch` satisfies it. */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface GitlabRestOptions {
  /** A group access token with the `api` scope and the Maintainer role. */
  token: string;
  /** Defaults to https://gitlab.com. The helper appends /api/v4. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. Tests pass a fake server. */
  fetch?: HttpFetch;
}

export interface GitlabResponse<T> {
  status: number;
  /** The parsed body, or null for an empty body or a status in `accept`. */
  data: T | null;
  /** The error message GitLab sent with a status in `accept`, if any. */
  message: string | null;
}

export interface GitlabRest {
  /**
   * Send one request. `path` starts after /api/v4, such as `/projects/12`. A
   * 2xx answer returns its body. A status listed in `accept` returns with
   * `data` null and GitLab's message. A 401 and a 429 throw even when listed.
   * Any other status throws `GitLabApiError`.
   */
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    accept?: readonly number[],
  ): Promise<GitlabResponse<T>>;
}

const DEFAULT_BASE_URL = "https://gitlab.com";
const MAX_MESSAGE_LENGTH = 500;

/**
 * How long a job waits before it asks again after a rate limit. `HttpFetch`
 * exposes no headers, so the helper cannot read `Retry-After` and always
 * reports this value.
 */
export const RATE_LIMIT_RETRY_MS = 60_000;

/** GitLab answered 429. The job retries the step after `retryAfterMs`. */
export class GitLabRateLimitedError extends GitLabApiError {
  readonly code = "gitlab_rate_limited" as const;
  readonly retryAfterMs: number;

  constructor(status: number, message: string, retryAfterMs: number) {
    super(status, message);
    this.name = "GitLabRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * GitLab answered 401, so the token is revoked, expired, or wrong. Retrying
 * cannot fix it. The owner has to connect the group again.
 */
export class SteeringGitlabReauthorizeError extends Error {
  readonly code = "steering_reauthorize" as const;
  readonly status = 401;

  constructor(message: string) {
    super(`GitLab refused the steering token: ${message}`);
    this.name = "SteeringGitlabReauthorizeError";
  }
}

function parse(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Turn a GitLab message into one line. GitLab sends a string, a list, or an
 * object of field errors such as `{ name: ["has already been taken"] }`, which
 * reads as "name has already been taken".
 */
function flatten(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map(flatten).filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (value !== null && typeof value === "object") {
    const parts: string[] = [];
    for (const [key, inner] of Object.entries(value)) {
      const text = flatten(inner);
      if (text !== null) parts.push(key === "base" ? text : `${key} ${text}`);
    }
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return null;
}

function messageOf(body: unknown, status: number): string {
  if (body !== null && typeof body === "object") {
    const fields = body as Record<string, unknown>;
    const message = flatten(fields.message);
    if (message !== null) return message;
    const error = flatten(fields.error);
    const description = flatten(fields.error_description);
    if (error !== null && description !== null) return `${error}: ${description}`;
    if (error !== null) return error;
  }
  return `status ${status}`;
}

function redact(message: string, token: string): string {
  const out = token.length > 0 ? message.split(token).join("[redacted]") : message;
  return out.length > MAX_MESSAGE_LENGTH
    ? `${out.slice(0, MAX_MESSAGE_LENGTH)}...`
    : out;
}

/**
 * The body of a 2xx answer. GitLab sends a body with every answer the
 * provisioning steps read, so an empty one throws.
 */
export function requireData<T>(res: GitlabResponse<T>, what: string): T {
  if (res.data === null)
    throw new GitLabApiError(res.status, `GitLab returned no ${what}`);
  return res.data;
}

/**
 * Percent-encode one path segment, such as a project id, a project path like
 * `acme/oxagen-support`, or a file path.
 */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function createGitlabRest(opts: GitlabRestOptions): GitlabRest {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiRoot = `${baseUrl}/api/v4`;
  const send: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const token = opts.token;

  return {
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      accept: readonly number[] = [],
    ): Promise<GitlabResponse<T>> {
      const headers: Record<string, string> = {
        "PRIVATE-TOKEN": token,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await send(`${apiRoot}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const parsed = parse(await res.text());
      if (res.status >= 200 && res.status < 300)
        return { status: res.status, data: parsed as T | null, message: null };
      const message = redact(messageOf(parsed, res.status), token);
      // A 401 and a 429 throw even when the caller accepts their status. A
      // caller that accepts 404 or 400 reads it as an answer about the
      // project, and neither of these is one.
      if (res.status === 401) throw new SteeringGitlabReauthorizeError(message);
      if (res.status === 429)
        throw new GitLabRateLimitedError(res.status, message, RATE_LIMIT_RETRY_MS);
      if (accept.includes(res.status))
        return { status: res.status, data: null, message };
      throw new GitLabApiError(res.status, message);
    },
  };
}
