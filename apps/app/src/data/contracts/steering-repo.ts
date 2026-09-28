// The steering repo's view model (steering-repo-spec, Provisioning and
// Settings drift; lane S2, #4560): what `get_steering_repo` answers for the
// Repositories card, the health banner the workspace layout mounts, and
// onboarding's first workspace step.
//
// This names the contract's own output rather than copying it or parsing it
// again. The contract was written for these surfaces and answers in exactly
// the shape they show, and the kernel parses every answer against the
// contract's output schema before the port sees it. A schema here could never
// refuse a record, for the reason repository.ts gives. The app's own name for
// the record is `SteeringRepoView` in features/steering-repo/types.ts.
// features/steering-repo/read.ts assigns this record to it, so a contract that
// drifts from the view fails to compile there.
import type { SteeringRepoGetOutput } from "@oxagen/oxagen/contracts/steering_repo.get";

/** The workspace's steering repo: its provisioning, its repository, its published version, and its health. */
export type SteeringRepo = SteeringRepoGetOutput;
