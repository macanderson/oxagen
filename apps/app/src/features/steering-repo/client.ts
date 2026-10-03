"use client";

// The steering repo lane's public client entry. A client component in another
// lane imports from here, never from the server barrel: `@/features/steering-repo`
// reaches server-only modules, and a client import of it puts them in the
// browser bundle (INV-21).
//
// The create-workspace forms on onboarding and on the Organization page draw
// the steering repo's Organization and Repository name fields from here
// (#5196). The Organization page's Create a workspace dialog also draws the
// new workspace's provisioning steps from here while the job runs.
export { SteeringRepoDestinationFields } from "./destination-fields";
export {
  defaultRepoName,
  defaultRepoNameForSlug,
  repoNameAccepted,
  steeringRepoDraftOf,
} from "./destination";
export { SteeringRepoProvisioning } from "./provisioning";
export type { SteeringRepoView } from "./types";
