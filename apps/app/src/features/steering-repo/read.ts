// The workspace's steering repo, as the repositories card, the health banner,
// and onboarding read it. No capability answers it yet, so the read makes no
// kernel call: an unregistered name reports to error tracking on every page
// view. It answers `not_backed` and names the capability instead.
//
// `get_steering_repo` takes `{}` in the workspace scope and returns one
// SteeringRepoView (./types):
//   status            "provisioning" | "ready" | "failed" | "blocked"
//   step              the last provisioning step that finished, or null
//   failedStep        the step that failed or stopped, or null
//   error             { code, message } or null; `steering_reauthorize` asks
//                     an owner to authorize Oxagen Steering again
//   provider          "github" | "gitlab" | null
//   repository        { fullName, url } or null before create_repository
//   publishedVersion  the published version, or null
//   health            "healthy" | "drifted" | "disconnected" | "diverged" | null
//   differences       [{ setting, expected, actual, changedBy, changedAt }]
//
// Lane S1 owns the provisioning and settings state (status through
// publishedVersion). Lane S2 owns health and differences.
import "server-only";
import type { WsCtx } from "@/server/viewer";
import type { SteeringRepoRead } from "./types";

const STEERING_REPO_CAPABILITY = "get_steering_repo";

/** The steering repo of the viewer's workspace. It stays a promise so callers keep their shape once the capability exists. */
export function readSteeringRepo(_ctx: WsCtx): Promise<SteeringRepoRead> {
  return Promise.resolve({
    kind: "not_backed",
    capability: STEERING_REPO_CAPABILITY,
  });
}
