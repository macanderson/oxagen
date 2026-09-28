// repository.ts: create a steering repo, find it again on a rerun, and add it
// to the Oxagen Steering installation.
import { GitHubApiError } from "../fetch-client";
import { seg, type GithubRest } from "./http";
import type { ProvisionedRepository, RepoAddress } from "./types";

/**
 * A step that needs a person. The owner's user token that adds a repository
 * to the installation is missing, expired, or revoked, so an owner must
 * authorize Oxagen Steering again before provisioning can continue.
 */
export class SteeringReauthorizeError extends Error {
  readonly code = "steering_reauthorize";

  constructor(message: string) {
    super(message);
    this.name = "SteeringReauthorizeError";
  }
}

interface GhRepository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch?: string | null;
  description?: string | null;
}

function toRepository(r: GhRepository): ProvisionedRepository {
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    full_name: r.full_name,
    default_branch: r.default_branch ?? "main",
  };
}

/** A repository with the description Oxagen wrote when it created it. */
export interface FoundRepository extends ProvisionedRepository {
  description: string;
}

/** Read one repository. Null when the token cannot see it. */
export async function getRepository(
  rest: GithubRest,
  repo: RepoAddress,
): Promise<FoundRepository | null> {
  const res = await rest.request<GhRepository>(
    "GET",
    `/repos/${seg(repo.owner)}/${seg(repo.name)}`,
    undefined,
    [404],
  );
  if (res.data === null) return null;
  return { ...toRepository(res.data), description: res.data.description ?? "" };
}

export type CreateRepositoryResult =
  | { status: "created"; repository: ProvisionedRepository }
  | { status: "name_taken" };

/**
 * Create a private repository in an organization. GitHub answers 422 when the
 * name is taken, and that comes back as `name_taken`.
 */
export async function createRepository(
  rest: GithubRest,
  input: { org: string; name: string; description: string },
): Promise<CreateRepositoryResult> {
  const res = await rest.request<GhRepository>(
    "POST",
    `/orgs/${seg(input.org)}/repos`,
    {
      name: input.name,
      description: input.description,
      private: true,
      // An empty repository has no branch to point a ref at. The first commit
      // replaces this one, so its content does not matter.
      auto_init: true,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    },
    [422],
  );
  if (res.status === 422) {
    if (/already exists/i.test(res.message ?? ""))
      return { status: "name_taken" };
    throw new GitHubApiError(422, res.message ?? "status 422");
  }
  if (res.data === null)
    throw new GitHubApiError(res.status, "GitHub returned no repository");
  return { status: "created", repository: toRepository(res.data) };
}

/** The name to try on attempt `n`, counting from 1: `base`, `base-2`, `base-3`. */
export function candidateName(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

export interface CreateOrAdoptInput {
  org: string;
  /** The name to try first, such as `oxagen-support`. */
  base_name: string;
  /**
   * The repository description. It carries `marker`, so a rerun can tell the
   * repository it created from one someone else owns.
   */
  description: string;
  /** A string only this scope's steering repo carries in its description. */
  marker: string;
  /** Which attempt to start from. A rerun passes the attempt it recorded. */
  first_attempt?: number;
  /** Give up after this many names. */
  max_attempts?: number;
  /**
   * Tokens to look a taken name up with, in order. An app token cannot see a
   * repository that is not yet in its installation, so the handler also
   * passes the owner's user token when it has one.
   */
  lookups: readonly GithubRest[];
  /** Called before each create, so the caller can record the attempt. */
  on_attempt?: (attempt: number, name: string) => Promise<void>;
}

export interface CreateOrAdoptResult {
  repository: ProvisionedRepository;
  attempt: number;
  /** True when an earlier run had already created this repository. */
  adopted: boolean;
}

/**
 * Create the steering repo, adding `-2`, `-3` and so on while the name is
 * taken. A taken name whose description carries this scope's marker is the
 * repository an earlier run created, so it is adopted instead of skipped.
 */
export async function createOrAdoptRepository(
  rest: GithubRest,
  input: CreateOrAdoptInput,
): Promise<CreateOrAdoptResult> {
  const first = Math.max(1, input.first_attempt ?? 1);
  const last = first + (input.max_attempts ?? 20) - 1;
  for (let attempt = first; attempt <= last; attempt++) {
    const name = candidateName(input.base_name, attempt);
    await input.on_attempt?.(attempt, name);
    const created = await createRepository(rest, {
      org: input.org,
      name,
      description: input.description,
    });
    if (created.status === "created")
      return { repository: created.repository, attempt, adopted: false };
    for (const lookup of input.lookups) {
      const found = await getRepository(lookup, { owner: input.org, name });
      if (found === null) continue;
      if (found.description.includes(input.marker)) {
        const { description: _description, ...repository } = found;
        return { repository, attempt, adopted: true };
      }
      break;
    }
  }
  throw new GitHubApiError(
    422,
    `Every name from ${candidateName(input.base_name, first)} to ${candidateName(input.base_name, last)} is taken in ${input.org}.`,
  );
}

/** An installation of Oxagen Steering that the owner's token can see. */
export interface SteeringInstallation {
  id: number;
  account_login: string;
  account_type: string;
  repository_selection: "all" | "selected";
}

interface GhInstallation {
  id: number;
  app_id?: number;
  account: { login: string; type: string } | null;
  repository_selection: "all" | "selected";
}

function reauthorize(status: number): SteeringReauthorizeError {
  return new SteeringReauthorizeError(
    `GitHub refused the organization owner's Oxagen Steering authorization (status ${status}). An owner must authorize Oxagen Steering again.`,
  );
}

/**
 * The installations of Oxagen Steering the owner's user token can reach. A
 * user token only lists installations of the app that issued it.
 */
export async function listSteeringInstallations(
  userRest: GithubRest,
): Promise<SteeringInstallation[]> {
  const res = await userRest.request<{ installations: GhInstallation[] }>(
    "GET",
    "/user/installations?per_page=100",
    undefined,
    [401, 403],
  );
  if (res.data === null) throw reauthorize(res.status);
  return res.data.installations
    .filter((i) => i.account !== null)
    .map((i) => ({
      id: i.id,
      account_login: i.account?.login ?? "",
      account_type: i.account?.type ?? "",
      repository_selection: i.repository_selection,
    }));
}

/**
 * Add a repository to an installation limited to selected repositories.
 * GitHub answers 204 when it adds it and 304 when it was already there. A
 * 401, 403, or 404 means the owner's token no longer works for this
 * installation, so an owner must authorize again.
 */
export async function addRepositoryToInstallation(
  userRest: GithubRest,
  input: { installation_id: number; repository_id: number },
): Promise<"added" | "already_added"> {
  const res = await userRest.request<unknown>(
    "PUT",
    `/user/installations/${seg(input.installation_id)}/repositories/${seg(input.repository_id)}`,
    undefined,
    [304, 401, 403, 404],
  );
  if (res.status === 304) return "already_added";
  if (res.status >= 400) throw reauthorize(res.status);
  return "added";
}
