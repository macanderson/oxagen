// Tests for health.events.ts. Each case reads a trimmed webhook payload from
// ./fixtures/health-events/, which keeps the fields GitHub and GitLab send and
// drops the ones the mapping never reads.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { githubHealthSignal, gitlabHealthSignal } from "./health.events";

type Payload = Record<string, unknown>;

function fixture(name: string): Payload {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/health-events/${name}.json`, import.meta.url), "utf8"),
  ) as Payload;
}

const STEERING_REPO = 904211873;
const ORG_REPO = 904211990;
const INSTALLATION = 61200044;
const GITLAB_PROJECT = 15;

describe("githubHealthSignal: repository rulesets", () => {
  it("reads repository settings after a ruleset rename", () => {
    expect(githubHealthSignal("repository_ruleset", fixture("github-ruleset-edited"))).toEqual({
      provider: "github",
      repository_ids: [STEERING_REPO],
      installation_id: null,
      trigger: {
        reason: "repository_ruleset.edited",
        actor: "dana-ops",
        at: "2026-09-26T18:41:07.000Z",
        settings: ["rulesets"],
        pull_request: null,
      },
    });
  });

  it("reads repository settings after a ruleset deletion", () => {
    const signal = githubHealthSignal("repository_ruleset", fixture("github-ruleset-deleted"));
    expect(signal?.trigger).toMatchObject({
      reason: "repository_ruleset.deleted",
      settings: ["rulesets"],
      at: "2026-09-26T20:15:42.000Z",
    });
    expect(signal?.repository_ids).toEqual([STEERING_REPO]);
  });

  it("names every ruleset when the ruleset is not in the baseline", () => {
    const signal = githubHealthSignal("repository_ruleset", fixture("github-ruleset-created"));
    expect(signal?.trigger.reason).toBe("repository_ruleset.created");
    expect(signal?.trigger.settings).toEqual(["rulesets"]);
  });

  it("does not treat old baseline rulesets as managed settings", () => {
    const body = fixture("github-ruleset-edited");
    body.repository_ruleset = { name: "Oxagen merges", updated_at: "2026-09-26T18:41:07Z" };
    body.changes = { name: { from: "oxagen  merges" }, enforcement: { from: "evaluate" } };
    expect(githubHealthSignal("repository_ruleset", body)?.trigger.settings).toEqual([
      "rulesets",
    ]);
  });

  it("asks for nothing on an organization ruleset", () => {
    expect(
      githubHealthSignal("repository_ruleset", fixture("github-ruleset-organization")),
    ).toBeNull();
  });

  it("asks for nothing on an action it does not know", () => {
    const body = { ...fixture("github-ruleset-edited"), action: "archived" };
    expect(githubHealthSignal("repository_ruleset", body)).toBeNull();
  });
});

describe("githubHealthSignal: branch protection configuration", () => {
  it("reads the repository with no setting named", () => {
    expect(
      githubHealthSignal(
        "branch_protection_configuration",
        fixture("github-branch-protection-configuration-disabled"),
      ),
    ).toEqual({
      provider: "github",
      repository_ids: [STEERING_REPO],
      installation_id: null,
      trigger: {
        reason: "branch_protection_configuration.disabled",
        actor: "dana-ops",
        at: null,
        settings: [],
        pull_request: null,
      },
    });
  });

  it("asks for nothing on another action", () => {
    const body = {
      ...fixture("github-branch-protection-configuration-disabled"),
      action: "requested",
    };
    expect(githubHealthSignal("branch_protection_configuration", body)).toBeNull();
  });

  it("asks for nothing on a classic branch protection rule, which the baseline does not hold", () => {
    const body = fixture("github-branch-protection-configuration-disabled");
    expect(githubHealthSignal("branch_protection_rule", { ...body, action: "edited" })).toBeNull();
  });
});

describe("githubHealthSignal: repository", () => {
  it("maps each listed change to the setting it touches", () => {
    expect(githubHealthSignal("repository", fixture("github-repository-edited"))).toEqual({
      provider: "github",
      repository_ids: [STEERING_REPO],
      installation_id: null,
      trigger: {
        reason: "repository.edited",
        actor: "dana-ops",
        at: "2026-09-26T21:02:48.000Z",
        settings: ["default_branch"],
        pull_request: null,
      },
    });
  });

  it("maps merge settings and visibility, and drops changes outside the baseline", () => {
    const body = fixture("github-repository-edited");
    body.changes = {
      allow_merge_commit: { from: false },
      delete_branch_on_merge: { from: true },
      private: { from: true },
      visibility: { from: "private" },
      description: { from: "Steering" },
    };
    expect(githubHealthSignal("repository", body)?.trigger.settings).toEqual([
      "merge.allow_merge_commit",
      "merge.delete_branch_on_merge",
      "visibility",
    ]);
  });

  it("names every setting an edit can touch when the delivery lists no change", () => {
    const body = { ...fixture("github-repository-edited"), changes: {} };
    expect(githubHealthSignal("repository", body)?.trigger.settings).toEqual([
      "visibility",
      "default_branch",
      "merge",
    ]);
    const { changes: _changes, ...withoutChanges } = fixture("github-repository-edited");
    expect(githubHealthSignal("repository", withoutChanges)?.trigger.settings).toEqual([
      "visibility",
      "default_branch",
      "merge",
    ]);
  });

  it("names no setting when every listed change is outside the baseline", () => {
    const body = {
      ...fixture("github-repository-edited"),
      changes: { description: { from: "Steering" }, homepage: { from: null } },
    };
    const signal = githubHealthSignal("repository", body);
    expect(signal?.repository_ids).toEqual([STEERING_REPO]);
    expect(signal?.trigger.settings).toEqual([]);
  });

  it("names visibility on privatized and publicized", () => {
    const signal = githubHealthSignal("repository", fixture("github-repository-privatized"));
    expect(signal?.trigger).toMatchObject({
      reason: "repository.privatized",
      settings: ["visibility"],
      at: "2026-09-26T21:20:00.000Z",
    });
    const publicized = { ...fixture("github-repository-privatized"), action: "publicized" };
    expect(githubHealthSignal("repository", publicized)?.trigger.settings).toEqual([
      "visibility",
    ]);
  });

  it("reads the repository with no setting named on a rename, transfer, deletion, or archive", () => {
    expect(githubHealthSignal("repository", fixture("github-repository-renamed"))?.trigger).toEqual(
      {
        reason: "repository.renamed",
        actor: "dana-ops",
        at: "2026-09-26T21:40:12.000Z",
        settings: [],
        pull_request: null,
      },
    );
    for (const action of ["transferred", "deleted", "archived", "unarchived"]) {
      const body = { ...fixture("github-repository-renamed"), action };
      expect(githubHealthSignal("repository", body)?.trigger).toMatchObject({
        reason: `repository.${action}`,
        settings: [],
      });
    }
  });

  it("asks for nothing on a repository creation", () => {
    const body = { ...fixture("github-repository-renamed"), action: "created" };
    expect(githubHealthSignal("repository", body)).toBeNull();
  });

  it("asks for nothing when the delivery names no repository", () => {
    const { repository: _repository, ...body } = fixture("github-repository-edited");
    expect(githubHealthSignal("repository", body)).toBeNull();
  });
});

describe("githubHealthSignal: installation", () => {
  it("reads every repository removed from the installation", () => {
    expect(
      githubHealthSignal(
        "installation_repositories",
        fixture("github-installation-repositories-removed"),
      ),
    ).toEqual({
      provider: "github",
      repository_ids: [STEERING_REPO, ORG_REPO],
      installation_id: null,
      trigger: {
        reason: "installation_repositories.removed",
        actor: "sam-admin",
        at: null,
        settings: [],
        pull_request: null,
      },
    });
  });

  it("reads every repository added back, so a disconnected repo recovers", () => {
    const body = {
      ...fixture("github-installation-repositories-removed"),
      action: "added",
      repositories_added: [{ id: STEERING_REPO }],
      repositories_removed: [],
    };
    expect(githubHealthSignal("installation_repositories", body)).toMatchObject({
      repository_ids: [STEERING_REPO],
      trigger: { reason: "installation_repositories.added" },
    });
  });

  it("asks for nothing when the delivery lists no repository", () => {
    const body = {
      ...fixture("github-installation-repositories-removed"),
      repositories_removed: [],
    };
    expect(githubHealthSignal("installation_repositories", body)).toBeNull();
  });

  it("reads the whole installation when it is suspended, timed by the suspension", () => {
    expect(githubHealthSignal("installation", fixture("github-installation-suspend"))).toEqual({
      provider: "github",
      repository_ids: [],
      installation_id: INSTALLATION,
      trigger: {
        reason: "installation.suspend",
        actor: "sam-admin",
        at: "2026-09-26T22:05:16.000Z",
        settings: [],
        pull_request: null,
      },
    });
  });

  it("reads the whole installation and its repositories when it is deleted", () => {
    expect(githubHealthSignal("installation", fixture("github-installation-deleted"))).toEqual({
      provider: "github",
      repository_ids: [STEERING_REPO, ORG_REPO],
      installation_id: INSTALLATION,
      trigger: {
        reason: "installation.deleted",
        actor: "sam-admin",
        at: "2026-09-26T22:30:02.000Z",
        settings: [],
        pull_request: null,
      },
    });
  });

  it("reads the installation on unsuspend and on accepted permissions", () => {
    for (const action of ["unsuspend", "new_permissions_accepted"]) {
      const body = { ...fixture("github-installation-suspend"), action };
      expect(githubHealthSignal("installation", body)).toMatchObject({
        installation_id: INSTALLATION,
        trigger: { reason: `installation.${action}`, at: "2026-09-26T22:05:17.000Z" },
      });
    }
  });

  it("asks for nothing on a new installation, which holds no ready steering repo", () => {
    const body = { ...fixture("github-installation-deleted"), action: "created" };
    expect(githubHealthSignal("installation", body)).toBeNull();
  });
});

describe("githubHealthSignal: push and pull requests", () => {
  it("reads the repository on a push to main, timed by the head commit", () => {
    expect(githubHealthSignal("push", fixture("github-push-main"))).toEqual({
      provider: "github",
      repository_ids: [STEERING_REPO],
      installation_id: null,
      trigger: {
        reason: "push",
        actor: "dana-ops",
        at: "2026-09-26T22:12:44.000Z",
        settings: [],
        pull_request: null,
      },
    });
  });

  it("times a push with no head commit by the repository's pushed_at, in Unix seconds", () => {
    const body = { ...fixture("github-push-main"), head_commit: null };
    expect(githubHealthSignal("push", body)?.trigger.at).toBe(
      new Date(1790547166 * 1000).toISOString(),
    );
  });

  it("asks for nothing on a push to another branch or a tag", () => {
    for (const ref of ["refs/heads/oxagen/refund-rule", "refs/tags/v1", "refs/heads/mainline"]) {
      expect(githubHealthSignal("push", { ...fixture("github-push-main"), ref })).toBeNull();
    }
  });

  it("carries the pull request and its new head when one opens", () => {
    expect(githubHealthSignal("pull_request", fixture("github-pull-request-opened"))).toEqual({
      provider: "github",
      repository_ids: [STEERING_REPO],
      installation_id: null,
      trigger: {
        reason: "pull_request.opened",
        actor: "oxagen-steering[bot]",
        at: "2026-09-26T15:01:22.000Z",
        settings: [],
        pull_request: { number: 42, head_sha: "c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4" },
      },
    });
  });

  it("carries the pull request on reopen, synchronize, and ready for review", () => {
    for (const action of ["reopened", "synchronize", "ready_for_review"]) {
      const body = { ...fixture("github-pull-request-opened"), action };
      expect(githubHealthSignal("pull_request", body)?.trigger).toMatchObject({
        reason: `pull_request.${action}`,
        pull_request: { number: 42 },
      });
    }
  });

  it("asks for nothing on a pull request action that leaves the head alone", () => {
    expect(githubHealthSignal("pull_request", fixture("github-pull-request-labeled"))).toBeNull();
    const closed = { ...fixture("github-pull-request-opened"), action: "closed" };
    expect(githubHealthSignal("pull_request", closed)).toBeNull();
  });

  it("asks for nothing when the pull request has no head sha", () => {
    const body = fixture("github-pull-request-opened");
    body.pull_request = { number: 42, head: { ref: "oxagen/refund-rule" } };
    expect(githubHealthSignal("pull_request", body)).toBeNull();
  });
});

describe("githubHealthSignal: other deliveries", () => {
  it("asks for nothing on an event it does not map", () => {
    expect(githubHealthSignal("ping", { zen: "Keep it logically awesome.", hook_id: 1 })).toBeNull();
    expect(githubHealthSignal("issues", fixture("github-pull-request-opened"))).toBeNull();
    expect(githubHealthSignal("check_run", fixture("github-push-main"))).toBeNull();
  });

  it("leaves the actor and time null when the delivery does not carry them", () => {
    const body = fixture("github-ruleset-deleted");
    delete body.sender;
    body.repository_ruleset = { name: "Oxagen steering", updated_at: "not a time" };
    expect(githubHealthSignal("repository_ruleset", body)?.trigger).toMatchObject({
      actor: null,
      at: null,
    });
  });

  it("drops a repository id that is not a positive integer", () => {
    const body = fixture("github-installation-repositories-removed");
    body.repositories_removed = [{ id: "904211873" }, { id: 1.5 }, { id: -3 }, null];
    expect(githubHealthSignal("installation_repositories", body)).toBeNull();
  });
});

describe("gitlabHealthSignal: project hooks", () => {
  it("reads the project on a push to main, timed by the commit main moved to", () => {
    expect(gitlabHealthSignal(fixture("gitlab-push-main"))).toEqual({
      provider: "gitlab",
      repository_ids: [GITLAB_PROJECT],
      installation_id: null,
      trigger: {
        reason: "push",
        actor: "dana-ops",
        at: "2026-09-26T16:12:44.000Z",
        settings: [],
        pull_request: null,
      },
    });
  });

  it("leaves the push time null when no listed commit is the new head", () => {
    const body = { ...fixture("gitlab-push-main"), commits: [] };
    expect(gitlabHealthSignal(body)?.trigger.at).toBeNull();
  });

  it("reads the project named by project_id when the project object is missing", () => {
    const { project: _project, ...body } = fixture("gitlab-push-main");
    expect(gitlabHealthSignal(body)?.repository_ids).toEqual([GITLAB_PROJECT]);
  });

  it("asks for nothing on a push to another branch", () => {
    const body = { ...fixture("gitlab-push-main"), ref: "refs/heads/oxagen/refund-rule" };
    expect(gitlabHealthSignal(body)).toBeNull();
  });

  it("carries the merge request and its head when one opens, reading GitLab's UTC time", () => {
    expect(gitlabHealthSignal(fixture("gitlab-merge-request-open"))).toEqual({
      provider: "gitlab",
      repository_ids: [GITLAB_PROJECT],
      installation_id: null,
      trigger: {
        reason: "merge_request.open",
        actor: "oxagen-steering-bot",
        at: "2026-09-26T15:01:22.000Z",
        settings: [],
        pull_request: { number: 7, head_sha: "8f2e5d71a0c3b94e6d1f7a2c5b8e0d3f6a9c1b4e" },
      },
    });
  });

  it("carries the new head on an update, reading GitLab's offset time", () => {
    expect(gitlabHealthSignal(fixture("gitlab-merge-request-update"))?.trigger).toEqual({
      reason: "merge_request.update",
      actor: "dana-ops",
      at: "2026-09-26T14:20:05.000Z",
      settings: [],
      pull_request: { number: 7, head_sha: "1d4c7e0b3a6f9c2e5b8d1a4f7c0e3b6d9a2c5f8e" },
    });
  });

  it("carries the merge request on a reopen", () => {
    const body = fixture("gitlab-merge-request-open");
    body.object_attributes = { ...(body.object_attributes as Payload), action: "reopen" };
    expect(gitlabHealthSignal(body)?.trigger.reason).toBe("merge_request.reopen");
  });

  it("asks for nothing on a merge request action that leaves the head alone", () => {
    expect(gitlabHealthSignal(fixture("gitlab-merge-request-approved"))).toBeNull();
  });

  it("asks for nothing when the merge request has no last commit", () => {
    const body = fixture("gitlab-merge-request-open");
    body.object_attributes = { action: "open", iid: 7, target_project_id: 15 };
    expect(gitlabHealthSignal(body)).toBeNull();
  });

  it("asks for nothing on a project hook event it does not map", () => {
    expect(gitlabHealthSignal({ ...fixture("gitlab-push-main"), object_kind: "tag_push" })).toBeNull();
    expect(gitlabHealthSignal({ object_kind: "note", project_id: 15 })).toBeNull();
  });
});

describe("gitlabHealthSignal: system hooks", () => {
  it("names every project setting on a project update", () => {
    expect(gitlabHealthSignal(fixture("gitlab-system-project-update"))).toEqual({
      provider: "gitlab",
      repository_ids: [GITLAB_PROJECT],
      installation_id: null,
      trigger: {
        reason: "project_update",
        actor: null,
        at: "2026-09-26T19:44:02.000Z",
        settings: ["visibility", "default_branch", "merge_requests", "ci_cd"],
        pull_request: null,
      },
    });
  });

  it("reads the project with no setting named on a rename or a membership change", () => {
    expect(gitlabHealthSignal(fixture("gitlab-system-project-rename"))?.trigger).toMatchObject({
      reason: "project_rename",
      settings: [],
    });
    expect(gitlabHealthSignal(fixture("gitlab-system-user-add-to-team"))).toMatchObject({
      repository_ids: [GITLAB_PROJECT],
      trigger: { reason: "user_add_to_team", actor: null, settings: [] },
    });
    for (const event_name of [
      "project_transfer",
      "project_destroy",
      "user_remove_from_team",
      "user_update_for_team",
    ]) {
      const body = { ...fixture("gitlab-system-project-rename"), event_name };
      expect(gitlabHealthSignal(body)?.trigger.reason).toBe(event_name);
    }
  });

  it("asks for nothing on a system event it does not map", () => {
    expect(gitlabHealthSignal(fixture("gitlab-system-group-create"))).toBeNull();
    expect(gitlabHealthSignal({ event_name: "constructor", project_id: 15 })).toBeNull();
  });

  it("asks for nothing when a system event names no project", () => {
    const { project_id: _id, ...body } = fixture("gitlab-system-project-update");
    expect(gitlabHealthSignal(body)).toBeNull();
  });

  it("asks for nothing on an empty body", () => {
    expect(gitlabHealthSignal({})).toBeNull();
  });
});
