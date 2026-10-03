// collectors/github.ts: the GitHub Issues collector.
//
// A workspace names GitHub repositories in a collector file. This module
// turns each issue in them into a work item, through the CollectorDefinition
// contract in ./types.ts.
//
// Transport. GitHub sends `issues` and `issue_comment` webhooks signed with
// HMAC-SHA256 in `x-hub-signature-256`. The doorbell reads only the issue's
// node id from the body. fetchById reads the issue over REST, and toWorkItem
// maps what fetchById read.
//
// Identity. The provider id is `issue:node:<node_id>`, the node form in
// ADR-121. A node id survives a repository rename. The REST read needs the
// owner, the name, and the number, so fetchById first resolves the node id
// with one GraphQL query. A transferred issue gets a new node id, so it
// arrives as a new work item.
//
// Scope. The contract passes no config to doorbell or fetchById, so they take
// an issue from any repository the connection reaches. The pipeline passes the
// [scope] table to listChangedSince, which then reads only the repositories it
// names, and fails when the connection cannot read one of them, so a lost
// grant shows as a failing reconcile instead of an empty one. Called with no
// config, it reads every repository the connection reaches.
// githubItemInScope says whether an item sits in the repositories a collector
// file names. toWorkItem gets the config, so it applies it and answers null
// for an issue outside them, which the pipeline counts as skipped.
//
// Outside text. People outside the workspace write issue titles, bodies, and
// comments. toWorkItem marks subject and description tainted, and nothing in
// this module hands that text to a model.
//
// Write-back. Each write first locates the issue by its node id, the same way
// fetchById does. A note is an issue comment. Close sets the state to closed
// as completed. A status of open or closed sets the state, and any other
// status is a label the repository must already have. Labels replaces the
// Priority and Type labels and keeps every other label. Oxagen creates no
// label on its own. Each write runs only when its switch in the collector's
// [write_back] table is on (writeback.ts), and every stored switch is off
// until a person turns one on (ADR-250, amended for #4775). Writes need the
// GitHub App permission Issues: Read and write.
//
// Visibility. A send note shows what its runs cost only on a private
// repository. visibility reads the repository's visibility with the same
// query that locates the issue, and answers private only for PRIVATE. A
// public or internal repository answers public.
import { createHmac } from "node:crypto";
import { z } from "zod";
import { github } from "../connectors/github/index";
import { constantTimeStringEqual } from "../connectors/safe-compare";
import type {
  CollectorDefinition,
  Connection,
  Cursor,
  InboundRequest,
  ItemRef,
  ItemVisibility,
  Page,
  ProviderItem,
  Secret,
  VerifyResult,
  WorkItemInput,
  WriteBack,
  WriteBackTarget,
} from "./types";

const API_BASE = "https://api.github.com";
const GRAPHQL_PATH = "/graphql";
const USER_AGENT = "oxagen-ingestion/1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
/** GitHub's cap on ids in one `nodes(ids:)` query. */
const NODES_PER_QUERY = 100;
/** Pages read at one cursor before listChangedSince gives up on a repository. */
const MAX_STALLED_PAGES = 10;
/** Pages of the repository list read before listChangedSince stops. */
const MAX_REPO_PAGES = 100;
/** Accounts a read failure names before it counts the rest. */
const MAX_NAMED_OWNERS = 3;
/** The cursor stays this far behind the read, so a late write lands in the next read. */
const CURSOR_LAG_MS = 60_000;
/** The overlap each reconcile reads before its cursor, because `since` counts whole seconds. */
const SINCE_OVERLAP_MS = 1_000;
const PROVIDER_ID_PREFIX = "issue:node:";
const ITEM_KIND = "issue";
const DOORBELL_EVENTS: ReadonlySet<string> = new Set(["issues", "issue_comment"]);
const NOT_FOUND: ReadonlySet<string> = new Set(["NOT_FOUND"]);

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** The [scope] table of a GitHub collector file. */
export const githubCollectorConfig = z
  .object({
    /** One or more repositories, each `owner/name`. */
    repos: z
      .array(z.string().regex(REPO_NAME, "Name each repository as owner/name."))
      .min(1, "Name at least one repository."),
  })
  .strict();

export type GitHubCollectorConfig = z.infer<typeof githubCollectorConfig>;

// ---------------------------------------------------------------------------
// GitHub shapes
// ---------------------------------------------------------------------------

const loginSchema = z.object({ login: z.string() }).passthrough();

const issueSchema = z
  .object({
    node_id: z.string().min(1),
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullish(),
    state: z.string(),
    state_reason: z.string().nullish(),
    labels: z
      .array(z.union([z.string(), z.object({ name: z.string() }).passthrough()]))
      .default([]),
    assignee: loginSchema.nullish(),
    assignees: z.array(loginSchema).nullish(),
    user: loginSchema.nullish(),
    type: z.object({ name: z.string() }).passthrough().nullish(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullish(),
    html_url: z.string(),
    repository_url: z.string(),
  })
  .passthrough();

type Issue = z.infer<typeof issueSchema>;

/** ProviderItem.record for a GitHub issue. */
const recordSchema = z.object({
  /** The REST issue, unmapped. */
  issue: issueSchema,
  /** Who made the latest change, from the issue's timeline. */
  lastActor: z.string().nullable(),
});

/** The fields listChangedSince reads from a row before it knows the row is an issue. */
const listRowSchema = z
  .object({
    node_id: z.string().min(1),
    updated_at: z.string(),
    pull_request: z.unknown().optional(),
  })
  .passthrough();

const repoSchema = z
  .object({ full_name: z.string(), has_issues: z.boolean().optional() })
  .passthrough();

const labelListSchema = z.array(z.object({ name: z.string() }).passthrough());

const doorbellSchema = z
  .object({
    action: z.string().optional(),
    issue: z
      .object({ node_id: z.string().min(1), pull_request: z.unknown().optional() })
      .passthrough(),
    changes: z
      .object({
        new_issue: z.object({ node_id: z.string().min(1) }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Labels, resolutions, and the latest actor
// ---------------------------------------------------------------------------

const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;

/** GitHub label (lowercase) to Oxagen Type label, from tasks-spec §6.4. */
const TYPE_BY_GITHUB_LABEL: ReadonlyMap<string, string> = new Map([
  ["bug", "Bug"],
  ["enhancement", "New Feature"],
  ["improvement", "Improvement"],
  ["documentation", "Documentation"],
  ["test", "Test"],
  ["chore", "Chore"],
]);

/** GitHub issue type (lowercase) to Oxagen Type label, from tasks-spec §6.4. */
const TYPE_BY_ISSUE_TYPE: ReadonlyMap<string, string> = new Map([
  ["bug", "Bug"],
  ["feature", "New Feature"],
]);

/** Oxagen label (lowercase) to the GitHub label write-back sets. */
const GITHUB_LABEL_BY_OXAGEN: ReadonlyMap<string, string> = new Map([
  ...PRIORITY_LABELS.map((p): [string, string] => [p.toLowerCase(), p]),
  ["bug", "bug"],
  ["new feature", "enhancement"],
  ["improvement", "improvement"],
  ["documentation", "documentation"],
  ["test", "test"],
  ["chore", "chore"],
]);

const PRIORITY_GITHUB_LABELS: ReadonlySet<string> = new Set(
  PRIORITY_LABELS.map((p) => p.toLowerCase()),
);
const TYPE_GITHUB_LABELS: ReadonlySet<string> = new Set(TYPE_BY_GITHUB_LABEL.keys());

/**
 * Timeline events whose actor made the change. tasks-spec §6.1 sets Updated
 * by to the actor of the latest timeline event. A comment's actor is its
 * author. Mentions and subscriptions are left out, because GitHub records them
 * beside the comment that caused them.
 */
const ACTOR_EVENT_TYPES = [
  "AssignedEvent",
  "UnassignedEvent",
  "LabeledEvent",
  "UnlabeledEvent",
  "ClosedEvent",
  "ReopenedEvent",
  "RenamedTitleEvent",
  "MilestonedEvent",
  "DemilestonedEvent",
  "LockedEvent",
  "UnlockedEvent",
  "CrossReferencedEvent",
  "ReferencedEvent",
  "MarkedAsDuplicateEvent",
  "UnmarkedAsDuplicateEvent",
  "PinnedEvent",
  "UnpinnedEvent",
  "TransferredEvent",
] as const;

const ACTOR_EVENTS: ReadonlySet<string> = new Set(ACTOR_EVENT_TYPES);

/** `AssignedEvent` to `ASSIGNED_EVENT`, the IssueTimelineItemsItemType spelling. */
function itemTypeEnum(typename: string): string {
  return typename.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

const LAST_ACTOR_FRAGMENT = [
  "fragment LastActor on Issue {",
  "  author { login }",
  `  timelineItems(last: 1, itemTypes: [${["IssueComment", ...ACTOR_EVENT_TYPES].map(itemTypeEnum).join(", ")}]) {`,
  "    nodes {",
  "      __typename",
  "      ... on IssueComment { author { login } }",
  ...ACTOR_EVENT_TYPES.map((t) => `      ... on ${t} { actor { login } }`),
  "    }",
  "  }",
  "}",
].join("\n");

const RESOLVE_QUERY = `query ResolveIssue($id: ID!) {
  node(id: $id) {
    __typename
    ... on Issue {
      number
      repository { nameWithOwner }
      ...LastActor
    }
  }
}
${LAST_ACTOR_FRAGMENT}`;

const LOCATE_QUERY = `query LocateIssue($id: ID!) {
  node(id: $id) {
    __typename
    ... on Issue {
      number
      repository { nameWithOwner visibility }
    }
  }
}`;

const LAST_ACTORS_QUERY = `query LastActors($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue { ...LastActor }
  }
}
${LAST_ACTOR_FRAGMENT}`;

const actorSchema = z.object({ login: z.string() }).passthrough().nullish();

const lastActorFieldsSchema = z
  .object({
    author: actorSchema,
    timelineItems: z
      .object({
        nodes: z
          .array(
            z
              .object({ __typename: z.string(), author: actorSchema, actor: actorSchema })
              .passthrough()
              .nullable(),
          )
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

type LastActorFields = z.infer<typeof lastActorFieldsSchema>;

const issueLocationSchema = z
  .object({
    number: z.number().int().positive(),
    repository: z.object({ nameWithOwner: z.string() }).passthrough(),
  })
  .passthrough();

/** What LOCATE_QUERY reads: the issue's place and its repository's visibility. */
const locatedIssueSchema = z
  .object({
    number: z.number().int().positive(),
    repository: z
      .object({ nameWithOwner: z.string(), visibility: z.string().nullish() })
      .passthrough(),
  })
  .passthrough();

const nodeTypeSchema = z.object({ __typename: z.string() }).passthrough();

/**
 * The latest actor on an issue. An issue with no comment and no listed event
 * falls back to its author. A timeline item GitHub hides from the connection
 * gives null.
 */
function lastActorOf(fields: LastActorFields): string | null {
  const nodes = fields.timelineItems?.nodes ?? [];
  if (nodes.length === 0) return fields.author?.login ?? null;
  const last = nodes[nodes.length - 1];
  if (!last) return null;
  if (last.__typename === "IssueComment") return last.author?.login ?? null;
  if (ACTOR_EVENTS.has(last.__typename)) return last.actor?.login ?? null;
  return null;
}

function labelNames(issue: Issue): string[] {
  return issue.labels
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((name) => name.length > 0);
}

/** The most urgent Priority label on the issue, with the GitHub label it came from. */
function priorityOf(githubLabels: string[]): { label: string; raw: string } | null {
  for (const priority of PRIORITY_LABELS) {
    const raw = githubLabels.find((l) => l.toUpperCase() === priority);
    if (raw !== undefined) return { label: priority, raw };
  }
  return null;
}

function typeLabelsOf(githubLabels: string[], issueType: string | null): string[] {
  const out: string[] = [];
  if (issueType !== null) {
    const mapped = TYPE_BY_ISSUE_TYPE.get(issueType.toLowerCase());
    if (mapped !== undefined) out.push(mapped);
  }
  for (const label of githubLabels) {
    const mapped = TYPE_BY_GITHUB_LABEL.get(label.toLowerCase());
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/** The resolution of a closed issue, from tasks-spec §6.3. */
function resolutionOf(stateReason: string | null, githubLabels: string[]): string {
  switch (stateReason) {
    case "completed":
      return "Done";
    case "duplicate":
      return "Duplicate";
    case "not_planned": {
      const canceled = githubLabels.some((l) => {
        const lower = l.toLowerCase();
        return lower === "canceled" || lower === "cancelled";
      });
      return canceled ? "Canceled" : "Won't do";
    }
    default:
      return "Other";
  }
}

/** `owner/name` from a REST `repository_url`, or null when the URL has no repository path. */
function repositoryOf(repositoryUrl: string): string | null {
  try {
    const match = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(new URL(repositoryUrl).pathname);
    if (!match) return null;
    const [, owner, repo] = match;
    if (!owner || !repo) return null;
    return `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
  } catch {
    // A malformed URL or escape names no repository. The caller treats that as out of scope.
    return null;
  }
}

/**
 * True when the item sits in one of the repositories the collector file
 * names. The contract gives listChangedSince and fetchById no config, so
 * toWorkItem applies this before anything is stored.
 */
export function githubItemInScope(item: ProviderItem, config: GitHubCollectorConfig): boolean {
  const parsed = recordSchema.safeParse(item.record);
  if (!parsed.success) return false;
  const repo = repositoryOf(parsed.data.issue.repository_url);
  if (repo === null) return false;
  const wanted = repo.toLowerCase();
  return config.repos.some((r) => r.toLowerCase() === wanted);
}

// ---------------------------------------------------------------------------
// Times and cursors
// ---------------------------------------------------------------------------

function parseTime(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`The ${what} "${value}" is not an RFC 3339 time.`);
  return ms;
}

/** RFC 3339 in whole seconds, the precision GitHub reads and writes. */
function toCursor(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/**
 * The cursor to store after a reconcile read, and whether more waits past it.
 *
 * A repository with a full page stops at that page's last `updated_at`, its
 * boundary. The cursor moves to the lowest boundary, so no repository skips a
 * row. With no boundary, the cursor moves to the newest `updated_at` read.
 * Either way it stays at least CURSOR_LAG_MS behind the start of the read and
 * never moves backward.
 */
function nextCursor(
  inputMs: number | null,
  maxUpdatedMs: number | null,
  minBoundaryMs: number | null,
  startedMs: number,
): { cursor: string; hasMore: boolean } {
  const ceilingMs = floorToSecond(startedMs - CURSOR_LAG_MS);
  let nextMs = Math.min(minBoundaryMs ?? maxUpdatedMs ?? inputMs ?? 0, ceilingMs);
  if (inputMs !== null) nextMs = Math.max(nextMs, inputMs);
  const hasMore =
    minBoundaryMs !== null && minBoundaryMs <= ceilingMs && (inputMs === null || nextMs > inputMs);
  return { cursor: toCursor(nextMs), hasMore };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

function tokenOf(conn: Connection): string {
  const { auth } = conn;
  if (auth.scheme === "bearer_token") return auth.token;
  if (auth.scheme === "api_key") return auth.apiKey;
  throw new Error(
    `GitHub connection ${conn.id} holds a ${auth.scheme} credential. The GitHub collector needs a bearer_token or api_key credential.`,
  );
}

function ghFetch(token: string, method: HttpMethod, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": USER_AGENT,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${API_BASE}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Names the method, the path, and the status. Never the token or the body. */
function requestFailed(method: HttpMethod, path: string, status: number): Error {
  const [pathOnly] = path.split("?");
  return new Error(`GitHub ${method} ${pathOnly ?? path} returned HTTP ${status}.`);
}

async function ghRead(token: string, path: string): Promise<unknown> {
  const resp = await ghFetch(token, "GET", path);
  if (!resp.ok) throw requestFailed("GET", path, resp.status);
  const data: unknown = await resp.json();
  return data;
}

async function ghWrite(token: string, method: HttpMethod, path: string, body?: unknown): Promise<void> {
  const resp = await ghFetch(token, method, path, body);
  if (!resp.ok) throw requestFailed(method, path, resp.status);
}

const graphqlResponseSchema = z
  .object({
    data: z.unknown().optional(),
    errors: z
      .array(z.object({ type: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/**
 * Posts one GraphQL query. Errors whose type is in `tolerated` pass through,
 * and any other error throws with its type. Messages stay out, because they
 * can quote the query variables.
 */
async function ghGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  tolerated: ReadonlySet<string>,
): Promise<unknown> {
  const resp = await ghFetch(token, "POST", GRAPHQL_PATH, { query, variables });
  if (!resp.ok) throw requestFailed("POST", GRAPHQL_PATH, resp.status);
  const json: unknown = await resp.json();
  const parsed = graphqlResponseSchema.parse(json);
  const unexpected = (parsed.errors ?? [])
    .map((e) => e.type ?? "UNKNOWN")
    .filter((type) => !tolerated.has(type));
  if (unexpected.length > 0) {
    throw new Error(`GitHub GraphQL returned errors: ${[...new Set(unexpected)].join(", ")}.`);
  }
  return parsed.data ?? null;
}

// ---------------------------------------------------------------------------
// Locating an issue
// ---------------------------------------------------------------------------

interface IssueLocation {
  owner: string;
  repo: string;
  number: number;
}

function nodeIdOf(ref: ItemRef): string {
  const nodeId = ref.providerId.startsWith(PROVIDER_ID_PREFIX)
    ? ref.providerId.slice(PROVIDER_ID_PREFIX.length)
    : "";
  if (nodeId === "") {
    throw new Error(`The provider id "${ref.providerId}" is not a GitHub issue node id (issue:node:<id>).`);
  }
  return nodeId;
}

function locationOf(nameWithOwner: string, number: number): IssueLocation {
  const [owner, repo, extra] = nameWithOwner.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new Error(`GitHub returned the repository name "${nameWithOwner}", which is not owner/name.`);
  }
  return { owner, repo, number };
}

function repoPath(loc: IssueLocation): string {
  return `/repos/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}`;
}

function issuePath(loc: IssueLocation): string {
  return `${repoPath(loc)}/issues/${loc.number}`;
}

/** Reads one node by id and returns it when it is an issue. */
async function issueNode(token: string, nodeId: string, query: string): Promise<unknown> {
  const data = await ghGraphql(token, query, { id: nodeId }, NOT_FOUND);
  const { node } = z.object({ node: nodeTypeSchema.nullable() }).parse(data);
  if (node === null) {
    throw new Error(
      `GitHub has no issue ${nodeId} this connection can read. The issue may be deleted, or the connection may have lost access.`,
    );
  }
  if (node.__typename !== "Issue") {
    throw new Error(`GitHub node ${nodeId} is a ${node.__typename}, not an issue.`);
  }
  return node;
}

interface LocatedIssue {
  token: string;
  loc: IssueLocation;
  visibility: ItemVisibility;
}

/** Finds the issue a write-back names, and whether its repository is private. */
async function locate(target: WriteBackTarget): Promise<LocatedIssue> {
  const token = tokenOf(target.conn);
  const node = locatedIssueSchema.parse(await issueNode(token, nodeIdOf(target.ref), LOCATE_QUERY));
  // Only PRIVATE is private. PUBLIC, INTERNAL, and a value GitHub may add
  // later read as public, so a note never shows cost where it should not.
  const visibility: ItemVisibility = node.repository.visibility === "PRIVATE" ? "private" : "public";
  return { token, loc: locationOf(node.repository.nameWithOwner, node.number), visibility };
}

// ---------------------------------------------------------------------------
// Doorbell and verify
// ---------------------------------------------------------------------------

function verify(req: InboundRequest, secret: Secret): VerifyResult {
  if (!secret) return { ok: false, reason: "No signing secret is stored for this collector." };
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return { ok: false, reason: "The request has no x-hub-signature-256 header." };
  const deliveryId = req.headers["x-github-delivery"];
  if (!deliveryId) return { ok: false, reason: "The request has no x-github-delivery header." };
  const expected = `sha256=${createHmac("sha256", secret).update(req.body).digest("hex")}`;
  if (!constantTimeStringEqual(signature, expected)) {
    return { ok: false, reason: "The x-hub-signature-256 header does not match the body." };
  }
  return { ok: true, deliveryId };
}

function doorbell(req: InboundRequest): ItemRef[] {
  const event = req.headers["x-github-event"];
  if (event === undefined || !DOORBELL_EVENTS.has(event)) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(req.body));
  } catch {
    // A body that is not JSON names no issue. The reconcile still reads any change it announced.
    return [];
  }
  const parsed = doorbellSchema.safeParse(payload);
  if (!parsed.success) return [];
  const { action, issue, changes } = parsed.data;
  // GitHub sends pull request comments as issue_comment events. A pull request is not a work item.
  if (issue.pull_request !== undefined && issue.pull_request !== null) return [];
  if (event === "issues") {
    // A deleted issue has nothing to fetch.
    if (action === "deleted") return [];
    // A transfer creates a new issue with a new node id. The old one has nothing left to fetch.
    if (action === "transferred") {
      const moved = changes?.new_issue?.node_id;
      return moved === undefined ? [] : [{ providerId: `${PROVIDER_ID_PREFIX}${moved}`, kind: ITEM_KIND }];
    }
  }
  return [{ providerId: `${PROVIDER_ID_PREFIX}${issue.node_id}`, kind: ITEM_KIND }];
}

// ---------------------------------------------------------------------------
// Fetch and reconcile
// ---------------------------------------------------------------------------

async function fetchById(ref: ItemRef, conn: Connection): Promise<ProviderItem> {
  const token = tokenOf(conn);
  const nodeId = nodeIdOf(ref);
  const node = issueLocationSchema
    .merge(lastActorFieldsSchema)
    .parse(await issueNode(token, nodeId, RESOLVE_QUERY));
  const loc = locationOf(node.repository.nameWithOwner, node.number);
  const raw = await ghRead(token, issuePath(loc));
  const issue = issueSchema.parse(raw);
  // GitHub redirects a moved issue's REST URL. A read that lands on another
  // issue than GraphQL named means the issue moved between the two calls.
  const repo = repositoryOf(issue.repository_url);
  if (issue.number !== loc.number || repo?.toLowerCase() !== node.repository.nameWithOwner.toLowerCase()) {
    throw new Error(`GitHub issue ${nodeId} moved while Oxagen read it. Retry the fetch.`);
  }
  return { ref, updatedAt: issue.updated_at, record: { issue: raw, lastActor: lastActorOf(node) } };
}

/** What a connection's token reaches. Every key is lowercased. */
interface Reach {
  /** Repositories with issues on, spelled as GitHub spells them. */
  readable: Map<string, string>;
  /** Repositories with issues turned off. */
  issuesOff: Set<string>;
  /** Accounts that own a reachable repository, spelled as GitHub spells them. */
  owners: Map<string, string>;
}

async function reachableRepos(token: string): Promise<Reach> {
  // An installation token (ghs_) lists its installation's repositories.
  // A user token lists the repositories its user can reach.
  const installation = token.startsWith("ghs_");
  const reach: Reach = { readable: new Map(), issuesOff: new Set(), owners: new Map() };
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const path = installation
      ? `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`
      : `/user/repos?per_page=${PAGE_SIZE}&page=${page}`;
    const data = await ghRead(token, path);
    const repos = installation
      ? z.object({ repositories: z.array(repoSchema) }).passthrough().parse(data).repositories
      : z.array(repoSchema).parse(data);
    for (const repo of repos) {
      const key = repo.full_name.toLowerCase();
      if (repo.has_issues === false) reach.issuesOff.add(key);
      else reach.readable.set(key, repo.full_name);
      const owner = ownerOf(repo.full_name);
      if (!reach.owners.has(owner.toLowerCase())) reach.owners.set(owner.toLowerCase(), owner);
    }
    if (repos.length < PAGE_SIZE) return reach;
  }
  throw new Error(`The GitHub connection reaches more than ${MAX_REPO_PAGES * PAGE_SIZE} repositories. The collector reads no further.`);
}

function ownerOf(fullName: string): string {
  return fullName.split("/")[0] ?? fullName;
}

/** The accounts a connection reaches, for a sentence that ends in "only". */
function ownersPhrase(owners: ReadonlyMap<string, string>): string {
  const names = [...owners.values()];
  const shown = names.slice(0, MAX_NAMED_OWNERS).join(", ");
  const more = names.length - MAX_NAMED_OWNERS;
  return more > 0 ? `${shown} and ${more} other accounts` : shown;
}

/**
 * Why the connection cannot read repositories the collector names, and what
 * fixes each one. An App installation belongs to one account. So when the
 * connection reaches nothing an owner holds, granting that installation more
 * repositories cannot help: the workspace needs the installation on that owner.
 */
function cannotReadMessage(missing: string[], reach: Reach): string {
  const sentences = [`The GitHub connection cannot read ${missing.join(", ")}.`];
  const issuesOff = missing.filter((name) => reach.issuesOff.has(name.toLowerCase()));
  const hidden = missing.filter((name) => !reach.issuesOff.has(name.toLowerCase()));
  const unreached = new Map<string, string>();
  for (const name of hidden) {
    const owner = ownerOf(name);
    const key = owner.toLowerCase();
    if (!reach.owners.has(key) && !unreached.has(key)) unreached.set(key, owner);
  }
  const ungranted = hidden.filter((name) => reach.owners.has(ownerOf(name).toLowerCase()));
  if (issuesOff.length > 0) {
    sentences.push(`Issues are turned off on ${issuesOff.join(", ")}. Turn them on in the repository settings on GitHub.`);
  }
  if (unreached.size > 0) {
    const owners = [...unreached.values()].join(", ");
    sentences.push(
      reach.owners.size === 0
        ? "It reaches no repositories."
        : `It reaches repositories owned by ${ownersPhrase(reach.owners)} only.`,
      `Attach the Oxagen GitHub App installation on ${owners} to this workspace, or install the App on ${owners} first.`,
    );
  }
  if (ungranted.length > 0) {
    sentences.push(`Give the Oxagen GitHub App access to ${ungranted.join(", ")}.`);
  }
  return sentences.join(" ");
}

interface RepoRead {
  issues: Array<{ raw: unknown; issue: Issue }>;
  /** The newest `updated_at` on any row read, pull requests included. */
  maxUpdatedMs: number | null;
  /** The last `updated_at` of a full page, when more rows may follow. */
  boundaryMs: number | null;
}

/**
 * Reads one page of a repository's issues, oldest change first. A full page
 * ends at a boundary, and the next reconcile starts there. A full page that
 * ends at or before the cursor cannot move the cursor, so this reads the
 * following pages at the same `since` until one ends past it.
 */
async function readRepoIssues(token: string, fullName: string, cursorMs: number | null): Promise<RepoRead> {
  const [owner = "", name = ""] = fullName.split("/");
  const since = cursorMs === null ? null : toCursor(Math.max(0, cursorMs - SINCE_OVERLAP_MS));
  const base =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues` +
    `?state=all&sort=updated&direction=asc&per_page=${PAGE_SIZE}` +
    (since === null ? "" : `&since=${encodeURIComponent(since)}`);
  const issues: RepoRead["issues"] = [];
  let maxUpdatedMs: number | null = null;
  for (let page = 1; page <= MAX_STALLED_PAGES; page++) {
    const path = `${base}&page=${page}`;
    const resp = await ghFetch(token, "GET", path);
    // 404: the repository is gone. 410: its issues are turned off.
    if (page === 1 && (resp.status === 404 || resp.status === 410)) {
      return { issues, maxUpdatedMs, boundaryMs: null };
    }
    if (!resp.ok) throw requestFailed("GET", path, resp.status);
    const data: unknown = await resp.json();
    const rows = z.array(z.unknown()).parse(data);
    let lastMs: number | null = null;
    for (const raw of rows) {
      const row = listRowSchema.parse(raw);
      lastMs = parseTime(row.updated_at, "issue updated_at");
      maxUpdatedMs = maxUpdatedMs === null ? lastMs : Math.max(maxUpdatedMs, lastMs);
      // The issues list includes pull requests. They count toward a full page, and nothing else.
      if (row.pull_request !== undefined && row.pull_request !== null) continue;
      issues.push({ raw, issue: issueSchema.parse(raw) });
    }
    if (rows.length < PAGE_SIZE || lastMs === null) return { issues, maxUpdatedMs, boundaryMs: null };
    if (cursorMs === null || lastMs > cursorMs) return { issues, maxUpdatedMs, boundaryMs: lastMs };
  }
  throw new Error(
    `GitHub ${fullName} has more than ${MAX_STALLED_PAGES * PAGE_SIZE} rows updated in the second before the cursor. The reconcile cannot move past them.`,
  );
}

async function lastActors(token: string, nodeIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < nodeIds.length; i += NODES_PER_QUERY) {
    const chunk = nodeIds.slice(i, i + NODES_PER_QUERY);
    const data = await ghGraphql(token, LAST_ACTORS_QUERY, { ids: chunk }, NOT_FOUND);
    const { nodes } = z.object({ nodes: z.array(nodeTypeSchema.nullable()) }).parse(data);
    chunk.forEach((id, index) => {
      const node = nodes[index];
      out.set(id, node && node.__typename === "Issue" ? lastActorOf(lastActorFieldsSchema.parse(node)) : null);
    });
  }
  return out;
}

/**
 * The repositories a reconcile reads: the ones the scope names, spelled as
 * GitHub spells them, or every reachable one when there is no scope. Throws
 * when the connection cannot read a repository the scope names.
 */
async function reposToRead(token: string, config: GitHubCollectorConfig | undefined): Promise<string[]> {
  const reach = await reachableRepos(token);
  if (config === undefined) return [...reach.readable.values()];
  const missing = config.repos.filter((name) => !reach.readable.has(name.toLowerCase()));
  if (missing.length > 0) throw new Error(cannotReadMessage(missing, reach));
  return [...new Set(config.repos.map((name) => reach.readable.get(name.toLowerCase()) as string))];
}

async function listChangedSince(
  cursor: Cursor,
  conn: Connection,
  config?: GitHubCollectorConfig,
): Promise<Page<ProviderItem>> {
  const token = tokenOf(conn);
  const startedMs = Date.now();
  const cursorMs = cursor === null ? null : parseTime(cursor, "reconcile cursor");
  const collected = new Map<string, { raw: unknown; issue: Issue }>();
  let maxUpdatedMs: number | null = null;
  let minBoundaryMs: number | null = null;
  for (const repo of await reposToRead(token, config)) {
    const read = await readRepoIssues(token, repo, cursorMs);
    for (const entry of read.issues) collected.set(entry.issue.node_id, entry);
    if (read.maxUpdatedMs !== null) {
      maxUpdatedMs = maxUpdatedMs === null ? read.maxUpdatedMs : Math.max(maxUpdatedMs, read.maxUpdatedMs);
    }
    if (read.boundaryMs !== null) {
      minBoundaryMs = minBoundaryMs === null ? read.boundaryMs : Math.min(minBoundaryMs, read.boundaryMs);
    }
  }
  const actors = await lastActors(token, [...collected.keys()]);
  const items: ProviderItem[] = [...collected.values()].map(({ raw, issue }) => ({
    ref: { providerId: `${PROVIDER_ID_PREFIX}${issue.node_id}`, kind: ITEM_KIND },
    updatedAt: issue.updated_at,
    record: { issue: raw, lastActor: actors.get(issue.node_id) ?? null },
  }));
  items.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  return { items, ...nextCursor(cursorMs, maxUpdatedMs, minBoundaryMs, startedMs) };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function toWorkItem(item: ProviderItem, config: GitHubCollectorConfig): WorkItemInput | null {
  const { issue, lastActor } = recordSchema.parse(item.record);
  // The connection can read repositories the collector file does not name,
  // and its reads and doorbells reach them all. Those issues are not stored.
  if (!githubItemInScope(item, config)) return null;
  const githubLabels = labelNames(issue);
  const priority = priorityOf(githubLabels);
  const mapped = [
    ...(priority === null ? [] : [priority.label]),
    ...typeLabelsOf(githubLabels, issue.type?.name ?? null),
  ];
  const closed = issue.state.toLowerCase() === "closed";
  return {
    providerId: item.ref.providerId,
    origin: "provider",
    subject: issue.title,
    description: issue.body ?? null,
    labels: [...new Set([...githubLabels, ...mapped])],
    status: issue.state,
    statusCategory: closed ? "closed" : "open",
    resolution: closed ? resolutionOf(issue.state_reason ?? null, githubLabels) : null,
    owner: issue.assignees?.[0]?.login ?? issue.assignee?.login ?? null,
    // A GitHub issue has an author, not a requester (tasks-spec §6.1).
    requester: null,
    sourceCreatedBy: issue.user?.login ?? null,
    sourceCreatedAt: issue.created_at,
    sourceUpdatedBy: lastActor,
    sourceUpdatedAt: issue.updated_at,
    closedAt: issue.closed_at ?? null,
    sourceUrl: issue.html_url,
    priorityRaw: priority?.raw ?? null,
    estimateMinutes: null,
    tainted: ["subject", "description"],
    sourceRepository: repositoryOf(issue.repository_url),
  };
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

/** Throws when the repository lacks the label. Oxagen creates no label on its own (tasks-spec §5.6). */
async function requireLabel(token: string, loc: IssueLocation, name: string): Promise<void> {
  const path = `${repoPath(loc)}/labels/${encodeURIComponent(name)}`;
  const resp = await ghFetch(token, "GET", path);
  if (resp.status === 404) {
    throw new Error(
      `${loc.owner}/${loc.repo} has no label "${name}". Oxagen creates no label on its own. Create it in the repository, then retry.`,
    );
  }
  if (!resp.ok) throw requestFailed("GET", path, resp.status);
}

async function addLabels(token: string, loc: IssueLocation, names: string[]): Promise<void> {
  await ghWrite(token, "POST", `${issuePath(loc)}/labels`, { labels: names });
}

async function removeLabel(token: string, loc: IssueLocation, name: string): Promise<void> {
  const path = `${issuePath(loc)}/labels/${encodeURIComponent(name)}`;
  const resp = await ghFetch(token, "DELETE", path);
  // 404: the label is already off the issue.
  if (!resp.ok && resp.status !== 404) throw requestFailed("DELETE", path, resp.status);
}

/** The GitHub label for an Oxagen label, or the name as given when no mapping exists. */
function githubLabelFor(oxagenLabel: string): string {
  return GITHUB_LABEL_BY_OXAGEN.get(oxagenLabel.toLowerCase()) ?? oxagenLabel;
}

const writeBack: WriteBack = {
  async note(target, text) {
    const { token, loc } = await locate(target);
    await ghWrite(token, "POST", `${issuePath(loc)}/comments`, { body: text });
  },

  async status(target, status) {
    const { token, loc } = await locate(target);
    const lower = status.trim().toLowerCase();
    if (lower === "open" || lower === "closed") {
      await ghWrite(token, "PATCH", issuePath(loc), { state: lower });
      return;
    }
    // GitHub has two states. Any other status is a label (tasks-spec §5.6).
    await requireLabel(token, loc, status);
    await addLabels(token, loc, [status]);
  },

  async close(target) {
    const { token, loc } = await locate(target);
    await ghWrite(token, "PATCH", issuePath(loc), { state: "closed", state_reason: "completed" });
  },

  async labels(target, { priority, type }) {
    const wantPriority = priority.trim() === "" ? null : githubLabelFor(priority.trim());
    const wantType = type.trim() === "" ? null : githubLabelFor(type.trim());
    const wanted = [wantPriority, wantType].filter((l): l is string => l !== null);
    if (wanted.length === 0) return;
    const { token, loc } = await locate(target);
    // Check every new label first, so a missing one leaves the issue as it was.
    for (const name of wanted) await requireLabel(token, loc, name);
    const current = labelListSchema
      .parse(await ghRead(token, `${issuePath(loc)}/labels?per_page=${PAGE_SIZE}`))
      .map((l) => l.name);
    for (const name of current) {
      const lower = name.toLowerCase();
      const replacedPriority =
        wantPriority !== null && PRIORITY_GITHUB_LABELS.has(lower) && lower !== wantPriority.toLowerCase();
      const replacedType =
        wantType !== null && TYPE_GITHUB_LABELS.has(lower) && lower !== wantType.toLowerCase();
      if (replacedPriority || replacedType) await removeLabel(token, loc, name);
    }
    const present = new Set(current.map((l) => l.toLowerCase()));
    const missing = wanted.filter((l) => !present.has(l.toLowerCase()));
    if (missing.length > 0) await addLabels(token, loc, missing);
  },

  async visibility(target) {
    return (await locate(target)).visibility;
  },
};

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

/**
 * The GitHub Issues collector. It reuses the GitHub connector's identity and
 * connection config, and copies none of its poll or webhook members.
 */
export const githubCollector: CollectorDefinition<GitHubCollectorConfig> = {
  connectorId: github.connectorId,
  displayName: github.displayName,
  description: "Reads GitHub issues in the repositories a collector file names into work items.",
  icon: github.icon,
  supportedAuthSchemes: github.supportedAuthSchemes,
  deliveryMethod: "webhook",
  connectionConfigSchema: github.connectionConfigSchema,
  previewRecordTypes: (auth, config: unknown) =>
    github.previewRecordTypes(auth, github.connectionConfigSchema.parse(config)),
  normalizeRecord: (sourceRecordType, raw) => github.normalizeRecord(sourceRecordType, raw),

  type: "github",
  config: githubCollectorConfig,
  verify,
  doorbell,
  fetchById,
  listChangedSince,
  toWorkItem,
  writeBack,
};
