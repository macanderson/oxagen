// deployment.ts: record a published version as a deployment to the steering
// environment, so the repository page shows it.
//
// A rerun finds the deployment it recorded by its version and only adds the
// success status if an earlier run stopped before it.
import { seg, type GithubRest } from "./http";
import type { RepoAddress } from "./types";

export interface PublishDeploymentInput {
  repo: RepoAddress;
  environment: string;
  /** The branch Oxagen publishes from. GitHub resolves it to its head. */
  ref: string;
  /** The commit the published version was built from. */
  sha: string;
  version: number;
  description: string;
}

export interface PublishDeploymentResult {
  deployment_id: number;
  /** False when an earlier run had already recorded this version. */
  created: boolean;
}

interface GhDeployment {
  id: number;
  sha: string;
  payload?: unknown;
}

function versionOf(payload: unknown): number | null {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (value !== null && typeof value === "object") {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "number") return version;
  }
  return null;
}

export async function recordDeployment(
  rest: GithubRest,
  input: PublishDeploymentInput,
): Promise<PublishDeploymentResult> {
  const root = `/repos/${seg(input.repo.owner)}/${seg(input.repo.name)}`;
  const list = await rest.request<GhDeployment[]>(
    "GET",
    `${root}/deployments?environment=${seg(input.environment)}&per_page=100`,
  );
  let deployment = (list.data ?? []).find(
    (d) => versionOf(d.payload) === input.version && d.sha === input.sha,
  );
  let created = false;
  if (deployment === undefined) {
    const res = await rest.request<GhDeployment>("POST", `${root}/deployments`, {
      ref: input.ref,
      environment: input.environment,
      auto_merge: false,
      // Oxagen runs every check itself. The deployment waits on none.
      required_contexts: [],
      payload: { version: input.version },
      description: input.description,
      production_environment: true,
    });
    if (res.data === null || typeof res.data.id !== "number")
      throw new Error("GitHub returned no deployment");
    deployment = res.data;
    created = true;
  }

  const statuses = await rest.request<{ state: string }[]>(
    "GET",
    `${root}/deployments/${seg(deployment.id)}/statuses?per_page=1`,
  );
  if (statuses.data?.[0]?.state !== "success")
    await rest.request("POST", `${root}/deployments/${seg(deployment.id)}/statuses`, {
      state: "success",
      environment: input.environment,
      description: input.description,
    });

  return { deployment_id: deployment.id, created };
}
