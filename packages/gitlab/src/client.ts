import type {
  GitLabChangedPath,
  GitLabClient,
  GitLabClientOptions,
  GitLabCommitAction,
  GitLabMergeRequest,
  GitLabPathCommit,
  GitLabProject,
  GitLabProjectHook,
  GitLabProjectRef,
  GitLabTokenInfo,
  GitLabUser,
} from "./types";

/**
 * A non-2xx answer from the GitLab API. The status is a field, so a caller
 * that treats one status specially (a 404 as "absent", a 409 as "the head
 * moved") branches on it rather than on the message text.
 *
 * The message never carries the access token, a webhook secret, or the
 * request URL. The token travels only in the `PRIVATE-TOKEN` header, and any
 * secret the request sent is scrubbed from GitLab's answer before it lands
 * here, because error messages end up in logs and run records.
 */
export class GitLabApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GitLab API error ${status}: ${message}`);
    this.name = "GitLabApiError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// GitLab response shapes. Internal: callers only see the mapped types.
// ---------------------------------------------------------------------------

interface GLProject {
  id: number;
  path_with_namespace: string;
  path: string;
  namespace: { full_path: string };
  default_branch?: string | null;
  web_url: string;
  archived?: boolean;
}

interface GLToken {
  id: number;
  name: string;
  scopes?: string[];
  active: boolean;
  revoked: boolean;
  expires_at?: string | null;
}

interface GLUser {
  id: number;
  username: string;
  bot?: boolean;
}

interface GLBranch {
  name: string;
  commit: { id: string };
}

interface GLCommit {
  id: string;
  title?: string | null;
  message?: string | null;
  author_name: string;
  author_email?: string | null;
  authored_date: string;
}

interface GLTreeItem {
  path: string;
  type: string;
}

interface GLDiff {
  old_path: string;
  new_path: string;
  renamed_file: boolean;
  deleted_file: boolean;
  new_file: boolean;
}

interface GLCompare {
  diffs?: GLDiff[] | null;
}

interface GLMergeRequest {
  iid: number;
  project_id: number;
  web_url: string;
  title: string;
  description?: string | null;
  state: GitLabMergeRequest["state"];
  source_branch: string;
  target_branch: string;
  sha?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  merged_at?: string | null;
  detailed_merge_status?: string | null;
}

interface GLCommitStatus {
  id: number;
  target_url?: string | null;
}

interface GLHook {
  id: number;
  url: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://gitlab.com";
const DEFAULT_MAX_RETRIES = 2;
/** GitLab's largest accepted `per_page`. Fewer pages means fewer rate-limited requests. */
const MAX_PER_PAGE = 100;
/** One attempt that hangs this long is treated as failed, so a stalled socket cannot hold a caller forever. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The longest single wait a Retry-After may ask for. A longer wait throws
 * instead: a request that sleeps for an hour holds a worker for an hour, and
 * the caller is better placed to decide whether to come back later.
 */
const MAX_RETRY_WAIT_MS = 60_000;
/** Longest GitLab error text kept in a message. HTML error pages are dropped entirely. */
const MAX_MESSAGE_LENGTH = 500;
/** Statuses that mean "try again shortly": rate limiting and a gateway that could not reach GitLab. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Path encoding
// ---------------------------------------------------------------------------

/**
 * Percent-encode one caller-supplied value into a single URL path segment.
 *
 * `encodeURIComponent` turns every `/` into `%2F`, so a value cannot add
 * segments. It leaves `.` alone, and the URL parser resolves a segment that is
 * exactly `.` or `..` before the request goes out, which would retarget the
 * call at a different endpoint. Those two values and the empty string are
 * refused.
 */
function seg(value: string, what: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new TypeError(`Invalid GitLab ${what}: ${JSON.stringify(value)}.`);
  }
  return encodeURIComponent(value);
}

/**
 * A project reference as a path segment. A numeric id goes in as-is. A full
 * path such as "group/sub/project" is encoded to "group%2Fsub%2Fproject",
 * which is the form GitLab's `:id` parameter expects.
 */
function projectSeg(ref: GitLabProjectRef): string {
  if (typeof ref === "number") return positiveInt(ref, "project id");
  if (/^\d+$/.test(ref)) return ref;
  return seg(ref, "project path");
}

function positiveInt(value: number, what: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid GitLab ${what}: ${String(value)}.`);
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------

/**
 * Flatten GitLab's error payloads into one sentence. GitLab answers with a
 * plain string (`{"message": "404 Not found"}`), a list of strings, or a
 * validation map (`{"message": {"name": ["has already been taken"]}}`), and
 * the map reads best as "name has already been taken".
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

function errorMessage(bodyText: string, statusText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    const message = flatten(body.message);
    if (message !== null) return message;
    const error = flatten(body.error);
    const description = flatten(body.error_description);
    if (error !== null && description !== null)
      return `${error}: ${description}`;
    if (error !== null) return error;
  }
  return statusText.trim() || "request failed";
}

function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out.length > MAX_MESSAGE_LENGTH
    ? `${out.slice(0, MAX_MESSAGE_LENGTH)}...`
    : out;
}

/**
 * How long to wait before the next attempt. GitLab sends `Retry-After` in
 * seconds on a 429. It may also arrive as an HTTP date. Without one, the wait
 * doubles per attempt from one second.
 */
function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header !== null && header.trim() !== "") {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 1000 * 2 ** attempt;
}

/** The `rel="next"` target of a Link header, if any. */
function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const match of header.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)) {
    const [, url, rel] = match;
    if (url !== undefined && rel?.split(/\s+/).includes("next")) return url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapMergeRequest(json: GLMergeRequest): GitLabMergeRequest {
  return {
    iid: json.iid,
    webUrl: json.web_url,
    title: json.title,
    description: json.description ?? "",
    state: json.state,
    sourceBranch: json.source_branch,
    targetBranch: json.target_branch,
    sha: json.sha ?? null,
    mergeCommitSha: json.merge_commit_sha ?? null,
    squashCommitSha: json.squash_commit_sha ?? null,
    mergedAt: json.merged_at ?? null,
    detailedMergeStatus: json.detailed_merge_status ?? null,
    projectId: String(json.project_id),
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Secrets sent in this request's body, scrubbed from any error GitLab echoes back. */
  secrets?: readonly string[];
}

/**
 * Create a GitLab REST v4 client for gitlab.com.
 *
 * The token goes in the `PRIVATE-TOKEN` header on every request and nowhere
 * else: not in a URL, an error message, or a log line.
 */
export function createGitLabClient(options: GitLabClientOptions): GitLabClient {
  if (typeof options.token !== "string" || options.token.trim() === "") {
    throw new TypeError("GitLab client needs a non-empty token.");
  }
  const token = options.token;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiRoot = `${baseUrl}/api/v4`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError(
      `maxRetries must be a non-negative integer, got ${maxRetries}.`,
    );
  }
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function buildUrl(path: string, query?: Query): string {
    const url = `${apiRoot}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /**
   * Send one request to an absolute API URL and return the 2xx response.
   * Retries 429 and 502/503/504 up to `maxRetries` times. Every other non-2xx
   * status throws GitLabApiError on the first answer.
   */
  async function sendUrl(
    method: string,
    url: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": token,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const secrets = [token, ...(opts.secrets ?? [])];

    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      if (res.ok) return res;

      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // An unreadable error body still has a status worth reporting.
      }
      const message = redact(errorMessage(bodyText, res.statusText), secrets);
      if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) {
        throw new GitLabApiError(res.status, message);
      }
      const delay = retryDelay(res, attempt);
      if (delay > MAX_RETRY_WAIT_MS) {
        throw new GitLabApiError(res.status, message);
      }
      await sleep(delay);
    }
  }

  function send(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    return sendUrl(method, buildUrl(path, opts.query), opts);
  }

  async function json<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const res = await send(method, path, opts);
    return (await res.json()) as T;
  }

  /** Run `fn` and turn a 404 into null. Every other failure propagates. */
  async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Walk every page of a list endpoint. GitLab paginates two ways: keyset
   * pagination answers with a `Link: <...>; rel="next"` header, and offset
   * pagination answers with `X-Next-Page`. Both are followed until neither is
   * present.
   *
   * A Link target must stay under this client's API root. The token rides on
   * every request, so following a link to any other host would hand it over.
   */
  async function paginate<T>(path: string, query: Query): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let url = buildUrl(path, query);
    for (;;) {
      if (seen.has(url)) {
        throw new Error(
          "GitLab pagination repeated a page; stopping to avoid a loop.",
        );
      }
      seen.add(url);
      const res = await sendUrl("GET", url);
      const page = (await res.json()) as T[];
      out.push(...page);

      const link = nextLink(res.headers.get("link"));
      if (link !== null) {
        if (!link.startsWith(`${apiRoot}/`)) {
          throw new Error(
            "GitLab pagination pointed outside the API root; refusing to follow it.",
          );
        }
        url = link;
        continue;
      }
      const nextPage = res.headers.get("x-next-page")?.trim();
      if (nextPage && /^\d+$/.test(nextPage)) {
        url = buildUrl(path, { ...query, page: nextPage });
        continue;
      }
      return out;
    }
  }

  function project(ref: GitLabProjectRef): string {
    return `/projects/${projectSeg(ref)}`;
  }

  return {
    async getProject(ref): Promise<GitLabProject> {
      const data = await json<GLProject>("GET", project(ref));
      return {
        // The numeric id survives renames and transfers, so it is what a
        // binding should pin. It is a string to match GitHub's repository id.
        id: String(data.id),
        pathWithNamespace: data.path_with_namespace,
        namespaceFullPath: data.namespace.full_path,
        path: data.path,
        defaultBranch: data.default_branch ?? null,
        webUrl: data.web_url,
        archived: data.archived === true,
      };
    },

    async getCurrentToken(): Promise<GitLabTokenInfo> {
      const data = await json<GLToken>("GET", "/personal_access_tokens/self");
      return {
        id: data.id,
        name: data.name,
        scopes: data.scopes ?? [],
        active: data.active,
        revoked: data.revoked,
        expiresAt: data.expires_at ?? null,
      };
    },

    async getCurrentUser(): Promise<GitLabUser> {
      const data = await json<GLUser>("GET", "/user");
      return { id: data.id, username: data.username, bot: data.bot === true };
    },

    async getFileRaw(a) {
      return orNull(async () => {
        const res = await send(
          "GET",
          `${project(a.project)}/repository/files/${seg(a.path, "file path")}/raw`,
          { query: { ref: a.ref } },
        );
        return res.text();
      });
    },

    async listPathCommits(a): Promise<GitLabPathCommit[]> {
      if (!(a.limit >= 1)) return [];
      const perPage = Math.min(MAX_PER_PAGE, Math.floor(a.limit));
      const data = await json<GLCommit[]>(
        "GET",
        `${project(a.project)}/repository/commits`,
        { query: { ref_name: a.ref, path: a.path, per_page: perPage } },
      );
      return data.slice(0, perPage).map((c) => ({
        sha: c.id,
        authorName: c.author_name,
        authorEmail: c.author_email ?? null,
        committedAt: c.authored_date,
        summary: firstLine(c.title ?? c.message ?? ""),
      }));
    },

    async getBranch(a) {
      return orNull(async () => {
        const data = await json<GLBranch>(
          "GET",
          `${project(a.project)}/repository/branches/${seg(a.branch, "branch")}`,
        );
        return { name: data.name, commitSha: data.commit.id };
      });
    },

    async createBranch(a) {
      await send("POST", `${project(a.project)}/repository/branches`, {
        body: { branch: a.branch, ref: a.ref },
      });
    },

    async deleteBranch(a) {
      await send(
        "DELETE",
        `${project(a.project)}/repository/branches/${seg(a.branch, "branch")}`,
      );
    },

    async listTree(a) {
      const items = await paginate<GLTreeItem>(
        `${project(a.project)}/repository/tree`,
        {
          ref: a.ref,
          recursive: true,
          per_page: MAX_PER_PAGE,
          pagination: "keyset",
        },
      );
      return items.filter((i) => i.type === "blob").map((i) => i.path);
    },

    async commitFiles(a) {
      const data = await json<{ id: string }>(
        "POST",
        `${project(a.project)}/repository/commits`,
        {
          body: {
            branch: a.branch,
            commit_message: a.message,
            actions: a.actions.map(toGitLabAction),
          },
        },
      );
      return { sha: data.id };
    },

    async compare(a): Promise<GitLabChangedPath[]> {
      // straight=false diffs from the merge base of the two refs, so changes
      // that landed on `from` after `to` branched off do not show up.
      const data = await json<GLCompare>(
        "GET",
        `${project(a.project)}/repository/compare`,
        { query: { from: a.from, to: a.to, straight: false } },
      );
      return (data.diffs ?? []).map((d) => ({
        oldPath: d.old_path,
        newPath: d.new_path,
        renamed: d.renamed_file,
        deleted: d.deleted_file,
        added: d.new_file,
      }));
    },

    async createMergeRequest(a) {
      const body: Record<string, unknown> = {
        source_branch: a.sourceBranch,
        target_branch: a.targetBranch,
        title: a.title,
        description: a.description,
      };
      // GitLab takes labels as one comma-separated string.
      if (a.labels && a.labels.length > 0) body.labels = a.labels.join(",");
      if (a.removeSourceBranch !== undefined)
        body.remove_source_branch = a.removeSourceBranch;
      const data = await json<GLMergeRequest>(
        "POST",
        `${project(a.project)}/merge_requests`,
        { body },
      );
      return mapMergeRequest(data);
    },

    async updateMergeRequest(a) {
      const body: Record<string, unknown> = {};
      if (a.title !== undefined) body.title = a.title;
      if (a.description !== undefined) body.description = a.description;
      if (a.stateEvent !== undefined) body.state_event = a.stateEvent;
      const data = await json<GLMergeRequest>(
        "PUT",
        `${project(a.project)}/merge_requests/${positiveInt(a.iid, "merge request iid")}`,
        { body },
      );
      return mapMergeRequest(data);
    },

    async listMergeRequests(a) {
      const items = await paginate<GLMergeRequest>(
        `${project(a.project)}/merge_requests`,
        {
          source_branch: a.sourceBranch,
          target_branch: a.targetBranch,
          state: a.state,
          per_page: MAX_PER_PAGE,
        },
      );
      return items.map(mapMergeRequest);
    },

    async getMergeRequest(a) {
      const data = await json<GLMergeRequest>(
        "GET",
        `${project(a.project)}/merge_requests/${positiveInt(a.iid, "merge request iid")}`,
      );
      return mapMergeRequest(data);
    },

    async mergeMergeRequest(a) {
      // `sha` makes the merge conditional: GitLab answers 409 when the source
      // branch head is no longer this commit, so a push that lands between a
      // review and the merge is never merged unseen.
      const body: Record<string, unknown> = { sha: a.sha, squash: a.squash };
      if (a.squashCommitMessage !== undefined)
        body.squash_commit_message = a.squashCommitMessage;
      if (a.shouldRemoveSourceBranch !== undefined)
        body.should_remove_source_branch = a.shouldRemoveSourceBranch;
      const data = await json<GLMergeRequest>(
        "PUT",
        `${project(a.project)}/merge_requests/${positiveInt(a.iid, "merge request iid")}/merge`,
        { body },
      );
      return mapMergeRequest(data);
    },

    async setCommitStatus(a) {
      const body: Record<string, unknown> = { state: a.state, name: a.name };
      if (a.description !== undefined) body.description = a.description;
      if (a.targetUrl !== undefined) body.target_url = a.targetUrl;
      const data = await json<GLCommitStatus>(
        "POST",
        `${project(a.project)}/statuses/${seg(a.sha, "commit sha")}`,
        { body },
      );
      return { id: data.id, targetUrl: data.target_url ?? null };
    },

    async createProjectHook(a): Promise<GitLabProjectHook> {
      const data = await json<GLHook>("POST", `${project(a.project)}/hooks`, {
        body: {
          url: a.url,
          token: a.token,
          merge_requests_events: a.mergeRequestsEvents,
          push_events: a.pushEvents,
          enable_ssl_verification: a.enableSslVerification ?? true,
        },
        secrets: [a.token],
      });
      return { id: data.id, url: data.url };
    },

    async deleteProjectHook(a) {
      await send(
        "DELETE",
        `${project(a.project)}/hooks/${positiveInt(a.hookId, "hook id")}`,
      );
    },
  };
}

function toGitLabAction(action: GitLabCommitAction): Record<string, string> {
  if (action.action === "delete") {
    return { action: "delete", file_path: action.filePath };
  }
  return {
    action: action.action,
    file_path: action.filePath,
    content: action.content,
  };
}
