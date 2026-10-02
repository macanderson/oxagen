// What the create-workspace forms send for the new workspace's steering repo
// (#5196): the GitHub organization or GitLab group it goes in, and its name.
// `SteeringRepoDestinationFields` draws the two fields, and each form reads
// them back out of its FormData with `steeringRepoDraftOf`.
import { slugFromName } from "@oxagen/oxagen/contracts/org.create";
import {
  defaultSteeringRepoName,
  steeringRepoNameInput,
} from "@oxagen/oxagen/contracts/steering_repo.shared";
import type { SteeringRepoDestinationsListOutput } from "@oxagen/oxagen/contracts/steering_repo.destinations.list";
import type { WorkspaceCreateInput } from "@oxagen/oxagen/contracts/workspace.create";

/** What `list_steering_repo_destinations` answered. */
export type SteeringRepoDestinations = SteeringRepoDestinationsListOutput;

/** One place a steering repo can go. */
export type SteeringRepoDestination =
  SteeringRepoDestinations["destinations"][number];

/** `create_workspace`'s `steeringRepo`, as a form sends it. */
export type SteeringRepoDraft = NonNullable<
  WorkspaceCreateInput["steeringRepo"]
>;

/** The form field the Organization select writes. */
export const CONNECTION_FIELD = "steeringConnection";
/** The form field the Repository name input writes. */
export const REPO_NAME_FIELD = "steeringRepoName";

/** A place as the select's option value: `github:123`. */
export function connectionValue(
  place: Pick<SteeringRepoDestination, "provider" | "id">,
): string {
  return `${place.provider}:${String(place.id)}`;
}

/** The place an option value names, or null for a value that names none. */
export function parseConnectionValue(
  value: string,
): SteeringRepoDraft["connection"] | null {
  const match = /^(github|gitlab):([1-9][0-9]{0,15})$/.exec(value);
  if (match === null) return null;
  const provider = match[1] === "gitlab" ? "gitlab" : "github";
  return { provider, id: Number(match[2]) };
}

/**
 * The name a workspace called `workspaceName` gets by default, `oxagen-<slug>`,
 * or the empty string while the name makes no workspace slug. A name the
 * contract would refuse as a slug, such as one letter, makes none.
 */
export function defaultRepoName(workspaceName: string): string {
  return defaultRepoNameForSlug(slugFromName(workspaceName.trim()));
}

/** The default name of the steering repo of the workspace `slug`, or "". */
export function defaultRepoNameForSlug(slug: string): string {
  if (slug === "") return "";
  try {
    return defaultSteeringRepoName(slug);
  } catch (err) {
    // `defaultSteeringRepoName` throws RangeError for a slug the workspace
    // contract refuses. The Name field reports that refusal, so this field
    // waits for a name that makes a slug.
    if (err instanceof RangeError) return "";
    throw err;
  }
}

/** Whether a person may give the steering repo this name. */
export function isRepoNameValid(name: string): boolean {
  return steeringRepoNameInput.safeParse(name).success;
}

/**
 * Whether the form's Repository name input accepts what it holds. The field
 * marks a name the contract would refuse through its own validity, and says
 * why under itself. Only this input is read, so a form's other required
 * fields keep their own refusals.
 */
export function repoNameAccepted(form: HTMLFormElement): boolean {
  const input = form.elements.namedItem(REPO_NAME_FIELD);
  return !(input instanceof HTMLInputElement) || input.validity.valid;
}

/**
 * The `steeringRepo` a form's fields hold, or undefined when they hold
 * nothing: no place picked and no name. An empty name sends no name, so the
 * job takes `oxagen-<slug>`.
 */
export function steeringRepoDraftOf(
  form: FormData,
): SteeringRepoDraft | undefined {
  const rawName = form.get(REPO_NAME_FIELD);
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const rawPlace = form.get(CONNECTION_FIELD);
  const connection =
    typeof rawPlace === "string" ? parseConnectionValue(rawPlace) : null;
  if (name === "" && connection === null) return undefined;
  return {
    ...(name === "" ? {} : { name }),
    ...(connection === null ? {} : { connection }),
  };
}
