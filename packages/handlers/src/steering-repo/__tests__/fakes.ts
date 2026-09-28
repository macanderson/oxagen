// fakes.ts: a fake GitHub and a fake GitLab that each hold a steering repo at
// the baseline, for the health and repair tests. Both are the fakes the
// provisioning tests use, so a test runs the real settings reads and writes.
import * as gh from "@oxagen/github/provision";
import { FakeGithub } from "@oxagen/github/provision/testing";
import * as gl from "@oxagen/gitlab/provision";
import { FakeGitlab } from "@oxagen/gitlab/provision/testing";
import {
  GITHUB_SETTINGS_BASELINE,
  GITLAB_SETTINGS_BASELINE,
  OXAGEN_STEERING_APP,
} from "@oxagen/oxagen/steering-repo";
import { expect } from "vitest";

export const APP: gh.SteeringApp = {
  symbol: OXAGEN_STEERING_APP,
  id: 4242,
  slug: "oxagen-steering",
};
export const REPO: gh.RepoAddress = { owner: "acme", name: "steering" };

export interface Seen {
  owner: string;
  name: string;
}

/**
 * The fake GitHub, with `/repositories/{id}` added. The fake has no such
 * route, and the health read and repair find the repository by id. `answer`
 * replaces the reply when a test needs a refusal.
 */
export function withRepositories(
  hub: FakeGithub,
  repos: Map<number, Seen>,
  answer?: { status: number; body: unknown },
): gh.HttpFetch {
  return (url, init) => {
    const match = /^https:\/\/api\.github\.com\/repositories\/(\d+)$/.exec(url);
    if (match === null) return hub.fetch(url, init);
    const found = repos.get(Number(match[1]));
    const reply =
      answer ??
      (found === undefined
        ? { status: 404, body: { message: "Not Found" } }
        : {
            status: 200,
            body: {
              name: found.name,
              full_name: `${found.owner}/${found.name}`,
              owner: { login: found.owner },
            },
          });
    return Promise.resolve({
      status: reply.status,
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  };
}

/** A fake GitHub holding a steering repo at the baseline, with its id. */
export async function baselineRepo(): Promise<{ hub: FakeGithub; id: number }> {
  const hub = new FakeGithub({ org: "acme", app: APP });
  const id = hub.seedRepository({ name: REPO.name, in_installation: true });
  await gh.writeFirstCommit(hub.appRest(), {
    repo: REPO,
    files: [{ path: "README.md", content: "# Steering\n" }],
    message: "Oxagen steering v1",
    initial_branch: "main",
  });
  const applied = await gh.applySettings(hub.appRest(), REPO, APP, GITHUB_SETTINGS_BASELINE);
  expect(applied.remaining).toEqual([]);
  return { hub, id };
}

export const GROUP = { id: 7, full_path: "acme" };
export const BOT_USER = { user_id: 99, username: "group_7_bot" };
export const BOT: gl.SteeringBot = { symbol: OXAGEN_STEERING_APP, ...BOT_USER };

/** A fake GitLab holding a steering project at the baseline, with its id. */
export async function baselineProject(): Promise<{ lab: FakeGitlab; id: number }> {
  const lab = new FakeGitlab({ group: GROUP, bot: BOT_USER });
  const id = lab.seedProject({ name: "steering" });
  await lab.rest().request("POST", `/projects/${id}/repository/commits`, {
    branch: "main",
    commit_message: "Oxagen steering v1",
    actions: [{ action: "create", file_path: "README.md", content: "# Steering\n" }],
  });
  const applied = await gl.applyGitlabSettings(lab.rest(), id, BOT, GITLAB_SETTINGS_BASELINE);
  expect(applied.remaining).toEqual([]);
  return { lab, id };
}
