// kill-switch-guard.ts — a delete may not dismantle a kill switch (ADR-071).
//
// `set_kill_switch` binds a connection, a tool server and a tool version to an
// INTERNAL uuid: the deny is a digest over `mcp.credentials.id` or
// `mcp.mcp_servers.id`, or a capability deny over `mcp.<server uuid>.<name>`.
// Both rows are hard-deleted by ordinary workspace actions — "Remove
// authentication" (`revoke_plugin_credential`) and plugin uninstall — and
// re-creating either mints a fresh `uuid_generate_v7()`. The switch then
// matches nothing while `list_kill_switches` still reports it on and names the
// stale id: the control is gone and the operator has no signal.
//
// So the delete asks first. While a switch names what is about to be deleted,
// the delete is refused as a `conflict` naming the switch, and turning the
// switch off is the only way through. ADR-071 records why that is the honest
// behaviour rather than re-keying the digest onto something stable.

import type { Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  readActiveKillSwitchesForTargets,
  type KillSwitchTargetKind,
} from "./kill-switch";

/**
 * Refuse while a kill switch that is on names any of `targets`. `targets`
 * carry public ids, which is what `iam.emergency_denies.target_id` holds.
 * Runs in the caller's transaction so the check and the delete are atomic.
 */
export async function assertNoActiveKillSwitch(
  tx: Tx,
  args: {
    orgId: string;
    targets: readonly { kind: KillSwitchTargetKind; id: string }[];
    /** What the caller was about to do, for the message. */
    action: string;
  },
): Promise<void> {
  const held = await readActiveKillSwitchesForTargets(tx, {
    orgId: args.orgId,
    targets: args.targets,
  });
  const hit = held[0];
  if (hit === undefined) return;
  throw new HandlerError({
    code: "conflict",
    reason: "kill_switch_on",
    message:
      `${args.action} is refused while kill switch ${hit.publicId} is on ` +
      `for ${hit.targetKind} ${hit.targetId}. Turn the switch off first ` +
      `(set_kill_switch with on: false); deleting its target would leave the ` +
      `switch reporting on while stopping nothing.`,
  });
}
