// deployment.ts: record that the steering repo is live, as a GitLab deployment.
//
// A rerun lists the environment's deployments first and reuses the one for
// the same sha. It sets that deployment's status to success when a lost
// answer left it at another status, and creates nothing.
import { requireData, seg } from "./http";
import type { GitlabRest } from "./http";

interface DeploymentBody {
  id: number;
  sha: string;
  status: string;
}

/**
 * Record a successful deployment of `sha` to `environment`. GitLab creates
 * the environment when it does not exist yet. `created` says whether this
 * call made a new deployment.
 */
export async function recordGitlabDeployment(
  rest: GitlabRest,
  input: { project_id: number; environment: string; ref: string; sha: string },
): Promise<{ deployment_id: number; created: boolean }> {
  const root = `/projects/${seg(input.project_id)}/deployments`;
  const list = await rest.request<DeploymentBody[]>(
    "GET",
    `${root}?environment=${seg(input.environment)}&order_by=id&sort=desc&per_page=100`,
  );
  const existing = requireData(list, "deployments").find((d) => d.sha === input.sha);
  if (existing !== undefined) {
    if (existing.status !== "success")
      await rest.request("PUT", `${root}/${seg(existing.id)}`, { status: "success" });
    return { deployment_id: existing.id, created: false };
  }
  const res = await rest.request<DeploymentBody>("POST", root, {
    environment: input.environment,
    sha: input.sha,
    ref: input.ref,
    tag: false,
    status: "success",
  });
  return { deployment_id: requireData(res, "deployment").id, created: true };
}
