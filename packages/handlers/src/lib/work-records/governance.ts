// governance.ts: the workspace governance mode a send's duty check reads
// (P1-04, ADR-250).
//
// In a regulated workspace the person who approved a brief cannot send it
// (`checkSendDuties` in @oxagen/work/records). The mode lives in the
// workspace's steering repository, in steering/governance.toml, and
// `readSteeringLayout` is the one reader of it.
//
// It fails closed. A workspace with no steering repository has no governance
// mode, and the send goes ahead under no duty but the operator rule. A
// workspace whose repository is bound but cannot be read is refused: the mode
// might be regulated, and a send that skipped the rule could not be undone.
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { type GovernanceMode, WorkRecordError } from "@oxagen/work/records";
import { steeringDeps } from "../../context.steering.deps";
import type { SteeringHost } from "../../context.steering.github";
import { readSteeringLayout } from "../../steering-repo/merge-queue";
import type { WorkScope } from "./store";

const UNREADABLE =
  "Oxagen could not read this workspace's governance mode from its steering repository, so it cannot tell who may send. Try again, or fix steering/governance.toml.";

/** The workspace's governance mode, or null when it has no steering repository. */
export async function readWorkGovernanceMode(scope: WorkScope, host: SteeringHost = steeringDeps().github): Promise<GovernanceMode> {
  let repo: Awaited<ReturnType<SteeringHost["resolveRepository"]>>;
  try {
    repo = await host.resolveRepository(scope);
  } catch (error) {
    if (isHandlerError(error) && error.reason === "workspace_repository_missing") return null;
    throw new WorkRecordError("not_allowed", UNREADABLE);
  }
  try {
    return (await readSteeringLayout(host, repo)).mode;
  } catch {
    throw new WorkRecordError("not_allowed", UNREADABLE);
  }
}
