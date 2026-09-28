// The workspace's steering repo, as the repositories card, the health banner,
// and onboarding read it: `get_steering_repo` through the DataSource's
// `steeringRepo` port (data/live/steering-repo.ts), which calls kernelRead on
// the workspace ctx. The port is the only way a render-time read reaches the
// kernel: a feature may call kernelRead only from a "use server" module.
//
// The read answers one SteeringRepoView (./types):
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
// A failed read stays whole, so the card and onboarding can say who was
// denied what, or which code the control plane answered.
import "server-only";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import type { SteeringRepoRead, SteeringRepoView } from "./types";

/** The steering repo of the viewer's workspace. */
export async function readSteeringRepo(
  source: DataSource,
  ctx: WsCtx,
): Promise<SteeringRepoRead> {
  const read = await source.steeringRepo.get(ctx);
  if (!read.ok) return { kind: "failed", failure: read };
  const view: SteeringRepoView = read.value;
  return { kind: "ok", view };
}
