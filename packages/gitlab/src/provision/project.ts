// project.ts: find the group, then create or adopt the steering project.
//
// A create whose answer was lost leaves a project behind. The next attempt
// finds the name taken, looks the project up, and adopts it when its
// description carries this provisioning's marker. A project without the
// marker belongs to someone else, so the step moves on to the next name.
import { GitLabApiError } from "../client";
import { STEERING_BRANCH } from "./first-commit";
import { requireData, seg } from "./http";
import type { GitlabRest } from "./http";
import type { ProvisionedProject, SteeringGroup } from "./types";

interface UserBody {
  id: number;
  username: string;
}

interface GroupBody {
  id: number;
  full_path: string;
}

interface ProjectBody {
  id: number;
  path: string;
  path_with_namespace: string;
  description: string | null;
  default_branch: string | null;
  namespace: { full_path: string };
}

function toProject(body: ProjectBody): ProvisionedProject {
  return {
    id: body.id,
    path_with_namespace: body.path_with_namespace,
    namespace_path: body.namespace.full_path,
    name: body.path,
    // GitLab reports no default branch while the repository is empty.
    default_branch: body.default_branch ?? STEERING_BRANCH,
  };
}

/** The user the token acts as. For a group access token, that is its bot user. */
export async function getCurrentUser(
  rest: GitlabRest,
): Promise<{ id: number; username: string }> {
  const user = requireData(await rest.request<UserBody>("GET", "/user"), "user");
  return { id: user.id, username: user.username };
}

/** The group, or null when the token cannot see it. */
export async function getGroup(
  rest: GitlabRest,
  group_id: number,
): Promise<SteeringGroup | null> {
  const res = await rest.request<GroupBody>(
    "GET",
    `/groups/${seg(group_id)}?with_projects=false`,
    undefined,
    [404],
  );
  if (res.status === 404) return null;
  const group = requireData(res, "group");
  return { id: group.id, full_path: group.full_path };
}

/** A project as a lookup found it, with the description adoption reads. */
export interface FoundProject extends ProvisionedProject {
  description: string;
}

/** The project at `path_with_namespace`, such as `acme/oxagen-support`, or null. */
export async function getProject(
  rest: GitlabRest,
  path_with_namespace: string,
): Promise<FoundProject | null> {
  const res = await rest.request<ProjectBody>(
    "GET",
    `/projects/${seg(path_with_namespace)}`,
    undefined,
    [404],
  );
  if (res.status === 404) return null;
  const body = requireData(res, "project");
  return { ...toProject(body), description: body.description ?? "" };
}

export type CreateProjectResult =
  | { status: "created"; project: ProvisionedProject }
  | { status: "name_taken" };

/**
 * Create a private, empty project in the group. GitLab answers 400 with
 * "has already been taken" when the name or path is in use, which returns
 * `name_taken`. Any other 400 throws.
 */
export async function createProject(
  rest: GitlabRest,
  input: { namespace_id: number; name: string; description: string },
): Promise<CreateProjectResult> {
  const res = await rest.request<ProjectBody>(
    "POST",
    "/projects",
    {
      name: input.name,
      path: input.name,
      namespace_id: input.namespace_id,
      description: input.description,
      visibility: "private",
      initialize_with_readme: false,
      default_branch: STEERING_BRANCH,
    },
    [400],
  );
  if (res.status === 400) {
    const message = res.message ?? "status 400";
    if (/has already been taken/i.test(message)) return { status: "name_taken" };
    throw new GitLabApiError(400, message);
  }
  return { status: "created", project: toProject(requireData(res, "project")) };
}

/** The name to try on attempt `n`, counting from 1: `base`, `base-2`, `base-3`. */
export function candidateName(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

export interface CreateOrAdoptProjectInput {
  group: SteeringGroup;
  base_name: string;
  /** The description to create with. It carries `marker`. */
  description: string;
  /** The text that marks a project as this provisioning's own. */
  marker: string;
  /** The attempt to start from, so a retried step resumes its count. */
  first_attempt?: number;
  /** How many names to try. Defaults to 20. */
  max_attempts?: number;
  /** Called before each attempt, so the caller can record its progress. */
  on_attempt?: (attempt: number, name: string) => Promise<void>;
}

/**
 * Create the project under the first free name, or adopt the project this
 * provisioning created on an attempt whose answer was lost. When every name
 * is taken, it throws `GitLabApiError` with status 400, the status GitLab
 * gives a taken name.
 */
export async function createOrAdoptProject(
  rest: GitlabRest,
  input: CreateOrAdoptProjectInput,
): Promise<{ project: ProvisionedProject; attempt: number; adopted: boolean }> {
  const first = Math.max(1, input.first_attempt ?? 1);
  const last = first + (input.max_attempts ?? 20) - 1;
  for (let attempt = first; attempt <= last; attempt++) {
    const name = candidateName(input.base_name, attempt);
    await input.on_attempt?.(attempt, name);
    const created = await createProject(rest, {
      namespace_id: input.group.id,
      name,
      description: input.description,
    });
    if (created.status === "created")
      return { project: created.project, attempt, adopted: false };
    const found = await getProject(rest, `${input.group.full_path}/${name}`);
    if (found !== null && found.description.includes(input.marker)) {
      const { description: _description, ...project } = found;
      return { project, attempt, adopted: true };
    }
  }
  throw new GitLabApiError(
    400,
    `Every name from ${candidateName(input.base_name, first)} to ${candidateName(input.base_name, last)} is taken in ${input.group.full_path}.`,
  );
}
