// github-recorded.test-support.ts: recorded GitHub responses for the work
// intake tests (P1-03, #5103), served through a stubbed global fetch.
//
// Each payload keeps the fields GitHub sends for an issue in the REST and
// GraphQL shapes the GitHub Issues collector reads
// (packages/ingestion/src/collectors/github.ts). The server holds one issue
// whose title, body, labels, and update time a test changes, so a test can
// create an issue, edit it, and edit it again without a webhook.
import { createHmac } from "node:crypto";
import type { InboundRequest } from "@oxagen/ingestion/collectors";

export const RECORDED_REPO = "aintel-test/work-intake";
export const RECORDED_NODE_ID = "I_kwDOP103aZ6xWq";
export const RECORDED_INSTALLATION = "90310377";
const API = "https://api.github.com";

/** The issue's fields a test changes. */
export interface RecordedIssueState {
  title: string;
  body: string | null;
  labels: string[];
  updatedAt: string;
  state: "open" | "closed";
}

/** The REST issue, as GET /repos/{owner}/{repo}/issues/{number} returns it. */
export function restIssue(issue: RecordedIssueState): Record<string, unknown> {
  return {
    url: `${API}/repos/${RECORDED_REPO}/issues/7`,
    repository_url: `${API}/repos/${RECORDED_REPO}`,
    html_url: `https://github.com/${RECORDED_REPO}/issues/7`,
    id: 3_401_118_207,
    node_id: RECORDED_NODE_ID,
    number: 7,
    title: issue.title,
    user: { login: "reporter", id: 7, type: "User" },
    labels: issue.labels.map((name, index) => ({ id: index + 1, node_id: `LA_${index}`, name, color: "d73a4a", default: false })),
    state: issue.state,
    state_reason: issue.state === "closed" ? "completed" : null,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: "2026-10-01T08:00:00Z",
    updated_at: issue.updatedAt,
    closed_at: issue.state === "closed" ? issue.updatedAt : null,
    author_association: "NONE",
    type: null,
    body: issue.body,
  };
}

/** The issues webhook body GitHub sends. Only the ids matter: Oxagen fetches the issue. */
export function issueWebhookBody(action: string, issue: RecordedIssueState): Record<string, unknown> {
  return {
    action,
    issue: restIssue(issue),
    repository: { id: 1_040_331, node_id: "R_kgDOP103", full_name: RECORDED_REPO, name: "work-intake" },
    installation: { id: Number(RECORDED_INSTALLATION), node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u" },
    sender: { login: "reporter", id: 7, type: "User" },
  };
}

/** A delivery as the GitHub App signs it. */
export function signedDelivery(secret: string, deliveryId: string, event: string, body: unknown): InboundRequest {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-github-hook-installation-target-id": "4168398",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`,
    },
    body: bytes,
    receivedAt: new Date().toISOString(),
  };
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

/** A recorded GitHub server over one issue. `requests` lists `METHOD /path` in order. */
export function recordedGithub(initial: RecordedIssueState) {
  const state = { issue: { ...initial }, requests: [] as string[], tree: [] as string[], treeStatus: 200 };
  const lastActor = { __typename: "Issue", author: { login: "reporter" }, timelineItems: { nodes: [] } };
  const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.requests.push(`${method} ${url.pathname}`);
    if (method === "POST" && url.pathname === "/graphql") {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("query ResolveIssue(")) {
        return Promise.resolve(
          json({ data: { node: { ...lastActor, number: 7, repository: { nameWithOwner: RECORDED_REPO } } } }),
        );
      }
      if (query.includes("query LastActors(")) return Promise.resolve(json({ data: { nodes: [lastActor] } }));
    }
    if (method === "GET" && url.pathname === `/repos/${RECORDED_REPO}/issues/7`) {
      return Promise.resolve(json(restIssue(state.issue)));
    }
    if (method === "GET" && url.pathname === "/installation/repositories") {
      return Promise.resolve(json({ total_count: 1, repositories: [{ full_name: RECORDED_REPO, has_issues: true }] }));
    }
    if (method === "GET" && url.pathname === `/repos/${RECORDED_REPO}/issues`) {
      return Promise.resolve(json([restIssue(state.issue)]));
    }
    if (method === "GET" && url.pathname === `/repos/${RECORDED_REPO}/git/trees/HEAD`) {
      return Promise.resolve(json({ tree: state.tree.map((path) => ({ path, type: "blob" })), truncated: false }, state.treeStatus));
    }
    return Promise.reject(new Error(`The recorded GitHub has no response for ${method} ${url.pathname}.`));
  };
  return { state, fetch: fetchImpl };
}
