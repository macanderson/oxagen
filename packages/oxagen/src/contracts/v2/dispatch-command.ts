import { defineTool } from "./_define";
import { tachoCommandDispatch as live } from "../tacho.command.dispatch";

/**
 * Appendix E: `dispatch_command` — "pause, resume, steer, cancel, revoke".
 * Absorbs `dispatch_tacho_command`.
 *
 * This tool is live: issue #2953 registered it in place, in
 * ../tacho.command.dispatch.ts, under its Appendix E name, and the v1
 * `dispatch_tacho_command` no longer exists. The descriptor composes from the
 * live contract so the carry checks in this directory keep reading one
 * schema, and it is not registered a second time.
 *
 * What changed from the absorbed contract, each declared:
 *
 * 1. **The target is a run, an agent or the workspace, never a host.** §7.6
 *    addresses a run id, `@<agent-slug>` or `@agents`; the host is where a
 *    command is delivered, resolved from the run. Host-level `revoke` is
 *    `revoke_enrollment`'s job (it queues the host command itself), and
 *    `refresh_bundle` is redundant with the etag on every control envelope.
 * 2. **`steer` exists and `kill` does not.** §7.4 folds process termination
 *    into `cancel` (SIGTERM where the collector owns the process). Appendix
 *    A.6's `kill_switch_on`/`kill_switch_off` belong to `set_kill_switch`.
 * 3. **A delivery mode on the commands that carry prompt content** (§7.3),
 *    requested on the input and recorded beside the mode achieved.
 * 4. **The output is one id per recipient**, and the status lives on the
 *    delivery report (`list_commands`) in §7.4's nine-word vocabulary.
 */
export const dispatchCommand = defineTool({
  name: live.name,
  domain: live.domain,
  description: live.description,
  mode: live.mode,
  surfaces: live.surfaces,
  layers: live.layers,
  scoped: live.scoped,
  noBillingGate: live.noBillingGate,

  absorbs: ["dispatch_tacho_command"],
  carriedInPlace: [
    {
      name: "dispatch_tacho_command",
      why: "the contract was rewritten in place in ../tacho.command.dispatch.ts under its Appendix E name; the v1 name no longer registers anywhere. This descriptor takes `input: live.input` from that same contract, so there is no v1 shape to diff against.",
    },
  ],
  renames: [
    {
      from: "sessionUuid",
      source: "dispatch_tacho_command",
      to: "target",
      why: "§3's locked vocabulary — *session* survives only as the harness's synonym for a run. The run is named by its public id under `target: { kind: 'run', id }`, the same id `list_runs` reports.",
    },
    {
      from: "expiresInS",
      source: "dispatch_tacho_command",
      to: "expiresInMs",
      why: "milliseconds, the unit every other duration in the app's contracts carries; same 10 s to 24 h bounds and one-hour default.",
    },
  ],
  drops: [
    {
      field: "hostEnrollmentId",
      from: "dispatch_tacho_command",
      why: "a command is addressed to a run, an agent or the workspace (§7.6); the host that carries it is resolved from the run's session row, so the caller never names one.",
    },
    {
      field: 'command: "kill"',
      from: "dispatch_tacho_command",
      why: "§7.4 folds process kill into `cancel` (SIGTERM where the collector owns the process, best effort and recorded).",
    },
    {
      field: 'command: "revoke"',
      from: "dispatch_tacho_command",
      why: "host revocation is `revoke_enrollment`'s job; it retires the key, flips the host status and queues the host-level `revoke` itself.",
    },
    {
      field: 'command: "refresh_bundle"',
      from: "dispatch_tacho_command",
      why: "every control envelope carries the bundle etag and a host refetches on mismatch; a command to do the same adds nothing.",
    },
    {
      field: "outcome (output)",
      from: "dispatch_tacho_command",
      why: "replaced by `commandIds` (one per recipient run); the status is read from `list_commands` in §7.4's closed vocabulary, so a broadcast's report is a list of runs rather than one word.",
    },
    {
      field: "issuedAt (output)",
      from: "dispatch_tacho_command",
      why: "on the delivery report (`list_commands`), which every caller reads next.",
    },
    {
      field: "expiresAt (output)",
      from: "dispatch_tacho_command",
      why: "on the delivery report (`list_commands`), which every caller reads next.",
    },
  ],

  agent: live.agent,
  sensitivity: live.sensitivity,
  defaultEffect: live.defaultEffect,
  defaultRoles: live.defaultRoles,
  mutates: live.mutates,
  input: live.input,
  output: live.output,
});

export type {
  DispatchCommandInput,
  DispatchCommandOutput,
} from "../tacho.command.dispatch";
