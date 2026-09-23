import { createHash } from "node:crypto";
import { getInstallationToken } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  runIssueDestinationSchema,
  type RunIssueDestination,
  type RunIssueReceipt,
} from "@oxagen/oxagen/run-outcomes";
import {
  assertRunOutcomesAllowed,
  type RunOutcomesScope,
} from "@oxagen/plugins/run-outcomes-policy";
import {
  linearGraphql,
  resolveLinearIssueToken,
} from "@oxagen/plugins/run-outcomes-linear";
import { z } from "zod";
import { resolveWorkspaceGithubInstallation } from "./repository.github-connection";

const githubIssue = z.object({
  id: z.number().int(),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});
const linearIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  url: z.string().url(),
  description: z.string().nullable(),
  team: z.object({ id: z.string() }),
  project: z.object({ id: z.string() }).nullable(),
});
const githubName = /^[A-Za-z0-9_.-]+$/;

export interface RunIssueCreateRequest {
  destination: RunIssueDestination;
  /** Stable sha256 chosen and persisted with the candidate before any request. */
  marker: string;
  title: string;
  body: string;
  /** True only for the first attempt under the orchestrator's durable claim. */
  allowCreate: boolean;
}

function issueMarker(marker: string): string {
  if (!/^[0-9a-f]{64}$/.test(marker))
    throw new HandlerError({
      code: "conflict",
      reason: "run_issue_marker_invalid",
    });
  return `<!-- oxagen-run-outcome:${marker} -->`;
}
function uncertain(): never {
  throw new HandlerError({
    code: "conflict",
    reason: "run_issue_creation_unconfirmed",
    message:
      "The provider has not confirmed this issue. Reconcile this attempt before creating another.",
  });
}

async function githubToken(
  scope: RunOutcomesScope,
  destination: Extract<RunIssueDestination, { provider: "github" }>,
  readOnly = false,
): Promise<string> {
  if (!githubName.test(destination.owner) || !githubName.test(destination.repo))
    throw new HandlerError({
      code: "conflict",
      reason: "github_repository_invalid",
    });
  await assertRunOutcomesAllowed(scope);
  const connection = await resolveWorkspaceGithubInstallation(scope);
  if (!connection || connection.status !== "connected")
    throw new HandlerError({
      code: "conflict",
      reason: "github_not_connected",
    });
  const appId = process.env["GITHUB_APP_ID"];
  const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
  if (!appId || !privateKey)
    throw new HandlerError({
      code: "conflict",
      reason: "github_app_not_configured",
    });
  await assertRunOutcomesAllowed(scope);
  const grant = await getInstallationToken({
    appId,
    privateKey,
    installationId: connection.installationId,
    repositories: [destination.repo],
    permissions: {
      ...(readOnly ? {} : { issues: "write" as const }),
      contents: "read",
      metadata: "read",
    },
  });
  return grant.token;
}

async function githubRequest<T>(
  scope: RunOutcomesScope,
  token: string,
  path: string,
  output: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  await assertRunOutcomesAllowed(scope);
  const response = await fetch(`https://api.github.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new HandlerError({
      code: "conflict",
      reason:
        response.status === 403
          ? "github_issues_permission_required"
          : "github_issue_request_failed",
    });
  return output.parse(await response.json());
}

function githubReceipt(
  destination: Extract<RunIssueDestination, { provider: "github" }>,
  issue: z.output<typeof githubIssue>,
): RunIssueReceipt {
  const url = new URL(issue.html_url);
  const expected =
    `/${destination.owner}/${destination.repo}/issues/${issue.number}`.toLowerCase();
  if (
    url.origin !== "https://github.com" ||
    url.pathname.toLowerCase() !== expected ||
    issue.pull_request
  )
    throw new HandlerError({
      code: "conflict",
      reason: "github_issue_receipt_mismatch",
    });
  return {
    provider: "github",
    destination,
    issueId: String(issue.id),
    identifier: `#${issue.number}`,
    url: issue.html_url,
  };
}

async function createGithubIssue(
  scope: RunOutcomesScope,
  request: RunIssueCreateRequest & {
    destination: Extract<RunIssueDestination, { provider: "github" }>;
  },
): Promise<RunIssueReceipt> {
  const { destination } = request;
  const marker = issueMarker(request.marker);
  const token = await githubToken(scope, destination);
  const base = `/repos/${encodeURIComponent(destination.owner)}/${encodeURIComponent(destination.repo)}`;
  const repository = await githubRequest(
    scope,
    token,
    base,
    z.object({ full_name: z.string(), has_issues: z.boolean() }),
  );
  if (
    repository.full_name.toLowerCase() !==
      `${destination.owner}/${destination.repo}`.toLowerCase() ||
    !repository.has_issues
  )
    throw new HandlerError({
      code: "conflict",
      reason: "github_issue_destination_unavailable",
    });
  const reconcile = async (): Promise<RunIssueReceipt | null> => {
    const q = new URLSearchParams({
      q: `repo:${destination.owner}/${destination.repo} is:issue in:body "oxagen-run-outcome:${request.marker}"`,
      per_page: "100",
    });
    const found = await githubRequest(
      scope,
      token,
      `/search/issues?${q}`,
      z.object({
        incomplete_results: z.boolean(),
        total_count: z.number(),
        items: z.array(githubIssue),
      }),
    );
    if (found.incomplete_results || found.total_count > 100) uncertain();
    const matches = found.items.filter((item) => item.body?.includes(marker));
    if (matches.length > 1)
      throw new HandlerError({
        code: "conflict",
        reason: "run_issue_duplicate_marker",
      });
    return matches[0] ? githubReceipt(destination, matches[0]) : null;
  };
  const existing = await reconcile();
  if (existing) return existing;
  // Search indexing can lag a completed POST. A retry with no receipt must
  // never interpret an empty search as permission to send a second POST.
  if (!request.allowCreate) uncertain();
  try {
    const created = await githubRequest(
      scope,
      token,
      `${base}/issues`,
      githubIssue,
      { title: request.title, body: `${request.body}\n\n${marker}` },
    );
    return githubReceipt(destination, created);
  } catch {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    uncertain();
  }
}

/** Linear accepts a caller-specified UUID v4. Scope and marker make it stable. */
export function linearIssueId(
  scope: RunOutcomesScope,
  destination: RunIssueDestination,
  marker: string,
): string {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([scope.orgId, scope.workspaceId, destination, marker]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createLinearIssue(
  scope: RunOutcomesScope,
  request: RunIssueCreateRequest & {
    destination: Extract<RunIssueDestination, { provider: "linear" }>;
  },
): Promise<RunIssueReceipt> {
  const { destination } = request;
  const marker = issueMarker(request.marker);
  const token = await resolveLinearIssueToken(scope, destination.connectionId);
  // A token can see many teams. Verify the selected team and project now.
  await linearGraphql(
    scope,
    token,
    "query($id:String!){ team(id:$id){ id } }",
    { id: destination.teamId },
    z.object({ team: z.object({ id: z.literal(destination.teamId) }) }),
  );
  if (destination.projectId) {
    const project = await linearGraphql(
      scope,
      token,
      "query($id:String!){ project(id:$id){ id teams(first:250){ nodes { id } pageInfo { hasNextPage } } } }",
      { id: destination.projectId },
      z.object({
        project: z.object({
          id: z.string(),
          teams: z.object({
            nodes: z.array(z.object({ id: z.string() })),
            pageInfo: z.object({ hasNextPage: z.boolean() }),
          }),
        }),
      }),
    );
    if (
      !project.project.teams.nodes.some(
        (team) => team.id === destination.teamId,
      )
    )
      throw new HandlerError({
        code: "conflict",
        reason: "linear_project_team_mismatch",
      });
  }
  const id = linearIssueId(scope, destination, request.marker);
  const receipt = (issue: z.output<typeof linearIssue>): RunIssueReceipt => {
    if (
      issue.id !== id ||
      issue.team.id !== destination.teamId ||
      (issue.project?.id ?? null) !== (destination.projectId ?? null) ||
      !issue.description?.includes(marker) ||
      new URL(issue.url).origin !== "https://linear.app"
    )
      throw new HandlerError({
        code: "conflict",
        reason: "linear_issue_receipt_mismatch",
      });
    return {
      provider: "linear",
      destination,
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
    };
  };
  const fields = "id identifier url description team { id } project { id }";
  const reconcile = async (): Promise<RunIssueReceipt | null> => {
    const found = await linearGraphql(
      scope,
      token,
      `query($id:ID!){ issues(first:2,includeArchived:true,filter:{id:{eq:$id}}){nodes{${fields}}} }`,
      { id },
      z.object({ issues: z.object({ nodes: z.array(linearIssue) }) }),
    );
    return found.issues.nodes[0] ? receipt(found.issues.nodes[0]) : null;
  };
  const existing = await reconcile();
  if (existing) return existing;
  if (!request.allowCreate) uncertain();
  try {
    const result = await linearGraphql(
      scope,
      token,
      `mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{${fields}}}}`,
      {
        input: {
          id,
          title: request.title,
          description: `${request.body}\n\n${marker}`,
          teamId: destination.teamId,
          ...(destination.projectId
            ? { projectId: destination.projectId }
            : {}),
        },
      },
      z.object({
        issueCreate: z.object({
          success: z.boolean(),
          issue: linearIssue.nullable(),
        }),
      }),
    );
    if (!result.issueCreate.success || !result.issueCreate.issue) uncertain();
    return receipt(result.issueCreate.issue);
  } catch {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    uncertain();
  }
}

/** The caller owns the durable candidate claim and the user's selected set. */
export async function createRunIssue(
  scope: RunOutcomesScope,
  input: RunIssueCreateRequest,
): Promise<RunIssueReceipt> {
  await assertRunOutcomesAllowed(scope);
  const destination = runIssueDestinationSchema.parse(input.destination);
  if (
    !input.title.trim() ||
    input.title.length > 256 ||
    input.body.length > 60_000
  )
    throw new HandlerError({
      code: "conflict",
      reason: "run_issue_content_invalid",
    });
  return destination.provider === "github"
    ? createGithubIssue(scope, { ...input, destination })
    : createLinearIssue(scope, { ...input, destination });
}

export interface RunRepositoryStyle {
  repository: string;
  ref: string;
  files: Array<{ path: string; content: string; sha256: string }>;
  missing: string[];
  truncated: string[];
}
/** Repository text is untrusted evidence, pinned to the recorded commit. */
export async function readRunRepositoryStyle(
  scope: RunOutcomesScope,
  input: { owner: string; repo: string; ref: string },
): Promise<RunRepositoryStyle> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.ref))
    throw new HandlerError({
      code: "conflict",
      reason: "repository_style_requires_commit",
    });
  const token = await githubToken(
    scope,
    { provider: "github", owner: input.owner, repo: input.repo },
    true,
  );
  const result: RunRepositoryStyle = {
    repository: `${input.owner}/${input.repo}`,
    ref: input.ref,
    files: [],
    missing: [],
    truncated: [],
  };
  const paths = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    ".github/ISSUE_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ];
  let remaining = 65536;
  for (const path of paths) {
    await assertRunOutcomesAllowed(scope);
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${path}?ref=${input.ref}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) {
      result.missing.push(path);
      continue;
    }
    if (!response.ok)
      throw new HandlerError({
        code: "conflict",
        reason: "repository_style_unavailable",
      });
    const file = z
      .object({
        type: z.literal("file"),
        encoding: z.literal("base64"),
        content: z.string(),
        size: z.number().int().nonnegative(),
      })
      .parse(await response.json());
    if (file.size > 16384 || file.size > remaining) {
      result.truncated.push(path);
      continue;
    }
    const bytes = Buffer.from(file.content, "base64");
    if (
      bytes.length !== file.size ||
      bytes.length > 16384 ||
      bytes.length > remaining
    ) {
      result.truncated.push(path);
      continue;
    }
    remaining -= bytes.length;
    result.files.push({
      path,
      content: bytes.toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return result;
}
