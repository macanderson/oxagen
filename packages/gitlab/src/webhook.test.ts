import { describe, expect, it } from "vitest";
import { parseGitLabWebhookEvent, verifyGitLabWebhookToken } from "./webhook";

describe("verifyGitLabWebhookToken", () => {
  it("accepts the matching secret", () => {
    expect(verifyGitLabWebhookToken("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    expect(verifyGitLabWebhookToken("s3creT", "s3cret")).toBe(false);
  });

  it("rejects a different length", () => {
    expect(verifyGitLabWebhookToken("s3cret-longer", "s3cret")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyGitLabWebhookToken(null, "s3cret")).toBe(false);
    expect(verifyGitLabWebhookToken(undefined, "s3cret")).toBe(false);
  });

  it("rejects everything when no secret is stored", () => {
    expect(verifyGitLabWebhookToken("", "")).toBe(false);
  });

  it("compares multi-byte secrets by bytes", () => {
    expect(verifyGitLabWebhookToken("clé", "clé")).toBe(true);
    expect(verifyGitLabWebhookToken("cle", "clé")).toBe(false);
  });
});

/** Trimmed from the merge request event sample in GitLab's webhook docs. */
const MERGE_REQUEST_HOOK = {
  object_kind: "merge_request",
  event_type: "merge_request",
  user: { id: 1, name: "Administrator", username: "root" },
  project: {
    id: 1,
    name: "Gitlab Test",
    web_url: "http://example.com/gitlabhq/gitlab-test",
    path_with_namespace: "gitlabhq/gitlab-test",
    default_branch: "master",
  },
  repository: {
    name: "Gitlab Test",
    url: "http://example.com/gitlabhq/gitlab-test.git",
  },
  object_attributes: {
    id: 99,
    iid: 1,
    target_branch: "master",
    source_branch: "ms-viewport",
    source_project_id: 14,
    author_id: 51,
    title: "MS-Viewport",
    created_at: "2013-12-03T17:23:34Z",
    updated_at: "2013-12-03T17:23:34Z",
    state: "opened",
    merge_status: "unchecked",
    detailed_merge_status: "not_open",
    target_project_id: 14,
    merge_commit_sha: null,
    last_commit: {
      id: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
      message: "fixed readme",
      timestamp: "2012-01-03T23:36:29+02:00",
    },
    url: "http://example.com/diaspora/merge_requests/1",
    action: "open",
  },
  labels: [],
  changes: {},
};

type Hook = {
  project: Record<string, unknown>;
  object_attributes: Record<string, unknown>;
};

/** A mutable copy of the sample, typed loosely enough to delete fields from. */
function hook(): Hook {
  return structuredClone(MERGE_REQUEST_HOOK) as unknown as Hook;
}

describe("parseGitLabWebhookEvent", () => {
  it("parses a merge request event", () => {
    expect(parseGitLabWebhookEvent(MERGE_REQUEST_HOOK)).toEqual({
      kind: "merge_request",
      projectId: "1",
      projectPathWithNamespace: "gitlabhq/gitlab-test",
      iid: 1,
      action: "open",
      state: "opened",
      sourceBranch: "ms-viewport",
      targetBranch: "master",
      lastCommitSha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
      updatedAt: "2013-12-03T17:23:34Z",
      mergeCommitSha: null,
    });
  });

  it("reads a merged event's merge commit and tolerates a missing action", () => {
    const body = hook();
    body.object_attributes.state = "merged";
    body.object_attributes.merge_commit_sha = "m1";
    delete body.object_attributes.action;
    delete body.object_attributes.last_commit;
    const event = parseGitLabWebhookEvent(body);
    expect(event).toMatchObject({
      kind: "merge_request",
      state: "merged",
      mergeCommitSha: "m1",
      action: null,
      lastCommitSha: null,
    });
  });

  it("falls back to target_project_id when project.id is absent", () => {
    const body = hook();
    delete body.project.id;
    expect(parseGitLabWebhookEvent(body)).toMatchObject({ projectId: "14" });
  });

  it("returns null for a merge request event missing required fields", () => {
    const noAttrs = { ...MERGE_REQUEST_HOOK, object_attributes: undefined };
    expect(parseGitLabWebhookEvent(noAttrs)).toBeNull();
    const body = hook();
    body.object_attributes.iid = "1";
    expect(parseGitLabWebhookEvent(body)).toBeNull();
    const noProject = { ...MERGE_REQUEST_HOOK, project: null };
    expect(parseGitLabWebhookEvent(noProject)).toBeNull();
  });

  it("reports a push event as other", () => {
    expect(
      parseGitLabWebhookEvent({
        object_kind: "push",
        event_name: "push",
        ref: "refs/heads/master",
        project_id: 15,
        project: { id: 15, path_with_namespace: "mike/diaspora" },
      }),
    ).toEqual({
      kind: "other",
      objectKind: "push",
      projectId: "15",
      projectPathWithNamespace: "mike/diaspora",
    });
  });

  it("reads project_id when an event has no project object", () => {
    expect(
      parseGitLabWebhookEvent({ object_kind: "build", project_id: "22" }),
    ).toEqual({
      kind: "other",
      objectKind: "build",
      projectId: "22",
      projectPathWithNamespace: null,
    });
    expect(parseGitLabWebhookEvent({ object_kind: "note" })).toMatchObject({
      projectId: null,
    });
  });

  it.each([
    [null],
    [undefined],
    ["merge_request"],
    [42],
    [[{ object_kind: "push" }]],
    [{}],
    [{ object_kind: "" }],
    [{ object_kind: 7 }],
  ])("returns null for %j", (body) => {
    expect(parseGitLabWebhookEvent(body)).toBeNull();
  });
});
