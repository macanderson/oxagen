import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time compare of the `X-Gitlab-Token` header against the stored
 * secret. Missing header or length mismatch -> false; never throws.
 *
 * GitLab does not sign webhook bodies. It echoes the secret set on the hook
 * in `X-Gitlab-Token`, so the comparison is the whole authentication step. An
 * ordinary `===` returns as soon as a byte differs, which lets a caller learn
 * the secret one byte at a time from response timings. An empty stored secret
 * never matches, so a hook saved without a secret accepts nothing.
 */
export function verifyGitLabWebhookToken(
  header: string | null | undefined,
  secret: string,
): boolean {
  if (typeof header !== "string" || typeof secret !== "string") return false;
  if (secret.length === 0) return false;
  const given = Buffer.from(header, "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export interface GitLabMergeRequestEvent {
  kind: "merge_request";
  projectId: string;
  projectPathWithNamespace: string;
  iid: number;
  action: string | null;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  lastCommitSha: string | null;
  updatedAt: string;
  mergeCommitSha: string | null;
}

export interface GitLabOtherEvent {
  kind: "other";
  objectKind: string;
  projectId: string | null;
  projectPathWithNamespace: string | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A GitLab id arrives as a JSON number. A decimal string is accepted too. */
function id(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

/**
 * Parses a webhook JSON body (already JSON.parse'd, typed unknown). Returns
 * null when the body is not an object with an object_kind. Never throws.
 *
 * A merge request event that lacks a field the event type always carries
 * (the project id and path, the iid, the state, both branches, and
 * `updated_at`) also returns null. A body that claims to be a merge request
 * event and is missing those is not one GitLab sent.
 */
export function parseGitLabWebhookEvent(
  body: unknown,
): GitLabMergeRequestEvent | GitLabOtherEvent | null {
  if (!isObject(body)) return null;
  const objectKind = str(body.object_kind);
  if (objectKind === null || objectKind === "") return null;

  const project = isObject(body.project) ? body.project : null;
  if (objectKind !== "merge_request") {
    return {
      kind: "other",
      objectKind,
      projectId: id(project?.id) ?? id(body.project_id),
      projectPathWithNamespace: str(project?.path_with_namespace),
    };
  }

  const attrs = isObject(body.object_attributes)
    ? body.object_attributes
    : null;
  if (attrs === null) return null;
  const projectId = id(project?.id) ?? id(attrs.target_project_id);
  const projectPath = str(project?.path_with_namespace);
  const iid = attrs.iid;
  const state = str(attrs.state);
  const sourceBranch = str(attrs.source_branch);
  const targetBranch = str(attrs.target_branch);
  const updatedAt = str(attrs.updated_at);
  if (
    projectId === null ||
    projectPath === null ||
    typeof iid !== "number" ||
    !Number.isSafeInteger(iid) ||
    state === null ||
    sourceBranch === null ||
    targetBranch === null ||
    updatedAt === null
  ) {
    return null;
  }
  const lastCommit = isObject(attrs.last_commit) ? attrs.last_commit : null;
  return {
    kind: "merge_request",
    projectId,
    projectPathWithNamespace: projectPath,
    iid,
    action: str(attrs.action),
    state,
    sourceBranch,
    targetBranch,
    lastCommitSha: str(lastCommit?.id),
    updatedAt,
    mergeCommitSha: str(attrs.merge_commit_sha),
  };
}
